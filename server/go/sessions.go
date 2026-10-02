package main

// =============================================================================
// SessionStore - the session table, and the cookie that carries it.
// =============================================================================
//
// A session is a random opaque token (the value of the `nayive_session` cookie)
// mapped to {user, role, expiry}. The table is a map in this one process, and
// a copy of it lives in config/sessions.json, so a restart - every deploy - no
// longer signs everyone out. (Until 2026-09-21 it did; the Android app made
// it plain: its first screen after a deploy was the password.)
//
// Only each token's SHA-256 reaches the disk, as in devices.json: the file on
// its own signs nobody in. It is written at once on a sign-in or a sign-out;
// the sliding expiries - every request moves one - at most every
// sessionSaveEvery, from the sweep, and on the way out (Server.Close). A
// kill -9 loses at most that much of a slide.
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
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"
)

// sessionSaveEvery is how stale the expiries on disk may get. A var, not a
// const, so the tests can shorten it.
var sessionSaveEvery = 15 * time.Minute

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
	session  Session
	ttl      time.Duration
	expires  time.Time
	remember bool // "Mantenme conectado": the cookie carries a Max-Age
}

// sessionRow is one line of config/sessions.json.
type sessionRow struct {
	Hash     string `json:"hash"` // hex SHA-256 of the token
	User     string `json:"user"`
	Role     string `json:"role"`
	TTL      int64  `json:"ttl"`     // seconds
	Expires  int64  `json:"expires"` // unix seconds
	Remember bool   `json:"remember,omitempty"`
}

type sessionsFile struct {
	Sessions []sessionRow `json:"sessions"`
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
	byHash   map[string]*entry // keyed by tokenHash(token), never by the token
	fallback time.Duration     // TTL used when Create is given zero
	path     string            // config/sessions.json; "" keeps it all in memory
	log      Logger
	broken   bool      // the file could not be read: moved aside before the next save
	dirty    bool      // an expiry moved (or ran out) since the last save
	saved    time.Time // when the file was last written
}

// NewSessionStore builds the table, with the sessions a previous run left in
// configDir/sessions.json. An empty configDir keeps it in memory only.
//
// java: a map must be MADE before use. A nil map reads fine (returns the zero
// value) but panics on write - the one place Go's zero value is not ready to go.
func NewSessionStore(defaultTTL time.Duration, configDir string, log Logger) *SessionStore {
	s := &SessionStore{
		byHash:   make(map[string]*entry),
		fallback: defaultTTL,
		log:      log,
		saved:    time.Now(),
	}
	if configDir != "" {
		s.path = filepath.Join(configDir, "sessions.json")
		s.load()
	}
	return s
}

// Create mints a token for (user, role) and returns it. `remember` is only
// kept so that Remembered can say so later; the TTL is the caller's.
func (s *SessionStore) Create(user, role string, ttl time.Duration, remember bool) string {
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

	s.byHash[tokenHash(token)] = &entry{
		session:  Session{User: user, Role: role},
		ttl:      ttl,
		expires:  time.Now().Add(ttl),
		remember: remember,
	}
	s.save()
	return token
}

// lookup is the live entry behind a token, or nil. Caller holds mu.
func (s *SessionStore) lookup(token string) *entry {
	if token == "" {
		return nil
	}
	h := tokenHash(token)
	e, found := s.byHash[h]
	if !found {
		return nil
	}
	if time.Now().After(e.expires) {
		delete(s.byHash, h)
		s.dirty = true
		return nil
	}
	return e
}

// Get resolves a token, or reports that it is unknown or expired.
// Every hit slides the expiry forward.
//
// java: `(Session, bool)` is the Go answer to returning null. The caller writes
// `sess, ok := store.Get(tok); if !ok { ... }`. The compiler will not let you
// use `sess` without having received `ok`, so there is no accidental NPE.
func (s *SessionStore) Get(token string) (Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	e := s.lookup(token)
	if e == nil {
		return Session{}, false
	}
	e.expires = time.Now().Add(e.ttl) // sliding window
	s.dirty = true
	return e.session, true
}

// Remembered is the TTL of a live "Mantenme conectado" session, so its
// cookie's Max-Age can be counted again from now (apiWhoami). False for any
// other token.
func (s *SessionStore) Remembered(token string) (time.Duration, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	e := s.lookup(token)
	if e == nil || !e.remember {
		return 0, false
	}
	return e.ttl, true
}

// Drop forgets one token (sign-out).
//
// java: deleting a key that is not there is a no-op, not an exception.
func (s *SessionStore) Drop(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := tokenHash(token)
	if _, found := s.byHash[h]; found {
		delete(s.byHash, h)
		s.save()
	}
}

// DropUser kills every session belonging to `user` (used when an account is
// deleted, so an open tab cannot keep working).
//
// java: unlike Java's iterator, deleting from a Go map WHILE ranging over it is
// explicitly legal - no ConcurrentModificationException; the loop is enough.
func (s *SessionStore) DropUser(user string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	removed := false
	for h, e := range s.byHash {
		if e.session.User == user {
			delete(s.byHash, h)
			removed = true
		}
	}
	if removed {
		s.save()
	}
}

// Sweep drops expired sessions. The background worker calls this so closed
// browsers do not pile up forever - and it is also what brings the sliding
// expiries to the disk, at most every sessionSaveEvery.
func (s *SessionStore) Sweep() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	removed := 0
	for h, e := range s.byHash {
		if now.After(e.expires) {
			delete(s.byHash, h)
			removed++
		}
	}
	if removed > 0 || (s.dirty && now.Sub(s.saved) >= sessionSaveEvery) {
		s.save()
	}
	return removed
}

// Flush writes whatever has not reached the disk yet (Server.Close).
func (s *SessionStore) Flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dirty {
		s.save()
	}
}

// Count is here for the tests and the log line.
func (s *SessionStore) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.byHash)
}

// load fills the table from the file, leaving out what has expired meanwhile.
// A file that cannot be read signs everyone out - the old behaviour, never a
// crash - and is moved aside, not overwritten, by the next save.
func (s *SessionStore) load() {
	var file sessionsFile
	var ok bool
	if ok, s.broken = loadTable(s.path, &file, s.log, "everyone signs in again"); !ok {
		return
	}
	now := time.Now()
	for _, r := range file.Sessions {
		expires := time.Unix(r.Expires, 0)
		if len(r.Hash) != 64 || r.User == "" || (r.Role != "admin" && r.Role != "user") ||
			r.TTL <= 0 || !now.Before(expires) {
			continue
		}
		s.byHash[r.Hash] = &entry{
			session:  Session{User: r.User, Role: r.Role},
			ttl:      time.Duration(r.TTL) * time.Second,
			expires:  expires,
			remember: r.Remember,
		}
	}
}

// save writes the table. Caller holds mu. It never writes over a file that
// could not be read: that one is moved aside first (saveTable).
func (s *SessionStore) save() {
	if s.path == "" {
		s.dirty = false
		return
	}
	rows := make([]sessionRow, 0, len(s.byHash))
	for h, e := range s.byHash {
		rows = append(rows, sessionRow{
			Hash: h, User: e.session.User, Role: e.session.Role,
			TTL: int64(e.ttl / time.Second), Expires: e.expires.Unix(), Remember: e.remember,
		})
	}
	// java: map order is random in Go, on purpose. Sorted, the file only
	// changes where a session did.
	sort.Slice(rows, func(i, j int) bool { return rows[i].Hash < rows[j].Hash })
	if !saveTable(s.path, &s.broken, sessionsFile{Sessions: rows}, s.log) {
		return
	}
	// Best effort, as for vapid.json: hashes only, but nobody else's business.
	_ = os.Chmod(s.path, 0o600)
	s.dirty = false
	s.saved = time.Now()
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
// java: http.Cookie + http.SetCookie would be the idiomatic call. The header
// is built by hand so its attributes come out in one fixed order that the
// tests can read line by line; no browser cares either way.
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
