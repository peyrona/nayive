// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// /api/passkey/{what} - sign in with a passkey, beside the password.
// =============================================================================
//
//   POST login-begin              (no session) -> {nonce, challenge, rp_id}
//   POST login {nonce, id, client_data, auth_data, signature, user_handle, remember}
//                                 (no session) -> the same answer as /api/login
//   GET  keys                     this account's passkeys (names and dates only)
//   POST add-begin {password}     -> {challenge, rp_id, user_id, user_name, exclude}
//   POST add  a new passkey's answer (passkeyRegistration)
//   POST remove {password, id}
//
// NO NAME TYPED. The passkeys are "discoverable": the phone or PC lists its
// own Nayive passkeys, the person picks one, and the server finds the account
// by the passkey's id. The WebAuthn user id is a random value kept with the
// keys, never the account name.
//
// WHERE: a user's passkeys live in homes/<user>/data/passkeys.json (they move
// with a rename and go with a delete); the admin's in config/admin-passkeys.json.
//
// ADD AND REMOVE ASK THE PASSWORD: a session left open on someone's PC must
// not be enough to add a way into the account. The password stays the way
// in when the passkeys are lost.
//
// The checks themselves are the SSH tab's (confirm_passkey.go: checkAssertion,
// checkRegistration). Wrong tries go through the same throttle as the password.

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	loginNonceMax   = 1000 // login challenges waiting at once; more = refused
	loginPasskeyMax = 20   // passkeys per account
)

// loginKeys is one account's passkeys file.
type loginKeys struct {
	Handle string       `json:"user_handle"` // the WebAuthn user id, base64url
	Keys   []passkeyRec `json:"keys"`
}

type loginAdd struct {
	challenge []byte
	handle    string
	expires   time.Time
}

// LoginPasskeys holds the challenges in flight. The files are read when needed.
type LoginPasskeys struct {
	mu     sync.Mutex                // the challenges, and every read-change-write of a file
	nonces map[string]confirmPending // a login's challenge, by its nonce
	adds   map[string]loginAdd       // an add's challenge, by session token
	now    func() time.Time
}

func NewLoginPasskeys() *LoginPasskeys {
	return &LoginPasskeys{nonces: map[string]confirmPending{}, adds: map[string]loginAdd{}, now: time.Now}
}

// -- the files -----------------------------------------------------------------

func (s *Server) loginKeysPath(role, user string) string {
	if role == "admin" {
		return filepath.Join(s.cfg.ConfigDir, "admin-passkeys.json")
	}
	return filepath.Join(s.users.homeDir(user), "data", "passkeys.json")
}

// readLoginKeys: a missing file is no passkeys.
func readLoginKeys(path string) (loginKeys, error) {
	var lk loginKeys
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return lk, nil
	}
	if err != nil {
		return lk, err
	}
	err = json.Unmarshal(data, &lk)
	return lk, err
}

func writeLoginKeys(path string, lk loginKeys) error {
	if lk.Keys == nil {
		lk.Keys = []passkeyRec{}
	}
	data, err := json.MarshalIndent(lk, "", "    ")
	if err != nil {
		return err
	}
	return atomicWriteFile(path, append(data, '\n'), 0o600)
}

// adminName is the admin account's name, "" when there is none.
func (s *Server) adminName() string {
	var name string
	s.cfg.Read(func(c *ServerConfig) {
		if c.Admin != nil && c.Admin.Password != "" {
			name = c.Admin.Name
		}
	})
	return name
}

// findLoginKey finds the account that holds a passkey id: the admin first,
// then every user. Caller holds lp.mu.
func (s *Server) findLoginKey(id string) (role, user, path string, lk loginKeys, idx int) {
	look := func(r, u string) bool {
		p := s.loginKeysPath(r, u)
		got, err := readLoginKeys(p)
		if err != nil {
			return false
		}
		for i, k := range got.Keys {
			if k.ID == id {
				role, user, path, lk, idx = r, u, p, got, i
				return true
			}
		}
		return false
	}
	if a := s.adminName(); a != "" && look("admin", a) {
		return
	}
	for _, u := range s.users.ListUserNames() {
		if look("user", u) {
			return
		}
	}
	return "", "", "", loginKeys{}, -1
}

func hostOnly(r *http.Request) string {
	if h, _, err := net.SplitHostPort(r.Host); err == nil {
		return h
	}
	return r.Host
}

// -- the handler ---------------------------------------------------------------

func (s *Server) apiPasskey(w http.ResponseWriter, r *http.Request) {
	what := r.PathValue("what")
	lp := s.loginPK
	origin := requestOrigin(r)

	if r.Method == http.MethodGet && what == "keys" {
		sess, ok := s.requireSession(w, r)
		if !ok {
			return
		}
		lp.mu.Lock()
		lk, err := readLoginKeys(s.loginKeysPath(sess.Role, sess.User))
		lp.mu.Unlock()
		if err != nil {
			sendError(w, r, http.StatusInternalServerError, "can't read the passkeys")
			return
		}
		out := make([]factorInfo, 0, len(lk.Keys))
		for _, k := range lk.Keys {
			out = append(out, factorInfo{ID: k.ID, Kind: "passkey", Name: k.Name, Added: k.Added, Used: k.Used})
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"keys": out})
		return
	}
	if r.Method != http.MethodPost {
		sendError(w, r, http.StatusNotFound, "no such endpoint")
		return
	}
	if r.Header.Get("Origin") != origin {
		sendError(w, r, http.StatusForbidden, "wrong origin")
		return
	}
	var body struct {
		passkeyRegistration
		Nonce      string `json:"nonce"`
		Signature  string `json:"signature"`
		UserHandle string `json:"user_handle"`
		Remember   bool   `json:"remember"`
		Password   string `json:"password"`
	}
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}

	switch what {
	case "login-begin":
		lp.mu.Lock()
		now := lp.now()
		for n, c := range lp.nonces {
			if now.After(c.expires) {
				delete(lp.nonces, n)
			}
		}
		if len(lp.nonces) >= loginNonceMax {
			lp.mu.Unlock()
			sendError(w, r, http.StatusTooManyRequests, "busy - try again in a minute")
			return
		}
		nonce, ch := b64u(randomBytes(24)), randomBytes(32)
		lp.nonces[nonce] = confirmPending{value: ch, kind: "get", expires: now.Add(confirmChallengeTTL)}
		lp.mu.Unlock()
		sendJSON(w, r, http.StatusOK, map[string]string{"nonce": nonce, "challenge": b64u(ch), "rp_id": hostOnly(r)})

	case "login":
		s.passkeyLogin(w, r, origin, body.Nonce, body.UserHandle, body.Remember, passkeyAssertion{
			ID: body.ID, ClientData: body.ClientData, AuthData: body.AuthData, Signature: body.Signature,
		})

	case "add-begin", "add", "remove":
		sess, ok := s.requireSession(w, r)
		if !ok {
			return
		}
		token := tokenFrom(r)
		path := s.loginKeysPath(sess.Role, sess.User)
		if what != "add" && !s.checkOwnPassword(w, r, sess, body.Password, http.StatusForbidden, "wrong password") {
			return
		}
		lp.mu.Lock()
		defer lp.mu.Unlock()
		lk, err := readLoginKeys(path)
		if err != nil {
			sendError(w, r, http.StatusInternalServerError, "can't read the passkeys")
			return
		}
		switch what {
		case "add-begin":
			if len(lk.Keys) >= loginPasskeyMax {
				sendError(w, r, http.StatusBadRequest, "too many passkeys - remove one first")
				return
			}
			handle := lk.Handle
			if handle == "" {
				handle = b64u(randomBytes(16))
			}
			ch := randomBytes(32)
			lp.adds[token] = loginAdd{challenge: ch, handle: handle, expires: lp.now().Add(confirmChallengeTTL)}
			exclude := []string{}
			for _, k := range lk.Keys {
				exclude = append(exclude, k.ID)
			}
			sendJSON(w, r, http.StatusOK, map[string]any{
				"challenge": b64u(ch), "rp_id": hostOnly(r), "user_id": handle,
				"user_name": sess.User, "exclude": exclude,
			})

		case "add":
			pend, ok := lp.adds[token]
			delete(lp.adds, token)
			if !ok || lp.now().After(pend.expires) {
				sendError(w, r, http.StatusBadRequest, "Too slow - try again.")
				return
			}
			rec, err := checkRegistration(origin, pend.challenge, body.passkeyRegistration)
			if err != nil {
				sendError(w, r, http.StatusBadRequest, err.Error())
				return
			}
			for _, k := range lk.Keys {
				if k.ID == rec.ID {
					sendError(w, r, http.StatusBadRequest, "This passkey is registered already.")
					return
				}
			}
			if lk.Handle == "" {
				lk.Handle = pend.handle
			}
			rec.Added = lp.now().UTC().Format(time.RFC3339)
			lk.Keys = append(lk.Keys, rec)
			if err := writeLoginKeys(path, lk); err != nil {
				sendError(w, r, http.StatusInternalServerError, "can't save the passkey")
				return
			}
			sendJSON(w, r, http.StatusOK, map[string]bool{"ok": true})

		case "remove":
			keep := lk.Keys[:0]
			for _, k := range lk.Keys {
				if k.ID != body.ID {
					keep = append(keep, k)
				}
			}
			if len(keep) == len(lk.Keys) {
				sendError(w, r, http.StatusNotFound, "No such passkey.")
				return
			}
			lk.Keys = keep
			if err := writeLoginKeys(path, lk); err != nil {
				sendError(w, r, http.StatusInternalServerError, "can't save the passkeys")
				return
			}
			sendJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
		}

	default:
		sendError(w, r, http.StatusNotFound, "unknown")
	}
}

// passkeyLogin checks a login answer and, when it is good, signs the person in.
func (s *Server) passkeyLogin(w http.ResponseWriter, r *http.Request, origin, nonce, handle string,
	remember bool, a passkeyAssertion) {
	lp := s.loginPK
	id := strings.TrimRight(a.ID, "=")

	// The same throttle as a password: per passkey (its "name") and per address.
	unlock := s.authThrottle("\x00passkey:"+id, r)
	refuse := func(msg string) {
		time.Sleep(authFailDelay)
		unlock()
		sendError(w, r, http.StatusUnauthorized, msg)
	}

	lp.mu.Lock()
	pend, ok := lp.nonces[nonce]
	delete(lp.nonces, nonce)
	if !ok || lp.now().After(pend.expires) {
		lp.mu.Unlock()
		unlock()
		sendError(w, r, http.StatusBadRequest, "Too slow - try again.")
		return
	}
	cd, err1 := b64uDec(a.ClientData)
	ad, err2 := b64uDec(a.AuthData)
	sig, err3 := b64uDec(a.Signature)
	if err1 != nil || err2 != nil || err3 != nil || id == "" {
		lp.mu.Unlock()
		refuse("Bad passkey answer.")
		return
	}
	role, user, path, lk, idx := s.findLoginKey(id)
	if idx < 0 {
		lp.mu.Unlock()
		refuse("This passkey is not registered here (removed?). Sign in with your password.")
		return
	}
	if handle != "" && strings.TrimRight(handle, "=") != lk.Handle {
		lp.mu.Unlock()
		refuse("Passkey refused: wrong account.")
		return
	}
	k := &lk.Keys[idx]
	count, err := checkAssertion(*k, origin, pend.value, cd, ad, sig)
	if err != nil {
		lp.mu.Unlock()
		refuse(err.Error())
		return
	}
	k.Count = count
	k.Used = lp.now().UTC().Format(time.RFC3339)
	err = writeLoginKeys(path, lk) // the counter must stick, or a copied key could follow
	lp.mu.Unlock()
	unlock()
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "can't save the passkey")
		return
	}

	s.signIn(w, r, user, role, remember, "passkey")
	out := map[string]any{"user": user, "role": role}
	if s.users.NeedsPassword(role, user) {
		out["must_set_password"] = true
	}
	sendJSON(w, r, http.StatusOK, out)
}
