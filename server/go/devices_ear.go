package main

// =============================================================================
// The phone at the ear - a voice call on a phone with the Android app.
// =============================================================================
//
// With the screen on, an ear or a cheek on the glass presses whatever is
// under it. A web page cannot read the proximity sensor; the app can: while a
// voice call is on, LinkService holds PROXIMITY_SCREEN_OFF_WAKE_LOCK and
// Android turns the screen off near the ear, as a phone call does.
//
// The page in the call says so here, naming the phone by the id it got at the
// enrolment ("nayive-device" in its storage):
//
//	POST /api/device/<id>/ear  (session) {on} -> {"ok", "app"}
//
// "on" lasts earHeld; the page repeats it while the call goes on, so a page
// that dies mid-call leaves no screen tied to the sensor. The phone's next
// wait carries "ear": true|false.
//
// "app" tells the page whether the phone will do it: its wait is open (or
// was a moment ago), and it said `ear=1` on it - it has a proximity sensor,
// and an APK that knows the job. False: the page puts up its own padlock
// (chat/ear.js). Only memory here; nothing reaches the disk.

import (
	"net/http"
	"sync"
	"time"
)

// Vars, not consts, so the tests can shorten them.
var (
	earHeld = 90 * time.Second // an "on" lasts this long without a new one
	earGap  = 15 * time.Second // a wait closed this recently still counts as open
)

type earTable struct {
	mu    sync.Mutex
	until map[string]time.Time // phone id -> its "on" ends
	links map[string]*earLink  // phone id -> its waits
}

type earLink struct {
	open   int       // waits held right now
	closed time.Time // when the last one ended
	can    bool      // the phone said ear=1
}

func (e *earTable) link(id string) *earLink {
	if e.links == nil {
		e.links = make(map[string]*earLink)
	}
	l := e.links[id]
	if l == nil {
		l = &earLink{}
		e.links[id] = l
	}
	return l
}

// opened / closed bracket one wait of the phone.
func (e *earTable) opened(id string, can bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	l := e.link(id)
	l.open++
	l.can = can
}

func (e *earTable) closed(id string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	l := e.link(id)
	if l.open > 0 {
		l.open--
	}
	l.closed = time.Now()
}

// ready: the phone is listening now and can do it.
func (e *earTable) ready(id string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	l := e.links[id]
	return l != nil && l.can && (l.open > 0 || time.Since(l.closed) < earGap)
}

// set switches it; true when that changed what the phone is told.
func (e *earTable) set(id string, on bool) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.until == nil {
		e.until = make(map[string]time.Time)
	}
	was := time.Now().Before(e.until[id])
	if on {
		e.until[id] = time.Now().Add(earHeld)
	} else {
		delete(e.until, id)
	}
	return was != on
}

// on is when the phone's "on" ends, or zero when it is off.
func (e *earTable) on(id string) time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	u := e.until[id]
	if !time.Now().Before(u) {
		delete(e.until, id)
		return time.Time{}
	}
	return u
}

// deviceEar is POST /api/device/<id>/ear.
func (s *Server) deviceEar(w http.ResponseWriter, r *http.Request, user, id string) {
	if !allowMethod(w, r, "use POST", http.MethodPost) {
		return
	}
	var body struct {
		On bool `json:"on"`
	}
	if !readJSONBody(w, r, &body) {
		return
	}
	if dev := s.devices.byID(id); dev == nil || dev.Owner != user {
		sendError(w, r, http.StatusNotFound, "ese móvil no existe")
		return
	}
	if s.devices.ear.set(id, body.On) {
		s.devices.Kick()
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"ok": true, "app": s.devices.ear.ready(id)})
}
