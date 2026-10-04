// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// Location - the owner's position from the background, for their trips.
// =============================================================================
//
// A web page cannot read GPS with the page closed. A location app can, and in
// its HTTP mode it sends every position to a URL of our choosing. Each user may
// have ONE such URL, made in Trips' "My location" sheet:
//
//	/api/location/<key>/<app>
//
// The key is the only credential - a long random string (newToken), like a
// public link's token - so the app needs no user name or password. It lives in
// config/location.json, outside every home, where no file API reaches.
//
//	GET    /api/location        (session) -> {"url", "created"}, or {} when off
//	POST   /api/location        (session) -> make the URL (or hand back the one there is)
//	DELETE /api/location        (session) -> turn it off: the URL stops working
//
//	POST /api/location/<key>/gpslogger            (the app) -> one position
//	GET  /api/location/<key>/gpslogger.properties (the app) -> its settings, ready made
//	POST /api/location/<key>/overland             (the app) -> a batch of positions
//
// Two apps, neither ours, both free and open source. Each speaks its own way and
// wants its own answer, so each gets its own ending on the same key:
//
//	GPSLogger (Android)  sends what we tell it to. The .properties file below is
//	                     its whole setup, so the body is ours to choose:
//	                     {"lat":..,"lon":..,"acc":..,"tst":..}. Any 2xx is "got it".
//	Overland (iPhone)    sends its own GeoJSON batch (up to 1000 points, 200 by
//	                     default) and RESENDS it until the answer is exactly
//	                     {"result":"ok"}.
//
// Until 2026-09-16 this was OwnTracks (/api/owntracks, config/owntracks.json).
// The old file is read once and written back under the new name, so a key made
// before the rename keeps working; only the app on the phone changes. The path
// /api/location was also, until 2026-09-15, the browser tick's own endpoint
// (positions.go) - that one is long gone, the name is free.
//
// A position is stored only in a trip whose days cover it and that was not
// switched off in Trips (positions.go); between trips, what an app sends goes
// nowhere.

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// trackerKey is one row of config/location.json.
type trackerKey struct {
	Owner   string `json:"owner"`
	Key     string `json:"key"`
	Created int64  `json:"created"`
}

type trackersFile struct {
	Keys []trackerKey `json:"keys"`
}

// Trackers is the key table, loaded from disk on first use.
type Trackers struct {
	mu      sync.Mutex
	path    string
	oldPath string // config/owntracks.json, this file's name before 2026-09-16
	loaded  bool
	broken  bool // the file existed but could not be read: save() moves it aside first
	keys    []trackerKey
	log     Logger
}

func NewTrackers(configDir string, log Logger) *Trackers {
	return &Trackers{
		path:    filepath.Join(configDir, "location.json"),
		oldPath: filepath.Join(configDir, "owntracks.json"),
		log:     log,
	}
}

// ensureLoaded fills the table the first time anything asks. Caller holds mu.
func (t *Trackers) ensureLoaded() {
	if t.loaded {
		return
	}
	t.loaded = true

	var file trackersFile
	ok, broken := loadTable(t.path, &file, t.log, "starting with no keys")
	fromOld := false
	if !ok && !broken {
		// The name before 2026-09-16. Read it, and save() below writes the keys
		// back under the new name - the user's key survives the rename.
		ok, broken = loadTable(t.oldPath, &file, t.log, "starting with no keys")
		fromOld = ok
	}
	t.broken = broken
	if !ok {
		return
	}
	for _, k := range file.Keys {
		if k.Owner != "" && len(k.Key) >= 32 {
			t.keys = append(t.keys, k)
		}
	}
	// Once saved under the new name, the old file goes: left there, it would
	// bring the old keys back the day location.json went missing.
	if fromOld && len(t.keys) > 0 && t.save() {
		t.log.Info("location keys moved from owntracks.json", "keys", len(t.keys))
		if err := os.Remove(t.oldPath); err != nil {
			t.log.Warn("cannot remove the old owntracks.json", "err", err)
		}
	}
}

// save writes the table back, and reports whether it did. Caller holds mu. It
// never writes over a file that could not be read: that one is moved aside
// first (saveTable).
func (t *Trackers) save() bool {
	keys := t.keys
	if keys == nil {
		keys = []trackerKey{}
	}
	return saveTable(t.path, &t.broken, trackersFile{Keys: keys}, t.log)
}

// For is the key of `owner`, or nil.
func (t *Trackers) For(owner string) *trackerKey {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.ensureLoaded()
	for i := range t.keys {
		if t.keys[i].Owner == owner {
			k := t.keys[i]
			return &k
		}
	}
	return nil
}

// Create makes the key of `owner`, or hands back the one they have (created=false).
func (t *Trackers) Create(owner string) (key trackerKey, created bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.ensureLoaded()
	for _, k := range t.keys {
		if k.Owner == owner {
			return k, false
		}
	}
	k := trackerKey{Owner: owner, Key: newToken(), Created: time.Now().Unix()}
	t.keys = append(t.keys, k)
	t.save()
	t.log.Info("location URL created", "owner", owner)
	return k, true
}

// OwnerOf is whose key this is, or "".
func (t *Trackers) OwnerOf(key string) string {
	if len(key) < 32 {
		return ""
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.ensureLoaded()
	for _, k := range t.keys {
		if subtle.ConstantTimeCompare([]byte(k.Key), []byte(key)) == 1 {
			return k.Owner
		}
	}
	return ""
}

// Remove turns off the key of `owner`. True when there was one.
func (t *Trackers) Remove(owner string) bool { return t.change(owner, "") }

// DropUser forgets a deleted user's key.
func (t *Trackers) DropUser(name string) { t.change(name, "") }

// RenameUser moves a renamed user's key to the new name.
func (t *Trackers) RenameUser(oldName, newName string) { t.change(oldName, newName) }

// change drops the key of `owner` (to == "") or gives it to `to`.
func (t *Trackers) change(owner, to string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.ensureLoaded()
	kept := t.keys[:0:0]
	found := false
	for _, k := range t.keys {
		if k.Owner != owner {
			kept = append(kept, k)
			continue
		}
		found = true
		if to != "" {
			k.Owner = to
			kept = append(kept, k)
		}
	}
	if found {
		t.keys = kept
		t.save()
	}
	return found
}

// -----------------------------------------------------------------------------
// the routes
// -----------------------------------------------------------------------------

func trackerOut(k *trackerKey) map[string]any {
	return map[string]any{"url": "/api/location/" + k.Key, "created": k.Created}
}

// apiLocationKey is the owner's side, for Trips' "My location" sheet.
func (s *Server) apiLocationKey(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if sess.Role == "admin" {
		sendError(w, r, http.StatusForbidden, "el administrador no tiene viajes")
		return
	}

	switch r.Method {
	case http.MethodGet:
		if k := s.trackers.For(sess.User); k != nil {
			sendJSON(w, r, http.StatusOK, trackerOut(k))
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]any{})

	case http.MethodPost:
		k, created := s.trackers.Create(sess.User)
		status := http.StatusOK
		if created {
			status = http.StatusCreated
		}
		sendJSON(w, r, status, trackerOut(&k))

	case http.MethodDelete:
		if !s.trackers.Remove(sess.User) {
			sendError(w, r, http.StatusNotFound, "el envío de ubicación no estaba activado")
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"message": "envío de ubicación desactivado"})

	default:
		sendError(w, r, http.StatusMethodNotAllowed, "use GET, POST o DELETE")
	}
}

// apiLocationReport answers the apps: /api/location/<key>/<app>. No session -
// the key in the path is the whole credential.
func (s *Server) apiLocationReport(w http.ResponseWriter, r *http.Request) {
	owner := s.trackers.OwnerOf(r.PathValue("key"))
	if owner == "" {
		sendError(w, r, http.StatusUnauthorized, "clave no válida")
		return
	}

	switch r.PathValue("app") {
	case "gpslogger":
		s.locationFromGpsLogger(w, r, owner)
	case "gpslogger.properties":
		s.locationGpsLoggerProfile(w, r)
	case "overland":
		s.locationFromOverland(w, r, owner)
	default:
		sendError(w, r, http.StatusNotFound, "esa app de ubicación no existe")
	}
}

// -----------------------------------------------------------------------------
// GPSLogger (Android)
// -----------------------------------------------------------------------------

// gpsLoggerMessage is the body the .properties file tells the app to send.
type gpsLoggerMessage struct {
	Lat *float64 `json:"lat"`
	Lon *float64 `json:"lon"`
	Acc *float64 `json:"acc"`
	Tst int64    `json:"tst"`
}

func (s *Server) locationFromGpsLogger(w http.ResponseWriter, r *http.Request, owner string) {
	if r.Method != http.MethodPost {
		sendError(w, r, http.StatusMethodNotAllowed, "use POST")
		return
	}

	var msg gpsLoggerMessage
	if err := readJSON(w, r, &msg); err != nil {
		if errors.Is(err, errBodyTooLarge) {
			sendBodyError(w, r, err)
			return
		}
		// Refusing would only make the app retry the same message forever.
		s.log.Warn("GPSLogger sent something unreadable", "owner", owner, "err", err)
	} else if msg.Lat != nil && msg.Lon != nil {
		s.recordPositions(owner, []tripPosition{{
			Lat: *msg.Lat, Lon: *msg.Lon, Acc: accOrApp(msg.Acc), At: stampOrNow(msg.Tst), Source: "gpslogger",
		}})
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"ok": true})
}

// locationGpsLoggerProfile hands the app its whole setup, so nothing is typed on
// the phone: GPSLogger loads it from "Profiles -> From URL", which is what the
// "Set up GPSLogger" link in Trips opens. The key is already in the URL asking
// for it, so the file may hold the sending URL in clear.
func (s *Server) locationGpsLoggerProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendError(w, r, http.StatusMethodNotAllowed, "use GET")
		return
	}
	sendBytes(w, r, http.StatusOK, "text/plain; charset=utf-8",
		[]byte(gpsLoggerProfile(requestOrigin(r)+"/api/location/"+r.PathValue("key")+"/gpslogger")))
}

// gpsLoggerProfile is a Java .properties file: one key=value per line, the names
// are GPSLogger's own (PreferenceNames.java). %LAT and friends are ITS
// placeholders - it fills them in for every position it sends.
func gpsLoggerProfile(sendURL string) string {
	return strings.Join([]string{
		"# GPSLogger settings for Nayive. Load with Profiles -> From URL,",
		"# or tap \"Set up GPSLogger\" in Trips -> My location.",
		"log_customurl_enabled=true",
		"log_customurl_url=" + sendURL,
		"log_customurl_method=POST",
		"log_customurl_body={\"lat\":%LAT,\"lon\":%LON,\"acc\":%ACC,\"tst\":%TIMESTAMP}",
		"log_customurl_headers=Content-Type: application/json",
		// Keep the points made while the phone has no data, and send them later.
		"log_customurl_discard_offline_locations_enabled=false",
		"time_before_logging=300",
		"distance_before_logging=100",
		"accuracy_before_logging=200",
		"keep_fix=false",
		// No files on the phone: Nayive is the only place this goes.
		"log_gpx=false",
		"log_kml=false",
		"log_plain_text=false",
		"autosend_enabled=false",
		"startonbootup=true",
		"startonapplaunch=true",
	}, "\n") + "\n"
}

// -----------------------------------------------------------------------------
// Overland (iPhone)
// -----------------------------------------------------------------------------

// maxOverlandBody is bigger than maxBody (1 MiB): Overland batches up to 1000
// positions in one request, each with a dozen extra fields. A 413 would not be
// the end of it either - the app would send the very same batch again forever.
const maxOverlandBody = 4 << 20

// overlandBatch is the part of Overland's GeoJSON that is used. Coordinates are
// [lon, lat] - GeoJSON's order, not ours.
type overlandBatch struct {
	Locations []struct {
		Geometry struct {
			Coordinates []float64 `json:"coordinates"`
		} `json:"geometry"`
		Properties struct {
			Timestamp string   `json:"timestamp"`
			Acc       *float64 `json:"horizontal_accuracy"`
		} `json:"properties"`
	} `json:"locations"`
}

func (s *Server) locationFromOverland(w http.ResponseWriter, r *http.Request, owner string) {
	if r.Method != http.MethodPost {
		sendError(w, r, http.StatusMethodNotAllowed, "use POST")
		return
	}
	if r.ContentLength > maxOverlandBody {
		sendError(w, r, http.StatusRequestEntityTooLarge, "envío demasiado grande")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxOverlandBody)

	var batch overlandBatch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		// Same reasoning as GPSLogger: an error here would be retried forever.
		s.log.Warn("Overland sent something unreadable", "owner", owner, "err", err)
	} else {
		points := make([]tripPosition, 0, len(batch.Locations))
		for _, loc := range batch.Locations {
			if len(loc.Geometry.Coordinates) < 2 {
				continue
			}
			at, ok := overlandTime(loc.Properties.Timestamp)
			if !ok {
				continue
			}
			points = append(points, tripPosition{
				Lat: loc.Geometry.Coordinates[1], Lon: loc.Geometry.Coordinates[0],
				Acc: accOrApp(loc.Properties.Acc), At: at, Source: "overland",
			})
		}
		s.recordPositions(owner, points)
	}

	// Overland deletes its copy of the batch only for exactly this answer.
	sendJSON(w, r, http.StatusOK, map[string]string{"result": "ok"})
}

// overlandTime reads Overland's timestamp: ISO 8601, with the zone written
// either "Z" / "+02:00" (RFC 3339) or "-0700", as its own README shows.
func overlandTime(s string) (int64, bool) {
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05Z0700", "2006-01-02T15:04:05.999999Z0700"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Unix(), true
		}
	}
	return 0, false
}

// -----------------------------------------------------------------------------
// shared
// -----------------------------------------------------------------------------

// accOrApp is the accuracy an app reported, or what a phone app is worth when it
// said nothing useful.
func accOrApp(acc *float64) float64 {
	if acc != nil && *acc > 0 {
		return *acc
	}
	return accApp
}

// stampOrNow is when the position was taken; an app that sent no time means now.
func stampOrNow(tst int64) int64 {
	if tst > 0 {
		return tst
	}
	return time.Now().Unix()
}

// requestOrigin is this Nayive's own address, as the phone asking for it sees it
// - the .properties file has to carry an absolute URL. Nothing proxies Nayive,
// so X-Forwarded-Proto is not trusted.
func requestOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
