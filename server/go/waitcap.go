package main

// =============================================================================
// waitcap - how many long-polls ONE credential may hold open at once.
// =============================================================================
//
// A long-poll holds a connection slot for as long as it waits: a Chat wait up
// to chatWaitMax (25 s), a phone's /api/device/wait up to deviceHold (180 s).
// The listener caps connections (250, and a quarter of that per address -
// listener.go), but nothing stopped ONE link or token from opening waits from
// many addresses until the whole server was full. This caps them per
// credential (docs/audit/server-go.md #14).
//
// The two long-polls, and the key each one counts under:
//
//	chatWait    /api/c/<token>/wait           "chat-link:" + SHA-256 of the link
//	            /api/chat/wait                "chat:" + SHA-256 of the session + ":"
//	            /api/chat/via/<owner>/wait    "chat:" + SHA-256 of the session + ":" + owner
//	deviceWait  /api/device/wait              "device:" + the stored hash of the phone's token
//
// Only hashes: a key is never a credential, and nothing here logs it.
//
// Over the cap a wait is refused at once with 429 + Retry-After, before any
// lock is taken. Every client already backs off on that, without a change:
//   - Chat (client/apps/chat/list.js, loop): anything but 404/abort sleeps
//     1 s, doubling to 20 s (2 s during a call), and shows the "offline" dot
//     meanwhile; only 401 means "session expired", only 404 "link gone".
//   - The Android app (LinkService.pollLoop): anything but 200/401 counts a
//     failure and pauses 10 s, doubling to 5 min.
//   - The launcher and the desktop never long-poll: they GET /api/chat/unread
//     once a minute.
// An empty "nothing new" 200 would be worse: both clients ask again at once
// after a 200, so a refused wait would spin.
//
// Bookmarks' icon lookups (bmTakeSlot) also block, but only up to 20 s, for a
// signed-in user, from a small fixed pool: not a long-poll, not counted here.

import (
	"net/http"
	"sync"
)

// waitCapMax is the most waits one key may hold at once. Why 8:
//   - a Chat tab holds ONE wait per world (its own home, and one per home it
//     reads "via"), and each world is its own key - so five tabs open on the
//     same session are five waits on each key;
//   - a reload, or a tab going to the background, aborts its fetch and the
//     wait ends at once; a laptop that slept mid-wait leaves one behind for at
//     most chatWaitMax;
//   - a phone holds ONE, but a network switch (wifi <-> mobile) can leave the
//     old socket half-open on this side for up to deviceHold.
//
// 8 covers all of that with room to spare, and still takes 250/8 ≈ 31
// credentials to fill the server - one leaked link gets 8 slots, not 250.
const waitCapMax = 8

// waitCapRetry is the Retry-After of a refused wait, in seconds. The clients
// keep their own back-off; this is for anything else that honours it.
const waitCapRetry = "10"

// waitCap counts the open waits per key.
type waitCap struct {
	mu   sync.Mutex
	max  int
	open map[string]int // key -> waits open; a key at 0 is deleted, not kept
}

// waits is the one counter both long-polls share.
var waits = newWaitCap(waitCapMax)

func newWaitCap(limit int) *waitCap {
	return &waitCap{max: limit, open: map[string]int{}}
}

// acquire takes a slot for `key`; false when it already holds max. A true is
// paired with exactly one release.
func (c *waitCap) acquire(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.open[key] >= c.max {
		return false
	}
	c.open[key]++
	return true
}

// release gives the slot back. The entry goes when it reaches 0: keys come
// from the request (the via path's owner), so the map must not keep them.
func (c *waitCap) release(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if n := c.open[key]; n > 1 {
		c.open[key] = n - 1
	} else {
		delete(c.open, key)
	}
}

// count is how many waits `key` holds (the tests).
func (c *waitCap) count(key string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.open[key]
}

// size is how many keys hold a wait (the tests: no leak).
func (c *waitCap) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.open)
}

// chatWaitKey is the credential a Chat wait came with: the link for a person,
// else the session (the owner's route and every "via" route - they all went
// through requireSession) and the home it reads.
func chatWaitKey(r *http.Request) string {
	if t := r.PathValue("token"); t != "" {
		return "chat-link:" + tokenKey(t)
	}
	return "chat:" + tokenKey(tokenFrom(r)) + ":" + r.PathValue("owner")
}

// takeWait takes a slot for `key`, or answers 429 and reports false. On true
// the caller defers waits.release(key).
func takeWait(w http.ResponseWriter, r *http.Request, key string) bool {
	if waits.acquire(key) {
		return true
	}
	w.Header().Set("Retry-After", waitCapRetry)
	sendError(w, r, http.StatusTooManyRequests, "demasiadas esperas abiertas")
	return false
}
