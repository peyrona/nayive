package main

// =============================================================================
// /api/login  /api/logout  /api/whoami  /api/password  /api/lang  /api/tz
// =============================================================================
//
// Everything about who you are and what this account has chosen. The file API
// and the admin panel live next door.

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// loginRequest is the JSON body of POST /api/login. The same fields arrive
// form-encoded from the plain HTML fallback form.
type loginRequest struct {
	User     string `json:"user"`
	Password string `json:"password"`
	Remember bool   `json:"remember"`
}

// apiLogin checks a name and password and sets the session cookie.
func (s *Server) apiLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendError(w, r, http.StatusNotFound, "no such endpoint")
		return
	}

	// The size check goes BEFORE the Content-Type branch, which is where
	// _api_login has it: its first line is `raw = self._body()`, so the FORM
	// fallback is capped too. Leaving it to readJSON alone let a 1 MB form body
	// through and signed the person in.
	if err := refuseOversizedBody(w, r); err != nil {
		sendBodyError(w, r, err)
		return
	}

	var creds loginRequest
	ctype := strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0])
	// A plain form post is the login page with no JavaScript: a browser
	// NAVIGATES there, so it gets a page to go on to, never raw JSON.
	isForm := strings.EqualFold(ctype, "application/x-www-form-urlencoded")

	if ctype == "application/json" {
		if err := readJSON(w, r, &creds); err != nil {
			sendBodyError(w, r, err)
			return
		}
	} else {
		// The login page's <form> fallback, for a browser with no JavaScript.
		if err := r.ParseForm(); err != nil {
			sendError(w, r, http.StatusBadRequest, "bad form")
			return
		}
		creds.User = r.PostFormValue("user")
		creds.Password = r.PostFormValue("password")
		creds.Remember = contains([]string{"on", "true", "1"}, r.PostFormValue("remember"))
	}

	// Normalise BEFORE authenticating: the session, the home folder and the
	// stored account name all have to be the same string, and the person typing
	// their name into the login box has no idea which of the two spellings of
	// "José" their keyboard just produced. See NormaliseUsername.
	user := NormaliseUsername(creds.User)

	// java: the locks are held ACROSS the sleep on purpose. Releasing them
	// first would let 250 guesses run in parallel and each just wait its own
	// 0.4 s, which throttles nobody. See Server.authLocks.
	unlock := s.authThrottle(user, r)
	role := s.users.Authenticate(user, creds.Password)
	if role == "" {
		time.Sleep(authFailDelay)
		unlock()
		if isForm {
			redirect(w, http.StatusSeeOther, URLPrefix+"/login.html") // try again
			return
		}
		sendError(w, r, http.StatusUnauthorized, "usuario o contraseña incorrectos")
		return
	}
	unlock()

	if role == "user" { // make sure data/ and files/ exist
		s.ensureHome(user)
	}

	ttl := s.cfg.SessionTTL
	if creds.Remember {
		ttl = s.cfg.RememberTTL
	}
	token := s.sessions.Create(user, role, ttl, creds.Remember)
	// r.TLS is nil on a plain HTTP connection - that is the "is this secure?"
	// test, and it decides whether the cookie gets "; Secure".
	w.Header().Set("Set-Cookie", sessionCookieHeader(token, ttl, creds.Remember, r.TLS != nil))
	w.Header().Add("Set-Cookie", whoCookieHeader(role, user, ttl, creds.Remember, r.TLS != nil))
	s.setWasCookie(w, r, role, user, ttl, creds.Remember)

	s.log.Info("login ok", "user", user, "role", role, "remember", creds.Remember)

	if isForm { // where login.html's script goes (its returnTo)
		if role == "admin" {
			redirect(w, http.StatusSeeOther, URLPrefix+"/admin.html")
		} else {
			redirect(w, http.StatusSeeOther, URLPrefix+"/")
		}
		return
	}
	body := map[string]any{"user": user, "role": role}
	if s.users.NeedsPassword(role, user) {
		body["must_set_password"] = true
	}
	sendJSON(w, r, http.StatusOK, body)
}

// apiLogout drops the session, clears the cookie and sends the browser to the
// login page. POST only: a GET that signs out could be fired by anything a
// page loads - a picture in an email, a link on another site (the cookie is
// SameSite=Lax, which lets top-level GETs through). A GET (an old launcher
// still in a phone's cache, a bookmark) only goes to the launcher, signed in
// as before: its button signs out.
func (s *Server) apiLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		redirect(w, http.StatusSeeOther, URLPrefix+"/")
		return
	}
	s.sessions.Drop(tokenFrom(r))
	w.Header().Set("Set-Cookie", clearCookieHeader())
	w.Header().Add("Set-Cookie", clearWhoCookieHeader())
	w.Header().Add("Set-Cookie", clearWasCookieHeader())
	redirect(w, http.StatusFound, URLPrefix+"/login.html")
}

// apiWhoami reports who the cookie belongs to, plus the four per-account
// settings the launcher needs on every page load.
func (s *Server) apiWhoami(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}

	me := map[string]any{"user": sess.User, "role": sess.Role}
	if s.users.NeedsPassword(sess.Role, sess.User) {
		me["must_set_password"] = true
	}
	// The browser shrinks photos before uploading them; this is the only place
	// it learns the limit. null / absent = no limit.
	if sess.Role == "admin" {
		me["photo_max"] = nil
	} else {
		me["photo_max"] = s.users.UserPhotoMax(sess.User)
	}
	// The interface language and timezone this ACCOUNT chose, so they follow
	// the person to every device. null = never chosen: the browser keeps
	// deciding, exactly as before these settings existed.
	me["lang"] = s.users.UserLang(sess.Role, sess.User)
	me["tz"] = s.users.UserTZ(sess.Role, sess.User)

	// A "Mantenme conectado" cookie's Max-Age counts from the sign-in, while
	// the session behind it slides with every request: re-issue the cookie
	// here - every page asks this on load - so a phone in daily use is never
	// signed out on day 30.
	ttl, remembered := s.sessions.Remembered(tokenFrom(r))
	if remembered {
		w.Header().Set("Set-Cookie", sessionCookieHeader(tokenFrom(r), ttl, true, r.TLS != nil))
	}
	// Who this browser belongs to, for shared/store.js (store_owner.go) - set
	// here too so a session from before that cookie existed gets it, and an
	// admin rename puts the new name in it.
	w.Header().Add("Set-Cookie", whoCookieHeader(sess.Role, sess.User, ttl, remembered, r.TLS != nil))
	// ...and the names an admin rename took from it, whose saves a browser may
	// still hold (L3, store_owner.go).
	if from := s.setWasCookie(w, r, sess.Role, sess.User, ttl, remembered); len(from) > 0 {
		was := []string{}
		for _, old := range from {
			was = append(was, whoValue("user", old))
		}
		me["renamed"] = map[string]any{"who": whoValue(sess.Role, sess.User), "from": was}
	}

	sendJSON(w, r, http.StatusOK, me)
}

// setWasCookie sets the nayive_was cookie (store_owner.go) beside nayive_who,
// or clears one the browser holds when the account has no old names - an
// admin's, or one whose old name went to a new person since. It answers the
// old names.
func (s *Server) setWasCookie(w http.ResponseWriter, r *http.Request, role, user string,
	ttl time.Duration, remember bool) []string {

	var from []string
	if role == "user" {
		from = s.users.RenamedFrom(user)
	}
	if len(from) > 0 {
		w.Header().Add("Set-Cookie", wasCookieHeader(wasValue(user, from), ttl, remember, r.TLS != nil))
	} else if _, err := r.Cookie(WasCookieName); err == nil {
		w.Header().Add("Set-Cookie", clearWasCookieHeader())
	}
	return from
}

// passwordFreeAPI are the only API routes an account with NO password yet may
// use: what the launcher's "pick a password" dialog needs (who am I, set it,
// the language and zone rows it shows). /api/login and /api/logout never ask
// for a session at all. Public links, chat guests, location reports and the
// Android app's assetlinks have no session either, so nothing here touches them.
var passwordFreeAPI = map[string]bool{
	"/api/whoami":   true,
	"/api/password": true,
	"/api/lang":     true,
	"/api/tz":       true,
	"/api/unlock":   true,
}

// mustSetPasswordFirst answers 403 {"error", "must_set_password": true} and
// reports true when `sess` is an account with no password yet asking for any
// other API: a blank sign-in reaches nothing (files, chat, phones, positions)
// until a password is set - for an account the admin just made, or one whose
// password the admin removed. Checked live, so the moment the password is
// saved (here or in the admin panel) everything opens.
func (s *Server) mustSetPasswordFirst(w http.ResponseWriter, r *http.Request, sess Session) bool {
	if sess.Role != "user" || passwordFreeAPI[r.URL.Path] || signOutUnlink(r) ||
		!s.users.NeedsPassword(sess.Role, sess.User) {
		return false
	}
	sendJSON(w, r, http.StatusForbidden, map[string]any{
		"error":             "primero elige una contraseña",
		"must_set_password": true,
	})
	return true
}

// signOutUnlink: the launcher's sign-out drops this browser's push subscription
// and unlinks this phone (DELETE /api/push, DELETE /api/device/<id>). Taking
// things away needs no password - refusing it left a phone linked to the account.
func signOutUnlink(r *http.Request) bool {
	return r.Method == http.MethodDelete &&
		(r.URL.Path == "/api/push" || strings.HasPrefix(r.URL.Path, "/api/device/"))
}

// passwordRequest is the body of POST /api/password.
type passwordRequest struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

// apiPassword lets the signed-in user change their own password.
func (s *Server) apiPassword(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		sendError(w, r, http.StatusMethodNotAllowed, "use POST")
		return
	}

	var body passwordRequest
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}

	unlock := s.authThrottle(sess.User, r) // the same throttle as login
	good := s.users.Authenticate(sess.User, body.Current) == sess.Role
	if !good {
		time.Sleep(authFailDelay)
		unlock()
		sendError(w, r, http.StatusUnauthorized, "la contraseña actual no es correcta")
		return
	}
	unlock()

	if len([]rune(body.New)) < 4 {
		sendError(w, r, http.StatusBadRequest,
			"la nueva contraseña debe tener al menos 4 caracteres")
		return
	}
	if !s.users.SetPassword(sess.Role, sess.User, body.New) {
		sendError(w, r, http.StatusInternalServerError, "no se pudo cambiar la contraseña")
		return
	}

	// A new password makes every existing session for this account stale: kill
	// them all (other devices, a possible intruder), then re-issue one for THIS
	// request so the person who just changed it stays signed in here - for as
	// long as before: a "Mantenme conectado" session stays one (a phone must not
	// ask for the new password again the next day).
	ttl, remember := s.sessions.Remembered(tokenFrom(r))
	if !remember {
		ttl = s.cfg.SessionTTL
	}
	s.sessions.DropUser(sess.User)
	token := s.sessions.Create(sess.User, sess.Role, ttl, remember)
	w.Header().Set("Set-Cookie", sessionCookieHeader(token, ttl, remember, r.TLS != nil))

	s.log.Info("password changed", "user", sess.User, "role", sess.Role)
	sendJSON(w, r, http.StatusOK, map[string]string{"message": "contraseña actualizada"})
}

// errAccountDamaged is the answer to a change of a setting kept in a
// config.json that cannot be read or parsed (Users.ConfigDamaged).
const errAccountDamaged = "no se pudo guardar: el archivo de tu cuenta está dañado (avisa al administrador)"

// unlockRequest is the body of POST /api/unlock.
type unlockRequest struct {
	Password string `json:"password"`
}

// apiUnlock checks the signed-in user's password for the screen locker
// (shared/locker.js). Nothing changes on the server: the lock lives in the
// browser, and this only says whether the password is right.
//
//	200 = right password     401 = no session (go to the login page)
//	403 = wrong password
func (s *Server) apiUnlock(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		sendError(w, r, http.StatusMethodNotAllowed, "use POST")
		return
	}

	var body unlockRequest
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}

	unlock := s.authThrottle(sess.User, r) // the same throttle as login
	good := s.users.Authenticate(sess.User, body.Password) == sess.Role
	if !good {
		time.Sleep(authFailDelay)
		unlock()
		sendError(w, r, http.StatusForbidden, "contraseña incorrecta")
		return
	}
	unlock()
	sendJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
}

// apiLang is the interface language of the signed-in ACCOUNT.
//
//	GET            -> {"lang": "es" | "" | null}
//	POST ?value=es -> {"lang": "es"}   (?value= stores "por defecto")
//
// null means the account never chose one and each device follows its own
// browser - which is also what "" means, the difference being that "" was asked
// for. Unknown codes are REFUSED rather than silently ignored: the browser must
// be able to tell a saved choice from a lost one, or it would show the new
// language and quietly revert on the next reload.
func (s *Server) apiLang(w http.ResponseWriter, r *http.Request) {
	s.accountSetting(w, r, "lang", "idioma no válido", s.users.UserLang, s.users.SetUserLang)
}

// apiTZ is the timezone of the signed-in ACCOUNT.
//
//	GET                       -> {"tz": "Europe/Madrid" | null}
//	POST ?value=Europe/Madrid -> {"tz": "Europe/Madrid"}   (?value= clears it)
//
// A timezone belongs to the PERSON, not to the server: it decides what a
// floating "10:00" in their calendar means (ics.go) and which clock a reminder
// prints (reminders.go). Unknown zone names are refused for the same reason
// unknown languages are.
func (s *Server) apiTZ(w http.ResponseWriter, r *http.Request) {
	s.accountSetting(w, r, "tz", "zona horaria no válida", s.users.UserTZ, s.users.SetUserTZ)
}

// accountSetting is apiLang and apiTZ: one per-account setting, read with GET
// ({key: value | null}) and stored with POST ?value= ({key: stored}). A value
// `set` refuses answers 400 `bad` - unless the refusal is a damaged
// config.json, which is never written over (F1): 500, and the log names it.
func (s *Server) accountSetting(w http.ResponseWriter, r *http.Request, key, bad string,
	get func(role, user string) *string, set func(role, user, value string) (string, bool)) {

	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		sendJSON(w, r, http.StatusOK, map[string]any{key: get(sess.Role, sess.User)})
	case http.MethodPost:
		stored, good := set(sess.Role, sess.User, queryValue(r, "value"))
		if !good && sess.Role == "user" && s.users.ConfigDamaged(sess.User) {
			sendError(w, r, http.StatusInternalServerError, errAccountDamaged)
			return
		}
		if !good {
			sendError(w, r, http.StatusBadRequest, bad)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{key: stored})
	default:
		sendError(w, r, http.StatusMethodNotAllowed, "use GET or POST")
	}
}

// apiUsers is GET /api/users -> {"users": [...]}: every OTHER regular user's
// name, for the share picker.
//
// A regular user cannot use /api/admin, so without this there is no way to
// offer "share with...". Names only: no quota, no usage, no password, and no
// walk of anyone's disk.
func (s *Server) apiUsers(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		sendError(w, r, http.StatusMethodNotAllowed, "use GET")
		return
	}
	others := []string{}
	for _, n := range s.users.ListUserNames() {
		if n != sess.User {
			others = append(others, n)
		}
	}
	sendJSON(w, r, http.StatusOK, map[string][]string{"users": others})
}

// ensureHome creates data/ and files/ for a user signing in - inside the home,
// never the home itself: a sign-in whose password check ran just before the
// admin renamed or deleted the account would bring homes/<old name>/ back as
// a ghost, and its session would then save there (L2). os.Mkdir, not
// MkdirAll, is that rule; "already there" is the usual answer.
func (s *Server) ensureHome(user string) {
	for _, sub := range []string{"data", "files"} {
		os.Mkdir(filepath.Join(s.users.homeDir(user), sub), 0o755)
	}
}

// authThrottle takes the credential-check locks for account `name` and for
// the request's client address, and returns what releases both. The name lock
// always comes first: two checks can then never each hold the lock the other
// is waiting for.
func (s *Server) authThrottle(name string, r *http.Request) (unlock func()) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	byName := s.authLocks.Lock("name:" + name)
	byAddr := s.authLocks.Lock("addr:" + addrKey(host)) // an IPv6 client: its /64
	return func() {
		byAddr()
		byName()
	}
}

// keyedMutex is one mutex per key, made when first wanted and dropped when
// nobody holds or waits for it: the keys are names and addresses an attacker
// chooses, so keeping them all would be a leak of its own.
//
// java: a ConcurrentHashMap<String, ReentrantLock> with a reference count, so
// the entry can be removed the moment its last user lets go.
type keyedMutex struct {
	mu    sync.Mutex
	locks map[string]*keyedLock
}

type keyedLock struct {
	sync.Mutex
	users int // holding it, or waiting for it
}

// Lock blocks until `key` is free, takes it, and returns what releases it.
func (k *keyedMutex) Lock(key string) (unlock func()) {
	k.mu.Lock()
	if k.locks == nil {
		k.locks = make(map[string]*keyedLock)
	}
	l := k.locks[key]
	if l == nil {
		l = &keyedLock{}
		k.locks[key] = l
	}
	l.users++
	k.mu.Unlock()

	l.Lock()
	return func() {
		l.Unlock()
		k.mu.Lock()
		if l.users--; l.users == 0 {
			delete(k.locks, key)
		}
		k.mu.Unlock()
	}
}
