package main

// =============================================================================
// The phone's new photos and videos, uploaded by the Android app.
// =============================================================================
//
// Once a day, on Wi-Fi, the app sends what the camera took since the switch in
// Mi cuenta › phones was turned on (deviceRow.Media). Nothing is ever deleted
// on the phone. The plan: docs/phone-media-upload-plan.md.
//
//	POST /api/device/media/start          {id, name, size, taken, mime?, lat?, lon?}
//	                                      -> {upload, offset} | {done: true}
//	PUT  /api/device/media/<upload>?offset=N   raw bytes, appended -> {offset}
//	POST /api/device/media/<upload>/end   -> {path}
//
// `id` is the phone's own name for the file (MediaStore's), `taken` is when it
// was taken in UNIX milliseconds, `size` its bytes.
//
// RESUMABLE. A video of 2 GB must survive a dropped Wi-Fi or the job's ten
// minutes. The bytes go to <home>/data/.upload/<upload>.part - inside the
// owner's home, so the quota counts them - and the upload's name is made from
// the phone and its id, so asking `start` again for the same file finds the
// same part and answers how far it got. Parts nobody touched for a week go.
//
// THE SERVER PICKS THE FOLDER (mediaFolder): the photo folder of the trip the
// picture was taken on - by its day, on the clock of where the trip was that
// day; two trips that day: the one nearest the picture's GPS - else the phone's
// default folder, one sub-folder per year.
//
// NEVER TWICE. The phone row keeps the ids it already filed (MediaDone): a
// retry whose answer was lost answers {done: true}. A different file with a
// name already in the folder gets " (2)", like Drive's own.
//
// After filing, the same as a Drive upload: a JPEG may place its owner on a
// trip (photo_position.go), and a video browsers cannot play is queued for
// conversion (convert.go).

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	mediaChunkMax   = 16 << 20 // bytes in one PUT
	mediaSizeMax    = 64 << 30 // one file
	mediaDoneMax    = 1000     // phone ids each phone row remembers
	mediaPhoneIDMax = 100
	mediaNameMax    = 200 // runes
	mediaDefaultDir = "files/Camera"
	mediaPartDir    = ".upload" // under data/
)

// mediaFileMu: one free-name pick and rename at a time (fileMediaPart).
var mediaFileMu sync.Mutex

// mediaPartTTL: a part nobody touched for this long is thrown away. A var for the tests.
var mediaPartTTL = 7 * 24 * time.Hour

// mediaPart is <upload>.json, beside its .part: what `start` was told.
type mediaPart struct {
	Device string   `json:"device"`
	Phone  string   `json:"phone"`
	Name   string   `json:"name"`
	Size   int64    `json:"size"`
	Taken  int64    `json:"taken"` // ms
	Mime   string   `json:"mime,omitempty"`
	Lat    *float64 `json:"lat,omitempty"`
	Lon    *float64 `json:"lon,omitempty"`
}

// mediaDirOf is the folder a phone files into when no trip takes the picture.
func mediaDirOf(r *deviceRow) string {
	if r.MediaDir != "" {
		return r.MediaDir
	}
	return mediaDefaultDir
}

// mediaUploadID is the same for the same file of the same phone, so a second
// `start` finds the first one's bytes.
func mediaUploadID(device, phoneID string) string {
	sum := sha256.Sum256([]byte(device + "\x00" + phoneID))
	return hex.EncodeToString(sum[:12])
}

func validUploadID(id string) bool {
	if len(id) != 24 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// cleanMediaName is the name a file is filed under: its last segment, no
// control characters, never hidden, never empty.
func cleanMediaName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(strings.TrimSpace(name))
	var b strings.Builder
	n := 0
	for _, r := range name {
		if unicode.IsControl(r) || r == '/' {
			continue
		}
		if n++; n > mediaNameMax {
			break
		}
		b.WriteRune(r)
	}
	name = strings.TrimLeft(strings.TrimSpace(b.String()), ".")
	if name == "" {
		return "foto"
	}
	return name
}

// -----------------------------------------------------------------------------
// the folder
// -----------------------------------------------------------------------------

// mediaFolder is the photo folder of the trip a picture was taken on, or ""
// when none takes it.
//
//  1. the trips whose days hold the picture's day - on the clock of the stage
//     that day (its tz), else the owner's (photoTime's rule);
//  2. only those with a photo folder;
//  3. more than one: the one with a stage nearest the picture's GPS; no GPS,
//     or no stage with a place: the first (the earliest to start).
func mediaFolder(trips []publicTripFile, taken time.Time, lat, lon *float64, ownerLoc *time.Location) string {
	if ownerLoc == nil {
		ownerLoc = time.Local
	}
	var hits []publicTripFile
	for _, t := range trips {
		if publicPhotoDir(t.PhotosDir) != nil && tripHolds(t, taken, ownerLoc) {
			hits = append(hits, t)
		}
	}
	if len(hits) == 0 {
		return ""
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].StartDate < hits[j].StartDate })
	best := hits[0]
	if lat != nil && lon != nil && validLatLon(*lat, *lon) && len(hits) > 1 {
		bestKm := math.Inf(1)
		for _, t := range hits {
			for _, st := range t.Stages {
				if st.Lat == nil || st.Lon == nil {
					continue
				}
				if km := greatCircleKm(*lat, *lon, *st.Lat, *st.Lon); km < bestKm {
					bestKm, best = km, t
				}
			}
		}
	}
	return strings.Join(publicPhotoDir(best.PhotosDir), "/")
}

// tripHolds: the picture's day falls inside the trip. A stage decides on its
// own clock; when no stage holds the day, the trip's own dates do, on the
// clock of its first stage that has one, else the owner's.
func tripHolds(t publicTripFile, taken time.Time, ownerLoc *time.Location) bool {
	var tripLoc *time.Location
	for _, st := range t.Stages {
		loc := ownerLoc
		if st.Tz != "" {
			if l, err := time.LoadLocation(st.Tz); err == nil {
				loc = l
				if tripLoc == nil {
					tripLoc = l
				}
			}
		}
		if dayWithin(taken.In(loc).Format("2006-01-02"), st.StartDate, st.EndDate) {
			return true
		}
	}
	if tripLoc == nil {
		tripLoc = ownerLoc
	}
	return dayWithin(taken.In(tripLoc).Format("2006-01-02"), t.StartDate, t.EndDate)
}

// dayWithin: start <= day <= end; no end means the start day alone.
func dayWithin(day, start, end string) bool {
	if start == "" {
		return false
	}
	if end == "" {
		end = start
	}
	return start <= day && day <= end
}

// greatCircleKm is the distance between two points, in km.
func greatCircleKm(lat1, lon1, lat2, lon2 float64) float64 {
	const r = 6371.0
	p1, p2 := lat1*math.Pi/180, lat2*math.Pi/180
	dp, dl := p2-p1, (lon2-lon1)*math.Pi/180
	a := math.Sin(dp/2)*math.Sin(dp/2) + math.Cos(p1)*math.Cos(p2)*math.Sin(dl/2)*math.Sin(dl/2)
	return 2 * r * math.Asin(math.Min(1, math.Sqrt(a)))
}

// mediaFolderFor is where this picture of this phone goes, as "files/...".
func (s *Server) mediaFolderFor(dev *deviceRow, p mediaPart) string {
	ownerLoc := Location(s.users.UserTZ("user", dev.Owner))
	taken := time.UnixMilli(p.Taken)
	var trips []publicTripFile
	for _, lt := range s.ownTrips(dev.Owner) {
		trips = append(trips, lt.trip)
	}
	if dir := mediaFolder(trips, taken, p.Lat, p.Lon, ownerLoc); dir != "" {
		return dir
	}
	return s.mediaOwnFolder(dev, p)
}

// mediaOwnFolder is the phone's own folder for the year the picture was taken,
// on its owner's clock.
func (s *Server) mediaOwnFolder(dev *deviceRow, p mediaPart) string {
	loc := Location(s.users.UserTZ("user", dev.Owner))
	if loc == nil {
		loc = time.Local
	}
	return mediaDirOf(dev) + "/" + strconv.Itoa(time.UnixMilli(p.Taken).In(loc).Year())
}

// -----------------------------------------------------------------------------
// the routes
// -----------------------------------------------------------------------------

// deviceMedia is /api/device/media/<rest>, for the phone holding `dev`.
func (s *Server) deviceMedia(w http.ResponseWriter, r *http.Request, dev *deviceRow, rest string) {
	parts := strings.Split(rest, "/")
	switch {
	case rest == "start" && r.Method == http.MethodPost:
		s.mediaStart(w, r, dev)
	case len(parts) == 1 && validUploadID(parts[0]) && r.Method == http.MethodPut:
		s.mediaChunk(w, r, dev, parts[0])
	case len(parts) == 2 && validUploadID(parts[0]) && parts[1] == "end" && r.Method == http.MethodPost:
		s.mediaEnd(w, r, dev, parts[0])
	default:
		sendError(w, r, http.StatusNotFound, "no such endpoint")
	}
}

// mediaHome is the owner's home as a sandbox root, and the part's two names in it.
func (s *Server) mediaHome(owner, upload string) (Resolved, string, string, bool) {
	home, ok := s.users.Resolve("user", owner, "data/"+mediaPartDir+"/"+upload+".part")
	if !ok {
		return Resolved{}, "", "", false
	}
	dir := filepath.Join("data", mediaPartDir)
	return home, filepath.Join(dir, upload+".part"), filepath.Join(dir, upload+".json"), true
}

func readMediaPart(root *os.Root, rel string) (mediaPart, bool) {
	var p mediaPart
	f, err := root.Open(rel)
	if err != nil {
		return p, false
	}
	defer f.Close()
	if json.NewDecoder(io.LimitReader(f, 64<<10)).Decode(&p) != nil {
		return p, false
	}
	return p, true
}

func writeMediaPart(root *os.Root, rel string, p mediaPart) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	f, err := root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(raw)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// mediaBudget is how many more bytes `owner` may store; -1 = no quota.
func (s *Server) mediaBudget(owner string) int64 {
	q := s.users.UserQuotaBytes(owner)
	if q == nil {
		return -1
	}
	return max(0, *q-s.users.UserUsageBytes(owner))
}

// sweepMediaParts throws away `owner`'s parts nobody touched for mediaPartTTL:
// a file deleted on the phone halfway, a phone revoked mid-video.
func (s *Server) sweepMediaParts(owner string, root *os.Root) {
	dir := filepath.Join("data", mediaPartDir)
	f, err := root.Open(dir)
	if err != nil {
		return
	}
	entries, _ := f.ReadDir(-1)
	f.Close()
	cutoff := time.Now().Add(-mediaPartTTL)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() || info.ModTime().After(cutoff) {
			continue
		}
		if root.Remove(filepath.Join(dir, e.Name())) == nil && strings.HasSuffix(e.Name(), ".part") {
			s.users.AdjustUsage(owner, -info.Size())
		}
	}
}

func (s *Server) mediaStart(w http.ResponseWriter, r *http.Request, dev *deviceRow) {
	var body struct {
		ID    string   `json:"id"`
		Name  string   `json:"name"`
		Size  int64    `json:"size"`
		Taken int64    `json:"taken"`
		Mime  string   `json:"mime"`
		Lat   *float64 `json:"lat"`
		Lon   *float64 `json:"lon"`
	}
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}
	if dev.Media == 0 {
		sendError(w, r, http.StatusForbidden, "la subida de fotos está apagada para este móvil")
		return
	}
	if body.ID == "" || len(body.ID) > mediaPhoneIDMax || strings.ContainsFunc(body.ID, unicode.IsControl) {
		sendError(w, r, http.StatusBadRequest, "id no válido")
		return
	}
	if body.Size <= 0 || body.Size > mediaSizeMax {
		sendError(w, r, http.StatusBadRequest, "tamaño no válido")
		return
	}
	if s.devices.mediaFiled(dev.ID, body.ID) {
		sendJSON(w, r, http.StatusOK, map[string]any{"done": true})
		return
	}
	if body.Taken <= 0 || time.UnixMilli(body.Taken).After(time.Now().Add(48*time.Hour)) {
		body.Taken = time.Now().UnixMilli()
	}
	if body.Lat == nil || body.Lon == nil || !validLatLon(*body.Lat, *body.Lon) {
		body.Lat, body.Lon = nil, nil
	}
	if len(body.Mime) > 100 {
		body.Mime = ""
	}

	upload := mediaUploadID(dev.ID, body.ID)
	home, partRel, metaRel, ok := s.mediaHome(dev.Owner, upload)
	if !ok {
		sendError(w, r, http.StatusInternalServerError, "no hay carpeta de usuario")
		return
	}
	root, err := home.openCreating()
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear la carpeta")
		return
	}
	defer root.Close()
	s.sweepMediaParts(dev.Owner, root)
	if err := root.MkdirAll(filepath.Dir(partRel), 0o700); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear la carpeta")
		return
	}

	unlock := lockPath(home.Abs)
	defer unlock()
	want := mediaPart{Device: dev.ID, Phone: body.ID, Name: cleanMediaName(body.Name), Size: body.Size,
		Taken: body.Taken, Mime: body.Mime, Lat: body.Lat, Lon: body.Lon}
	var offset int64
	if had, ok := readMediaPart(root, metaRel); ok && had.Size == want.Size && had.Phone == want.Phone {
		if info, err := root.Stat(partRel); err == nil && info.Size() <= want.Size {
			offset = info.Size()
		}
	}
	if offset == 0 {
		if info, err := root.Stat(partRel); err == nil {
			s.users.AdjustUsage(dev.Owner, -info.Size())
		}
		f, err := root.OpenFile(partRel, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
			return
		}
		f.Close()
	}
	// Written every time: the part's json is also its "touched" time for the sweep.
	if err := writeMediaPart(root, metaRel, want); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return
	}
	if b := s.mediaBudget(dev.Owner); b >= 0 && body.Size-offset > b {
		sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
		return
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"upload": upload, "offset": offset})
}

func (s *Server) mediaChunk(w http.ResponseWriter, r *http.Request, dev *deviceRow, upload string) {
	if r.ContentLength <= 0 || r.ContentLength > mediaChunkMax {
		w.Header().Set("Connection", "close")
		sendError(w, r, http.StatusBadRequest, "falta Content-Length, o es demasiado")
		return
	}
	offset, err := strconv.ParseInt(queryValue(r, "offset"), 10, 64)
	if err != nil || offset < 0 {
		sendError(w, r, http.StatusBadRequest, "offset no válido")
		return
	}
	home, partRel, metaRel, ok := s.mediaHome(dev.Owner, upload)
	if !ok {
		sendError(w, r, http.StatusNotFound, "esa subida no existe")
		return
	}
	root, err := home.open()
	if err != nil {
		sendError(w, r, http.StatusNotFound, "esa subida no existe")
		return
	}
	defer root.Close()

	// check is the part as it stands: 0 and an answer already sent when this
	// chunk does not fit it.
	check := func() bool {
		p, ok := readMediaPart(root, metaRel)
		info, err := root.Stat(partRel)
		if !ok || err != nil || p.Device != dev.ID {
			w.Header().Set("Connection", "close") // the body may be unread
			sendError(w, r, http.StatusNotFound, "esa subida no existe")
			return false
		}
		if cur := info.Size(); cur != offset {
			w.Header().Set("Connection", "close")
			sendJSON(w, r, http.StatusConflict, map[string]any{"error": "offset distinto", "offset": cur})
			return false
		}
		if offset+r.ContentLength > p.Size {
			w.Header().Set("Connection", "close")
			sendError(w, r, http.StatusBadRequest, "más bytes que el archivo")
			return false
		}
		return true
	}
	unlock := lockPath(home.Abs)
	ok = check()
	unlock()
	if !ok {
		return
	}
	if b := s.mediaBudget(dev.Owner); b >= 0 && r.ContentLength > b {
		w.Header().Set("Connection", "close")
		sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
		return
	}

	// The body goes to a temp of its own, with NO lock held: a phone that lost
	// its Wi-Fi mid-chunk leaves a request the server only gives up on minutes
	// later (bodyDeadline), and its retry must not wait for it. Only a whole
	// chunk is appended, under the lock, and only if the part is still where
	// it was - so the part never holds half a chunk.
	tmp, tmpRel, err := createTempNamed(root, filepath.Dir(partRel), upload+".chunk-")
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return
	}
	defer func() {
		tmp.Close()
		root.Remove(tmpRel)
	}()
	n, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, r.ContentLength))
	if err == nil && n != r.ContentLength {
		err = errors.New("short body")
	}
	if err != nil {
		w.Header().Set("Connection", "close")
		sendError(w, r, http.StatusBadRequest, "subida incompleta (conexión interrumpida)")
		return
	}

	unlock = lockPath(home.Abs)
	defer unlock()
	if !check() {
		return
	}
	f, err := root.OpenFile(partRel, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return
	}
	_, err = tmp.Seek(0, io.SeekStart)
	if err == nil {
		_, err = io.Copy(f, tmp)
	}
	if err != nil {
		f.Truncate(offset) // never half a chunk
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return
	}
	s.users.AdjustUsage(dev.Owner, n)
	sendJSON(w, r, http.StatusOK, map[string]any{"offset": offset + n})
}

func (s *Server) mediaEnd(w http.ResponseWriter, r *http.Request, dev *deviceRow, upload string) {
	home, partRel, metaRel, ok := s.mediaHome(dev.Owner, upload)
	if !ok {
		sendError(w, r, http.StatusNotFound, "esa subida no existe")
		return
	}
	root, err := home.open()
	if err != nil {
		sendError(w, r, http.StatusNotFound, "esa subida no existe")
		return
	}
	defer root.Close()

	// The part's bytes to disk BEFORE the lock: a whole video's fsync takes
	// seconds, and the bin waits on this stripe for any file that shares it,
	// holding every user's bin meanwhile (Trash.MoveIn). fileMediaPart syncs
	// again under the lock - by then a no-op. Best effort: a part that is
	// not there is answered below.
	if f, err := root.OpenFile(partRel, os.O_WRONLY, 0); err == nil {
		f.Sync()
		f.Close()
	}

	// Gone (a second "end" whose first answer was lost): 404, and the phone
	// asks `start` again, which knows it was filed.
	unlock := lockPath(home.Abs)
	p, ok := readMediaPart(root, metaRel)
	info, err := root.Stat(partRel)
	if !ok || err != nil || p.Device != dev.ID {
		unlock()
		sendError(w, r, http.StatusNotFound, "esa subida no existe")
		return
	}
	if info.Size() != p.Size {
		unlock()
		sendJSON(w, r, http.StatusConflict, map[string]any{"error": "faltan bytes", "offset": info.Size()})
		return
	}

	folder := s.mediaFolderFor(dev, p)
	rel, err := fileMediaPart(root, partRel, folder, p.Name)
	if err != nil && !strings.HasPrefix(folder, mediaDirOf(dev)+"/") {
		// A trip folder that cannot be made (a file has its name): the phone's
		// own folder, rather than an error the phone would retry every day.
		s.log.Warn("trip photo folder unusable", "owner", dev.Owner, "folder", folder, "err", err)
		rel, err = fileMediaPart(root, partRel, s.mediaOwnFolder(dev, p), p.Name)
	}
	if err != nil {
		unlock()
		s.log.Error("filing a phone's picture failed", "owner", dev.Owner, "err", err)
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
		return
	}
	root.Remove(metaRel)
	s.devices.noteMediaFiled(dev.ID, p.Phone)
	unlock()
	s.log.Info("phone picture filed", "owner", dev.Owner, "path", rel, "bytes", p.Size)
	sendJSON(w, r, http.StatusOK, map[string]any{"path": rel})

	// The same as a Drive upload, after the answer.
	target, ok := s.users.Resolve("user", dev.Owner, rel)
	if !ok {
		return
	}
	if isJPEGName(rel) {
		go s.photoUploaded(dev.Owner, rel, target)
	}
	if IsConvertible(rel) {
		s.convert.Enqueue(dev.Owner, rel)
	}
}

// fileMediaPart moves the finished part into `folder` under `name`, or
// "name (2).ext"... when that is taken, and answers its home-relative path.
func fileMediaPart(root *os.Root, partRel, folder, name string) (string, error) {
	if err := root.MkdirAll(filepath.FromSlash(folder), 0o755); err != nil {
		return "", err
	}
	f, err := root.OpenFile(partRel, os.O_WRONLY, 0)
	if err != nil {
		return "", err
	}
	err = f.Sync() // on disk before it takes its name (upload.go's rule)
	if err == nil {
		err = f.Chmod(0o644)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}

	ext := path.Ext(name)
	base := strings.TrimSuffix(name, ext)
	// A rename replaces what is there: two phones filing "IMG_1.jpg" into one
	// folder at once must not both find the name free. Its own lock, never a
	// lockPath stripe - the caller already holds one, and two stripes can be one.
	// The lock stops other phones only, not a Drive upload or move of that name
	// in the instant between the look and the move (D10): renameNoReplace
	// refuses a name taken then, and the next one is tried.
	mediaFileMu.Lock()
	defer mediaFileMu.Unlock()
	for i := 1; i < 10000; i++ {
		cand := name
		if i > 1 {
			cand = base + " (" + strconv.Itoa(i) + ")" + ext
		}
		rel := folder + "/" + cand
		if _, err := root.Lstat(filepath.FromSlash(rel)); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return "", err
		}
		if err := renameNoReplace(root, partRel, filepath.FromSlash(rel)); errors.Is(err, fs.ErrExist) {
			continue
		} else if err != nil && !errors.Is(err, errSourceLeft) { // errSourceLeft: filed, the part's name stayed
			return "", err
		}
		// Durable before the phone is told "filed" and may let it go (K1).
		if err := syncRootDir(root, filepath.FromSlash(folder)); err != nil {
			return "", err
		}
		return rel, nil
	}
	return "", errors.New("no free name")
}
