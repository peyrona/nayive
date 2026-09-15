package main

// =============================================================================
// Public trip links - what a stranger holding the link may see, and no more.
// =============================================================================
//
// One trip, one link: /s/<token>. No account, no cookie. The page behind it
// (apps/trips/public.html) reads everything from two routes:
//
//	GET /api/public/<token>                    -> the trip, as publicTrip below
//	GET /api/public/<token>/photo/<file name>  -> one photo, its GPS removed
//	GET /api/public/<token>/thumb/<file name>  -> that photo's thumbnail
//
// The visitor never sends a PATH. The token picks the trip, the trip's own
// photosDir picks the folder, and all a request may name is a plain image file
// name directly inside that folder - so there is nothing to traverse.
//
// What goes out is trimmed on purpose:
//   - only stages that have STARTED by today (the owner's clock). Future ones
//     would tell a stranger when the house is empty;
//   - every coordinate rounded to 3 decimals, about 100 m (roundCoord);
//   - no documents, notes, accommodation, and not the owner's login name;
//   - "where I am now" only between the trip's first and last day;
//   - full JPEGs lose their GPS on the way out (exifstrip.go).
//
// GET and HEAD only, and Cache-Control: no-cache, so a stopped link stops at the
// next load rather than whenever some cache expires.

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// publicPagePath is the page every link opens, under apps/.
const publicPagePath = "trips/public.html"

// positionFresh: a position (phone, photo or OwnTracks) younger than this is
// "where I am now"; older, and the trip plan answers instead.
const positionFresh = 12 * time.Hour

// publicImageExt are the pictures a link lends - the raster types Photos shows.
// NOT svg: an SVG is a document that can run script on this origin.
var publicImageExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true,
	".webp": true, ".bmp": true, ".avif": true,
}

// -----------------------------------------------------------------------------
// what is read, and what is sent
// -----------------------------------------------------------------------------

// publicTripFile is the part of trip.json a public link may read at all.
type publicTripFile struct {
	Destination string            `json:"destination"`
	StartDate   string            `json:"startDate"`
	EndDate     string            `json:"endDate"`
	PhotosDir   string            `json:"photosDir"`
	Stages      []publicTripStage `json:"stages"`
	Track       *bool             `json:"track"` // Trips' "save where I am"; missing means on (positions.go)
}

type publicTripStage struct {
	Location  string   `json:"location"`
	StartDate string   `json:"startDate"`
	StartTime string   `json:"startTime"`
	EndDate   string   `json:"endDate"`
	Lat       *float64 `json:"lat"`
	Lon       *float64 `json:"lon"`
	Tz        string   `json:"tz"`      // the place's IANA time zone, when Trips found one
	Enabled   *bool    `json:"enabled"` // Trips' eye toggle; missing means on
}

type publicTrip struct {
	Title     string        `json:"title"`
	StartDate string        `json:"startDate"`
	EndDate   string        `json:"endDate"`
	Today     string        `json:"today"`
	Stages    []publicStage `json:"stages"`
	Route     []publicPoint `json:"route"`
	Now       *publicNow    `json:"now"`
	Photos    []publicPhoto `json:"photos"`
}

type publicStage struct {
	Location  string   `json:"location"`
	StartDate string   `json:"startDate"`
	EndDate   string   `json:"endDate"`
	Lat       *float64 `json:"lat,omitempty"`
	Lon       *float64 `json:"lon,omitempty"`
}

// publicPoint is one step of the route: a stage of the plan, or a stored
// position (positions.go).
type publicPoint struct {
	Kind  string  `json:"kind"` // "stage" | "phone" | "photo" | "owntracks"
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	Place string  `json:"place,omitempty"`
	At    int64   `json:"at"` // UNIX seconds
}

type publicNow struct {
	Source string  `json:"source"` // "phone" | "photo" | "owntracks" | "plan"
	Lat    float64 `json:"lat"`
	Lon    float64 `json:"lon"`
	Place  string  `json:"place,omitempty"`
	At     int64   `json:"at,omitempty"` // when the position was taken; not for "plan"
}

type publicPhoto struct {
	Name    string   `json:"name"`
	MTime   int64    `json:"mtime"`        // the page puts it in the URL: a changed photo is a new URL
	TS      int64    `json:"ts,omitempty"` // when it was taken, ms (Photos' EXIF cache)
	Lat     *float64 `json:"lat,omitempty"`
	Lon     *float64 `json:"lon,omitempty"`
	Comment string   `json:"comment,omitempty"`
	Thumb   bool     `json:"thumb"` // a thumbnail exists; otherwise the tile loads the photo
}

// -----------------------------------------------------------------------------
// the routes
// -----------------------------------------------------------------------------

// publicHeaders go on every answer of the public routes.
func publicHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("X-Robots-Tag", "noindex, nofollow")
	h.Set("Referrer-Policy", "no-referrer") // the token must not leak to the map tiles
	h.Set("Cache-Control", "no-cache")
}

// liveLink is the link grant for `token` and its trip folder, or nil when the
// token is unknown or the trip has gone away.
func (s *Server) liveLink(token string) (*Grant, string) {
	g := s.shares.FindToken(token)
	root := s.shares.RootPath(g)
	if root == "" {
		return nil, ""
	}
	info, err := os.Stat(filepath.Join(root, "trip.json"))
	if err != nil || !info.Mode().IsRegular() {
		return nil, ""
	}
	return g, root
}

// publicPage answers /s/<token>: always the same page - it reads the token from
// its own URL. A dead link still gets it, so the visitor reads "no longer
// available" in their language, but with a 404.
func (s *Server) publicPage(w http.ResponseWriter, r *http.Request) {
	publicHeaders(w)
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		sendText(w, r, http.StatusMethodNotAllowed, "Method not allowed.\n")
		return
	}
	info, err := s.static.stat(publicPagePath)
	if err != nil || !info.Mode().IsRegular() {
		sendText(w, r, http.StatusNotFound, "Not found.\n")
		return
	}
	if g, _ := s.liveLink(r.PathValue("token")); g != nil {
		s.static.serve(w, r, publicPagePath, info)
		return
	}
	body, err := s.static.read(publicPagePath)
	if err != nil {
		sendText(w, r, http.StatusNotFound, "Not found.\n")
		return
	}
	sendBytes(w, r, http.StatusNotFound, "text/html; charset=utf-8", body)
}

// publicTarget is the live link behind this request's {token}, or false after
// answering.
func (s *Server) publicTarget(w http.ResponseWriter, r *http.Request) (*Grant, string, bool) {
	publicHeaders(w)
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		sendError(w, r, http.StatusMethodNotAllowed, "use GET")
		return nil, "", false
	}
	g, root := s.liveLink(r.PathValue("token"))
	if g == nil {
		sendError(w, r, http.StatusNotFound, "este enlace ya no está disponible")
		return nil, "", false
	}
	return g, root, true
}

// apiPublic answers GET /api/public/<token>: the trip, trimmed.
func (s *Server) apiPublic(w http.ResponseWriter, r *http.Request) {
	g, root, ok := s.publicTarget(w, r)
	if !ok {
		return
	}
	var trip publicTripFile
	if !loadJSONFile(filepath.Join(root, "trip.json"), &trip) {
		sendError(w, r, http.StatusNotFound, "este enlace ya no está disponible")
		return
	}
	sendJSON(w, r, http.StatusOK, s.buildTripView(g.Owner, g.Title, root, trip, s.ownerNow(g.Owner)))
}

// apiPublicFile answers GET /api/public/<token>/{photo|thumb}/<file name>.
func (s *Server) apiPublicFile(w http.ResponseWriter, r *http.Request) {
	g, root, ok := s.publicTarget(w, r)
	if !ok {
		return
	}
	s.serveTripPhoto(w, r, g.Owner, root)
}

// serveTripPhoto answers {photo|thumb}/<file name> of one trip's photo folder,
// for a link's visitor (above) and for the owner's Journey map (journey.go).
func (s *Server) serveTripPhoto(w http.ResponseWriter, r *http.Request, owner, root string) {
	notFound := func() { sendError(w, r, http.StatusNotFound, "no existe esa foto") }

	kind, name := r.PathValue("kind"), r.PathValue("name")
	if (kind != "photo" && kind != "thumb") || !isPublicImageName(name) {
		notFound()
		return
	}
	var trip publicTripFile
	if !loadJSONFile(filepath.Join(root, "trip.json"), &trip) {
		notFound()
		return
	}
	dir := s.ownerFile(owner, publicPhotoDir(trip.PhotosDir))
	if dir == "" {
		notFound()
		return
	}
	// A plain name, opened INSIDE the photo folder by the kernel (os.Root).
	photo, info, err := openInside(dir, name)
	if err != nil {
		notFound()
		return
	}
	defer photo.Close()

	if kind == "thumb" {
		// The visitor never names the thumbnail: it is worked out from the photo.
		thumbs := s.ownerFile(owner, []string{"data", "photos", "thumbs"})
		if thumbs == "" {
			notFound()
			return
		}
		thumb, tinfo, err := openInside(thumbs, thumbName(info.Size(), info.ModTime().Unix()))
		if err != nil {
			notFound()
			return
		}
		defer thumb.Close()
		serveImage(w, r, thumb, "image/jpeg", tinfo) // made by a canvas: no EXIF in it
		return
	}

	ctype := ContentType(name)
	if ctype != "image/jpeg" {
		serveImage(w, r, photo, ctype, info)
		return
	}
	clean, err := cleanJPEG(filepath.Join(dir, name), photo, info)
	if err != nil {
		// Never send a JPEG whose GPS could not be found and removed.
		s.log.Warn("public photo not served: cannot read its JPEG structure", "err", err)
		notFound()
		return
	}
	serveImage(w, r, clean, ctype, info)
}

// -----------------------------------------------------------------------------
// building the answer
// -----------------------------------------------------------------------------

// ownerNow is the time on the owner's own clock (their timezone setting), so
// "today" is their today, as reminders.go does it.
func (s *Server) ownerNow(owner string) time.Time {
	now := time.Now()
	if loc := Location(s.users.UserTZ("user", owner)); loc != nil {
		now = now.In(loc)
	}
	return now
}

// buildTripView is a trip as a link's visitor sees it - and as its owner's
// Journey map shows it (journey.go): one code path, the same trimming.
// `title` stands in when the trip has no destination.
func (s *Server) buildTripView(owner, title, root string, trip publicTripFile, now time.Time) publicTrip {
	today := now.Format("2006-01-02")
	if dest := strings.TrimSpace(trip.Destination); dest != "" {
		title = dest
	}
	out := publicTrip{
		Title: title, StartDate: trip.StartDate, EndDate: trip.EndDate, Today: today,
		Stages: []publicStage{}, Route: []publicPoint{}, Photos: []publicPhoto{},
	}

	started := startedStages(trip.Stages, today)
	for _, st := range started {
		ps := publicStage{Location: st.Location, StartDate: st.StartDate, EndDate: st.EndDate}
		if lat, lon, ok := roundedPair(st.Lat, st.Lon); ok {
			ps.Lat, ps.Lon = &lat, &lon
			out.Route = append(out.Route, publicPoint{
				Kind: "stage", Lat: lat, Lon: lon, Place: st.Location,
				At: stageEpoch(st, now.Location()),
			})
		}
		out.Stages = append(out.Stages, ps)
	}

	positions := readPositionsDoc(root)
	for _, p := range routeForShow(positions.Positions) {
		out.Route = append(out.Route, publicPoint{
			Kind: sourceOf(p), Lat: roundCoord(p.Lat), Lon: roundCoord(p.Lon), Place: p.Place, At: p.At,
		})
	}
	sort.SliceStable(out.Route, func(i, j int) bool { return out.Route[i].At < out.Route[j].At })

	out.Now = nowFor(trip, started, positions.Latest, now)
	out.Photos = s.publicPhotos(owner, trip.PhotosDir)
	return out
}

// startedStages are the stages switched on whose first day is today or
// earlier, in the order they happen.
func startedStages(stages []publicTripStage, today string) []publicTripStage {
	var out []publicTripStage
	for _, st := range stages {
		if st.Enabled != nil && !*st.Enabled {
			continue
		}
		if st.StartDate == "" || st.StartDate > today {
			continue
		}
		out = append(out, st)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].StartDate+" "+out[i].StartTime < out[j].StartDate+" "+out[j].StartTime
	})
	return out
}

// stageEpoch is when a stage starts, as UNIX seconds on the owner's clock.
func stageEpoch(st publicTripStage, loc *time.Location) int64 {
	clock := st.StartTime
	if clock == "" {
		clock = "00:00"
	}
	t, err := time.ParseInLocation("2006-01-02 15:04", st.StartDate+" "+clock, loc)
	if err != nil {
		if t, err = time.ParseInLocation("2006-01-02", st.StartDate, loc); err != nil {
			return 0
		}
	}
	return t.Unix()
}

// nowFor is "where I am now": the stored latest position while it is fresh,
// else the stage the plan puts today, else nothing - and nothing at all outside
// the trip's own dates.
func nowFor(trip publicTripFile, started []publicTripStage, latest *tripPosition,
	now time.Time) *publicNow {

	today := now.Format("2006-01-02")
	if trip.StartDate == "" || trip.EndDate == "" || today < trip.StartDate || today > trip.EndDate {
		return nil
	}
	if latest != nil && now.Sub(time.Unix(latest.At, 0)) < positionFresh {
		return &publicNow{Source: sourceOf(*latest), Lat: roundCoord(latest.Lat), Lon: roundCoord(latest.Lon),
			Place: latest.Place, At: latest.At}
	}
	for i := len(started) - 1; i >= 0; i-- {
		st := started[i]
		if st.EndDate != "" && st.EndDate < today {
			continue // over already
		}
		if lat, lon, ok := roundedPair(st.Lat, st.Lon); ok {
			return &publicNow{Source: "plan", Lat: lat, Lon: lon, Place: st.Location}
		}
	}
	return nil
}

// publicPhotos are the pictures directly inside the trip's photo folder, with
// what Photos already knows about each: when and where (its EXIF cache), the
// owner's comment, and whether a thumbnail exists. Nothing is computed here -
// a photo Photos never opened simply has no pin and no thumbnail.
func (s *Server) publicPhotos(owner, photosDir string) []publicPhoto {
	out := []publicPhoto{}
	parts := publicPhotoDir(photosDir)
	dir := s.ownerFile(owner, parts)
	if dir == "" {
		return out
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return out
	}

	scan := readJSONMap(s.ownerFile(owner, []string{"data", "photos", "scan-cache.json"}))
	notes := readJSONMap(s.ownerFile(owner, []string{"data", "photos", "comments.json"}))
	thumbs := s.ownerFile(owner, []string{"data", "photos", "thumbs"})

	for _, n := range ListChildren(dir, strings.Join(parts, "/")) {
		if n.Nodes != nil || n.Size == nil || n.MTime == nil {
			continue // a sub-folder: not lent
		}
		name := lastSegment(n.Path)
		if !isPublicImageName(name) {
			continue
		}
		p := publicPhoto{Name: name, MTime: *n.MTime}

		var e struct {
			Size  float64  `json:"size"`
			MTime float64  `json:"mtime"`
			TS    float64  `json:"ts"`
			Lat   *float64 `json:"lat"`
			Lon   *float64 `json:"lon"`
		}
		// The cache entry counts only while it still describes THIS file.
		if raw, ok := scan[n.Path]; ok && json.Unmarshal(raw, &e) == nil &&
			int64(e.Size) == *n.Size && int64(e.MTime) == *n.MTime {
			if e.TS > 0 {
				p.TS = int64(e.TS)
			}
			if lat, lon, ok := roundedPair(e.Lat, e.Lon); ok {
				p.Lat, p.Lon = &lat, &lon
			}
		}
		if raw, ok := notes[n.Path]; ok {
			json.Unmarshal(raw, &p.Comment) // a note that is not a string is simply not shown
		}
		if thumbs != "" {
			info, err := os.Stat(filepath.Join(thumbs, thumbName(*n.Size, *n.MTime)))
			p.Thumb = err == nil && info.Mode().IsRegular()
		}
		out = append(out, p)
	}
	return out
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// ownerFile is <owner's home>/<parts> with every symlink followed, or "" when it
// does not exist or lands outside that home - the containment test
// Shares.RootPath makes.
func (s *Server) ownerFile(owner string, parts []string) string {
	parts = cleanSegments(parts)
	if owner == "" || len(parts) == 0 || hasDotDot(parts) || hasSegment(parts, ".trash") {
		return ""
	}
	home, err := resolveExisting(filepath.Join(s.cfg.HomesDir, owner))
	if err != nil {
		return ""
	}
	target, err := resolveExisting(filepath.Join(append([]string{home}, parts...)...))
	if err != nil || !isInside(home, target) {
		return ""
	}
	if _, err := os.Lstat(target); err != nil {
		return ""
	}
	return target
}

// publicPhotoDir is a trip's photo folder as segments, or nil. Only ever a
// folder INSIDE files/ - never files/ itself, never anything in data/.
func publicPhotoDir(photosDir string) []string {
	parts := splitRef(photosDir)
	if len(parts) < 2 || parts[0] != "files" {
		return nil
	}
	return parts
}

// isPublicImageName: one plain, visible file name with a picture's extension.
func isPublicImageName(name string) bool {
	if name == "" || strings.HasPrefix(name, ".") || strings.ContainsAny(name, "/\\\x00") {
		return false
	}
	return publicImageExt[strings.ToLower(filepath.Ext(name))]
}

// thumbName is the file Photos stores a thumbnail under:
// data/photos/thumbs/<size>_<mtime>.jpg (its thumbKey()).
func thumbName(size, mtime int64) string {
	return itoa64(size) + "_" + itoa64(mtime) + ".jpg"
}

// openInside opens `name` inside `dir` through os.Root - a symlink out of the
// folder fails in the kernel - and only when it is a regular file.
func openInside(dir, name string) (*os.File, os.FileInfo, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, nil, err
	}
	defer root.Close()
	// Stat BEFORE opening: opening a FIFO could block.
	if info, err := root.Stat(name); err != nil || !info.Mode().IsRegular() {
		return nil, nil, os.ErrNotExist
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, nil, os.ErrNotExist
	}
	return file, info, nil
}

// serveImage sends a picture with Range and 304 support.
func serveImage(w http.ResponseWriter, r *http.Request, content io.ReadSeeker, ctype string,
	info os.FileInfo) {
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, "", info.ModTime(), content)
}

// readJSONMap is a JSON object file as raw values, one per key, so one odd
// entry cannot hide all the others. Empty when the path is "" or unreadable.
func readJSONMap(path string) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	if path != "" {
		loadJSONFile(path, &out)
	}
	return out
}

// roundCoord keeps 3 decimals, the precision a link promises: about 110 m
// north-south, and 85 m east-west at the latitude of Spain.
func roundCoord(v float64) float64 { return math.Round(v*1000) / 1000 }

// validLatLon is a real position - and not 0,0, which is what a missing one
// looks like far more often than a trip to the Gulf of Guinea.
func validLatLon(lat, lon float64) bool {
	if math.IsNaN(lat) || math.IsNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return false
	}
	return lat != 0 || lon != 0
}

// roundedPair is a stored lat/lon, rounded, when both are there and valid.
func roundedPair(lat, lon *float64) (float64, float64, bool) {
	if lat == nil || lon == nil || !validLatLon(*lat, *lon) {
		return 0, 0, false
	}
	return roundCoord(*lat), roundCoord(*lon), true
}
