package main

// =============================================================================
// SessionStore - the in-memory session table, and the cookie that carries it.
// =============================================================================
//
// A session is a random opaque token (the value of the `nayive_session` cookie)
// mapped to {user, role, expiry}. No database, no files: a map in this one
// process. Restart the server and everyone signs in again. Same design as
// lib/sessions.py.
//
// java: THREADING. net/http runs every request on its own goroutine, so this
// map is shared mutable state and needs a lock. Go's maps are NOT
// ConcurrentHashMap: a concurrent read and write does not merely give a stale
// answer, it CRASHES the process ("concurrent map writes"). The race detector
// (`go test -race`) finds these.
//
// java: sync.Mutex is `synchronized`, with two differences worth remembering:
// it is NOT REENTRANT (a method holding the lock must never call another one
// that takes it - instant deadlock), and it is a plain field, not a monitor
// baked into every object.

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Session is what a token resolves to. Handed to callers BY VALUE, so nobody
// can reach back into the store and edit it.
type Session struct {
	User string `json:"user"`
	Role string `json:"role"` // "admin" or "user"
}

// entry is the stored form: the session plus its expiry bookkeeping.
//
// java: lowercase name = package private. Nothing outside this file needs it.
type entry struct {
	session Session
	ttl     time.Duration
	expires time.Time
}

// SessionStore is the table itself.
//
// java: `mu sync.Mutex` as the FIRST FIELD is the Go convention, and it means
// "this mutex guards the fields below it". Embedding it by value (not as a
// pointer) is correct - but it does mean a SessionStore must never be copied
// once used, which is why every method below has a POINTER receiver `(s *Store)`
// and NewSessionStore returns a pointer.
type SessionStore struct {
	mu       sync.Mutex
	byToken  map[string]*entry
	fallback time.Duration // TTL used when Create is given zero
}

// NewSessionStore builds an empty table.
//
// java: a map must be MADE before use. A nil map reads fine (returns the zero
// value) but panics on write - the one place Go's zero value is not ready to go.
func NewSessionStore(defaultTTL time.Duration) *SessionStore {
	return &SessionStore{
		byToken:  make(map[string]*entry),
		fallback: defaultTTL,
	}
}

// Create mints a token for (user, role) and returns it.
func (s *SessionStore) Create(user, role string, ttl time.Duration) string {
	if ttl <= 0 {
		ttl = s.fallback
	}
	token := newToken()

	// java: `defer` schedules a call for when the FUNCTION returns, however it
	// returns - normal return, or a panic unwinding through it. It is the
	// finally block, written next to the thing it undoes instead of forty lines
	// below. `lock(); defer unlock()` is the idiom; use it every time.
	s.mu.Lock()
	defer s.mu.Unlock()

	s.byToken[token] = &entry{
		session: Session{User: user, Role: role},
		ttl:     ttl,
		expires: time.Now().Add(ttl),
	}
	return token
}

// Get resolves a token, or reports that it is unknown or expired.
// Every hit slides the expiry forward, exactly like sessions.py.
//
// java: `(Session, bool)` is the Go answer to returning null. The caller writes
// `sess, ok := store.Get(tok); if !ok { ... }`. The compiler will not let you
// use `sess` without having received `ok`, so there is no accidental NPE.
func (s *SessionStore) Get(token string) (Session, bool) {
	if token == "" {
		return Session{}, false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	e, found := s.byToken[token]
	if !found {
		return Session{}, false
	}
	if time.Now().After(e.expires) {
		delete(s.byToken, token)
		return Session{}, false
	}
	e.expires = time.Now().Add(e.ttl) // sliding window
	return e.session, true
}

// Drop forgets one token (sign-out).
//
// java: deleting a key that is not there is a no-op, not an exception.
func (s *SessionStore) Drop(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.byToken, token)
}

// DropUser kills every session belonging to `user` (used when an account is
// deleted, so an open tab cannot keep working).
//
// java: unlike Java's iterator, deleting from a Go map WHILE ranging over it is
// explicitly legal - no ConcurrentModificationException. sessions.py has to
// build a list first; here the loop is enough.
func (s *SessionStore) DropUser(user string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, e := range s.byToken {
		if e.session.User == user {
			delete(s.byToken, token)
		}
	}
}

// Sweep drops expired sessions. The background worker calls this so closed
// browsers do not pile up forever.
func (s *SessionStore) Sweep() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	removed := 0
	for token, e := range s.byToken {
		if now.After(e.expires) {
			delete(s.byToken, token)
			removed++
		}
	}
	return removed
}

// Count is here for the tests and the log line.
func (s *SessionStore) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.byToken)
}

// newToken returns ~43 URL-safe random characters, like secrets.token_urlsafe(32).
//
// java: crypto/rand is SecureRandom. It cannot fail in practice, and since
// Go 1.24 its Read never returns an error at all - so there is nothing to check
// here. Never use math/rand for anything a person could guess.
func newToken() string {
	raw := make([]byte, 32)
	rand.Read(raw)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// -----------------------------------------------------------------------------
// The cookie
// -----------------------------------------------------------------------------

// sessionCookie builds the Set-Cookie header for a fresh sign-in, and
// clearCookie its sign-out counterpart.
//
// java: http.Cookie + http.SetCookie would be the idiomatic call, and it is
// what the spike used. The header is built by hand here for ONE reason: it
// emits the attributes in its own order, and while no browser cares, the parity
// harness that compares this port with the Python line by line does. Matching
// handler.py exactly means one less "expected difference" to explain away
// forever after.
func sessionCookieHeader(token string, ttl time.Duration, remember, secure bool) string {
	out := CookieName + "=" + token + "; HttpOnly; SameSite=Lax; Path=/"
	if remember {
		// No Max-Age at all makes it a session cookie: gone when the browser
		// closes. "Mantenme conectado" is what asks for a persistent one.
		out += "; Max-Age=" + strconv.Itoa(int(ttl.Seconds()))
	}
	if secure {
		// Only over TLS: the browser must never send this back in clear.
		out += "; Secure"
	}
	return out
}

// clearCookieHeader expires the cookie in place - same name, same path.
func clearCookieHeader() string {
	return CookieName + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
}

// tokenFrom pulls the session token out of the request's Cookie header.
//
// java: r.Cookie returns http.ErrNoCookie when it is absent. We do not care
// which error it was, only that there is no usable token, so the error is
// discarded with `_` - Go's "yes, I saw it, I am ignoring it on purpose".
func tokenFrom(r *http.Request) string {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return ""
	}
	return c.Value
}
