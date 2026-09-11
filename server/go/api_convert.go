package main

// =============================================================================
// GET /api/convert - is the video converter on, and this user's jobs.
// =============================================================================
//
// A job is STARTED by an upload (PUT /api/files?file=...&convert=mp4), never
// here - see convert.go. Drive reads this to decide whether to offer the
// conversion at all, and to show "En cola" / "Convirtiendo… 42 %" on a row.
//
//	{"available": true, "jobs": [{"path": "files/x.avi", "state": "running", "percent": 42}]}

import "net/http"

func (s *Server) apiConvert(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		sendError(w, r, http.StatusMethodNotAllowed, "use GET")
		return
	}
	// Only a user's own uploads convert: the admin has no devices to tell
	// (notifications are per user - see api_push.go).
	available, jobs := false, []ConvertStatus{}
	if sess.Role == "user" {
		available, jobs = s.convert.Available(), s.convert.Status(sess.User)
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"available": available, "jobs": jobs})
}
