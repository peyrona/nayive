package main

// =============================================================================
// OwnTracks - the owner's position from the background, for public trip links.
// =============================================================================
//
// A web page cannot read GPS with the page closed. The OwnTracks app (free, for
// Android and iPhone) can, and in its HTTP mode it sends every position to a
// URL of our choosing. Each user may have ONE such URL, made in a trip's Share
// sheet:
//
//	/api/owntracks/<key>
//
// The key is the only credential - a long random string (newToken), like a
// public link's token - so the app needs no user name or password. It lives in
// config/owntracks.json, outside every home, where no file API reaches.
//
//	GET    /api/owntracks         (session) -> {"url", "created"}, or {} when off
//	POST   /api/owntracks         (session) -> make the URL (or hand back the one there is)
//	DELETE /api/owntracks         (session) -> turn it off: the URL stops working
//	POST   /api/owntracks/<key>   (the app) -> one message, answered []
//
// The app sends one JSON message per request. Only {"_type":"location"} is used
// (lat, lon, acc in metres, tst = when, UNIX seconds); anything else - a
// waypoint, a status, an encrypted payload - is accepted and ignored. The answer
// is always a JSON array, which is what the app expects: anything but a 2xx
// makes it queue the message and retry.
//
// A position is stored only in a linked trip whose days cover it (positions.go);
// between trips, what the app sends goes nowhere.

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// trackerKey is one row of config/owntracks.json.
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
	mu     sync.Mutex
	path   string
	loaded bool
	broken bool // the file existed but could not be read: save() moves it aside first
	keys   []trackerKey
	log    Logger
}

func NewTrackers(configDir string, log Logger) *Trackers {
	return &Trackers{path: filepath.Join(configDir, "owntracks.json"), log: log}
}

// ensureLoaded fills the table the first time anything asks. Caller holds mu.
func (t *Trackers) ensureLoaded() {
	if t.loaded {
		return
	}
	t.loaded = true
	raw, err := os.ReadFile(t.path)
	if err != nil {
		if !os.IsNotExist(err) {
			t.log.Error("owntracks.json is unreadable - starting with no keys", "err", err)
			t.broken = true
		}
		return
	}
	var file trackersFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.log.Error("owntracks.json is unreadable - starting with no keys", "err", err)
		t.broken = true
		return
	}
	for _, k := range file.Keys {
		if k.Owner != "" && len(k.Key) >= 32 {
			t.keys = append(t.keys, k)
		}
	}
}

// save writes the table back. Caller holds mu. Like Shares.save, it never writes
// over a file that could not be read: that one is moved aside first.
func (t *Trackers) save() {
	if t.broken {
		aside := t.path + ".broken-" + time.Now().Format("2006-01-02-150405")
		if err := os.Rename(t.path, aside); err != nil && !os.IsNotExist(err) {
			t.log.Error("owntracks.json is unreadable and cannot be moved aside - not saving", "err", err)
			return
		}
		t.broken = false
	}
	keys := t.keys
	if keys == nil {
		keys = []trackerKey{}
	}
	if err := atomicWriteJSON(t.path, trackersFile{Keys: keys}, 4); err != nil {
		t.log.Error("cannot save owntracks.json", "err", err)
	}
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
	t.log.Info("OwnTracks URL created", "owner", owner)
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
	return map[string]any{"url": "/api/owntracks/" + k.Key, "created": k.Created}
}

// apiOwnTracks is the owner's side, for the Share sheet.
func (s *Server) apiOwnTracks(w http.ResponseWriter, r *http.Request) {
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
			sendError(w, r, http.StatusNotFound, "OwnTracks no estaba activado")
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"message": "OwnTracks desactivado"})

	default:
		sendError(w, r, http.StatusMethodNotAllowed, "use GET, POST o DELETE")
	}
}

// owntracksMessage is the part of an OwnTracks message that is used.
type owntracksMessage struct {
	Type string   `json:"_type"`
	Lat  *float64 `json:"lat"`
	Lon  *float64 `json:"lon"`
	Acc  *float64 `json:"acc"`
	Tst  int64    `json:"tst"`
}

// apiOwnTracksReport answers the app: POST /api/owntracks/<key>. No session.
func (s *Server) apiOwnTracksReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendError(w, r, http.StatusMethodNotAllowed, "use POST")
		return
	}
	owner := s.trackers.OwnerOf(r.PathValue("key"))
	if owner == "" {
		sendError(w, r, http.StatusUnauthorized, "clave no válida")
		return
	}

	var msg owntracksMessage
	if err := readJSON(w, r, &msg); err != nil {
		if errors.Is(err, errBodyTooLarge) {
			sendBodyError(w, r, err)
			return
		}
		// Refusing would only make the app retry the same message forever.
		s.log.Warn("OwnTracks sent something unreadable", "owner", owner, "err", err)
	} else if msg.Type == "location" && msg.Lat != nil && msg.Lon != nil {
		at := msg.Tst
		if at <= 0 {
			at = time.Now().Unix()
		}
		acc := accApp
		if msg.Acc != nil && *msg.Acc > 0 {
			acc = *msg.Acc
		}
		s.recordPosition(owner, tripPosition{Lat: *msg.Lat, Lon: *msg.Lon, Acc: acc, At: at, Source: "owntracks"})
	}
	sendBytes(w, r, http.StatusOK, "application/json", []byte("[]"))
}
