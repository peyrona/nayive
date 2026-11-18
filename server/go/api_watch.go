package main

// =============================================================================
// /api/watch - "tell me when this file changes", a long-poll.
// =============================================================================
//
//	GET /api/watch?file=<path>            answers at once: {"etag": its version now}
//	GET /api/watch?file=<path>&etag=<t>   holds while the version is still <t>,
//	                                      up to watchHold, then {"etag": ...}
//
// A page that shows one file (Calendar: data/calendar.ics) keeps one of these
// open and re-reads the file when the tag moves (AyniBoot.wireRefresh, `watch`).
// An event added on the phone shows on the PC a second later, with no click.
//
// READ-ONLY. The wait looks at the file once per watchTick (one stat) and
// writes nothing. So it sees every way a file changes - a save, a restore from
// the bin, a move or a copy over it, a server write - without a hook in any
// write path. "-" is the tag of no file there.
//
// The same gates as reading the file (api_files.go, GET ?file=): a session,
// Users.Resolve, never config/, never a shortcut through a share. At most
// watchCapMax waits at once per session (watchWaits).

import (
	"errors"
	"io/fs"
	"net/http"
	"path"
	"time"
)

const (
	watchHold = 25 * time.Second // a wait's longest hold, like chatWaitMax
	watchTick = time.Second      // how often a wait looks at the file
)

// watchCapMax: the file waits one session may hold at once, counted apart
// from the Chat and phone waits (waitcap.go). A browser holds one per page
// that shows a watched file - Planner (three panes) and five app windows on
// the desktop are eight - and over HTTPS they share ONE connection (HTTP/2).
// Over plain HTTP the pages hold none (ayni-boot.js watchFile). Over the cap:
// 429, and the page backs off.
const watchCapMax = 16

var watchWaits = newWaitCap(watchCapMax)

func (s *Server) apiWatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendError(w, r, http.StatusMethodNotAllowed, r.Method+" not allowed")
		return
	}
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	q := cleanQuery(r)
	fileRel := q.Get("file")
	if fileRel == "" {
		sendError(w, r, http.StatusBadRequest, "missing ?file=")
		return
	}
	target, ok := s.users.Resolve(sess.Role, sess.User, fileRel)
	if !ok || s.inConfig(target.Abs) {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}
	if IsSharedPath(fileRel) && isLinkName(path.Base(fileRel)) {
		sendError(w, r, http.StatusNotFound, "not found")
		return
	}

	cur, err := watchTag(target)
	if err != nil {
		sendMissing(w, r, err, "")
		return
	}
	if seen := q.Get("etag"); q.Has("etag") && seen == cur {
		key := "watch:" + tokenKey(tokenFrom(r))
		if !watchWaits.acquire(key) {
			w.Header().Set("Retry-After", waitCapRetry)
			sendError(w, r, http.StatusTooManyRequests, "demasiadas esperas abiertas")
			return
		}
		defer watchWaits.release(key)

		hold := time.NewTimer(watchHold)
		defer hold.Stop()
		tick := time.NewTicker(watchTick)
		defer tick.Stop()
	wait:
		for cur == seen {
			select {
			case <-tick.C:
				if t, err := watchTag(target); err == nil { // a passing error: look again next tick
					cur = t
				}
			case <-hold.C:
				break wait
			case <-s.watchCtx.Done(): // the server is shutting down
				break wait
			case <-r.Context().Done(): // the page went away
				return
			}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	sendJSON(w, r, http.StatusOK, map[string]string{"etag": cur})
}

// watchTag is the file's version now: its ETag (etag.go), or "-" when there is
// no file. A home the admin moved under the wait (errRootGone) is an error,
// never "no file": that would tell the page its file was gone.
func watchTag(t Resolved) (string, error) {
	info, err := t.Stat()
	switch {
	case err == nil && info.Mode().IsRegular():
		return fileETag(info), nil
	case err == nil:
		return "-", nil // a folder of that name: no file
	case errors.Is(err, errRootGone):
		return "", err
	case errors.Is(err, fs.ErrNotExist):
		return "-", nil
	default:
		return "", err
	}
}
