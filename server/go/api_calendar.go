package main

// =============================================================================
// /api/calendar/today - how many of today's events are still to come.
// =============================================================================
//
//	GET /api/calendar/today?tz=Europe/Madrid   -> {"n": 3}
//
// The launcher's Planner tile shows it, like Chat's and eMail's unread counts
// (2026-10-28). Read only: it never writes the calendar.
//
// "Still to come" is every start from now to the end of today, on the wall
// clock of `tz` (the browser's own zone), else the account's, else the box's.
// It counts with the reminder loop's reader (ics.go), so a repeating event
// counts on each of its days, and an all-day event - which has no time - does
// not count. No calendar file is 0, not an error; so is the admin, who has none.

import (
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func (s *Server) apiCalendar(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if r.PathValue("what") != "today" {
		sendError(w, r, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		sendError(w, r, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	n := 0
	if sess.Role == "user" {
		n = s.calendarLeftToday(sess.User, queryValue(r, "tz"), time.Now())
	}
	sendJSON(w, r, http.StatusOK, map[string]int{"n": n})
}

// calendarLeftToday counts the starts in [now, next midnight) of `user`'s
// calendar, on the wall clock of the zone named `tz` (or the account's).
func (s *Server) calendarLeftToday(user, tz string, now time.Time) int {
	loc := Location(&tz)
	if loc == nil {
		loc = Location(s.users.UserTZ("user", user))
	}
	if loc == nil {
		loc = time.Local
	}
	raw, err := os.ReadFile(filepath.Join(s.cfg.HomesDir, user, "data", "calendar.ics"))
	if err != nil {
		return 0
	}
	now = now.In(loc)
	y, m, d := now.Date()
	end := time.Date(y, m, d+1, 0, 0, 0, 0, loc).Add(-time.Second) // StartsBetween's `to` is inclusive
	n := 0
	for _, ev := range ParseEvents(string(raw), loc) {
		n += len(ev.StartsBetween(now, end))
	}
	return n
}
