package main

// =============================================================================
// /api/login  /api/logout  /api/whoami  /api/password  /api/lang  /api/tz
// =============================================================================
//
// Everything about who you are and what this account has chosen. The file API
// and the admin panel live next door.

import (
	"net/http"
	"strings"
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

	// java: the mutex is held ACROSS the sleep on purpose. Releasing it first
	// would let 250 guesses run in parallel and each just wait its own 0.4 s,
	// which throttles nobody. See Server.authMu.
	s.authMu.Lock()
	role := s.users.Authenticate(user, creds.Password)
	if role == "" {
		time.Sleep(authFailDelay)
		s.authMu.Unlock()
		sendError(w, r, http.StatusUnauthorized, "usuario o contraseña incorrectos")
		return
	}
	s.authMu.Unlock()

	if role == "user" { // make sure data/ and files/ exist
		s.ensureHome(user)
	}

	ttl := s.cfg.SessionTTL
	if creds.Remember {
		ttl = s.cfg.RememberTTL
	}
	token := s.sessions.Create(user, role, ttl)
	// r.TLS is nil on a plain HTTP connection - that is the "is this secure?"
	// test, and it decides whether the cookie gets "; Secure".
	w.Header().Set("Set-Cookie", sessionCookieHeader(token, ttl, creds.Remember, r.TLS != nil))

	s.log.Info("login ok", "user", user, "role", role, "remember", creds.Remember)

	body := map[string]any{"user": user, "role": role}
	if s.users.NeedsPassword(role, user) {
		body["must_set_password"] = true
	}
	sendJSON(w, r, http.StatusOK, body)
}

// apiLogout drops the session, clears the cookie and sends the browser to the
// login page.
func (s *Server) apiLogout(w http.ResponseWriter, r *http.Request) {
	s.sessions.Drop(tokenFrom(r))
	w.Header().Set("Set-Cookie", clearCookieHeader())
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

	sendJSON(w, r, http.StatusOK, me)
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

	s.authMu.Lock() // the same server-wide throttle as login
	good := s.users.Authenticate(sess.User, body.Current) == sess.Role
	if !good {
		time.Sleep(authFailDelay)
		s.authMu.Unlock()
		sendError(w, r, http.StatusUnauthorized, "la contraseña actual no es correcta")
		return
	}
	s.authMu.Unlock()

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
	// request so the person who just changed it stays signed in here. A
	// "remember me" cookie degrades to a session cookie - acceptable.
	s.sessions.DropUser(sess.User)
	token := s.sessions.Create(sess.User, sess.Role, s.cfg.SessionTTL)
	w.Header().Set("Set-Cookie", sessionCookieHeader(token, s.cfg.SessionTTL, false, r.TLS != nil))

	s.log.Info("password changed", "user", sess.User, "role", sess.Role)
	sendJSON(w, r, http.StatusOK, map[string]string{"message": "contraseña actualizada"})
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
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		sendJSON(w, r, http.StatusOK,
			map[string]any{"lang": s.users.UserLang(sess.Role, sess.User)})
	case http.MethodPost:
		stored, good := s.users.SetUserLang(sess.Role, sess.User, queryValue(r, "value"))
		if !good {
			sendError(w, r, http.StatusBadRequest, "idioma no válido")
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"lang": stored})
	default:
		sendError(w, r, http.StatusMethodNotAllowed, "use GET or POST")
	}
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
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		sendJSON(w, r, http.StatusOK,
			map[string]any{"tz": s.users.UserTZ(sess.Role, sess.User)})
	case http.MethodPost:
		stored, good := s.users.SetUserTZ(sess.Role, sess.User, queryValue(r, "value"))
		if !good {
			sendError(w, r, http.StatusBadRequest, "zona horaria no válida")
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"tz": stored})
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

// ensureHome creates data/ and files/ for a user signing in.
func (s *Server) ensureHome(user string) {
	for _, sub := range []string{"data", "files"} {
		mkdirAll(s.users.homeDir(user), sub)
	}
}
