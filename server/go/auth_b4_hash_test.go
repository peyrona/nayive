package main

// =============================================================================
// Batch 4 part 3: passwords hashed at the next good sign-in (server-go #10),
// and an account with no password reaches no API but the few its "pick a
// password" dialog needs (cross #12).
// =============================================================================

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func storedUserPassword(t *testing.T, srv *Server, user string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(srv.cfg.HomesDir, user, "data", "config.json"))
	if err != nil {
		t.Fatalf("read %s's config: %v", user, err)
	}
	var c map[string]any
	json.Unmarshal(raw, &c)
	pw, _ := c["password"].(string)
	return pw
}

func storedAdminPassword(t *testing.T, srv *Server) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(srv.cfg.ConfigDir, "server.json"))
	if err != nil {
		t.Fatalf("read server.json: %v", err)
	}
	var c struct{ Admin AdminAccount }
	json.Unmarshal(raw, &c)
	return c.Admin.Password
}

func loginCode(t *testing.T, base, user, password string) int {
	t.Helper()
	resp := do(t, noFollow(), "POST", base+"/api/login",
		strings.NewReader(`{"user":"`+user+`","password":"`+password+`"}`),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	return resp.StatusCode
}

// TestB4HashAtNextLogin: a plaintext password (user and admin) signs in, the
// file then holds a hash, the same password signs in again, a wrong one fails.
func TestB4HashAtNextLogin(t *testing.T) {
	srv, ts, _ := newTestServer(t)

	for _, c := range []struct {
		user, pw string
		stored   func() string
	}{
		{"ana", "abc", func() string { return storedUserPassword(t, srv, "ana") }},
		{"jefe", "secreto", func() string { return storedAdminPassword(t, srv) }},
	} {
		if got := c.stored(); got != c.pw {
			t.Fatalf("%s: fixture not plaintext: %q", c.user, got)
		}
		if code := loginCode(t, ts.URL, c.user, c.pw); code != http.StatusOK {
			t.Fatalf("%s: plaintext login = %d", c.user, code)
		}
		hashed := c.stored()
		if !isHashedPassword(hashed) || strings.Contains(hashed, c.pw) {
			t.Fatalf("%s: stored after login = %q, want a hash", c.user, hashed)
		}
		if code := loginCode(t, ts.URL, c.user, c.pw); code != http.StatusOK {
			t.Errorf("%s: login on the hash = %d", c.user, code)
		}
		if c.stored() != hashed {
			t.Errorf("%s: a hashed password was rewritten on a second login", c.user)
		}
		if code := loginCode(t, ts.URL, c.user, c.pw+"x"); code != http.StatusUnauthorized {
			t.Errorf("%s: wrong password = %d, want 401", c.user, code)
		}
		if code := loginCode(t, ts.URL, c.user, ""); code != http.StatusUnauthorized {
			t.Errorf("%s: blank password on a hashed account = %d, want 401", c.user, code)
		}
	}
}

// TestB4StoresHashed: every writer stores a hash - the user's own change, the
// admin creating / updating a user, set-admin; a blank set-admin keeps it.
func TestB4StoresHashed(t *testing.T) {
	srv, ts, client := newTestServer(t)

	signIn(t, client, ts.URL, "ana", "abc")
	resp := do(t, client, "POST", ts.URL+"/api/password",
		strings.NewReader(`{"current":"abc","new":"nueva1"}`), map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("change password = %d", resp.StatusCode)
	}
	if pw := storedUserPassword(t, srv, "ana"); !isHashedPassword(pw) {
		t.Errorf("after a change: %q", pw)
	}
	if loginCode(t, ts.URL, "ana", "nueva1") != http.StatusOK || loginCode(t, ts.URL, "ana", "abc") != http.StatusUnauthorized {
		t.Error("the changed password does not sign in, or the old one still does")
	}

	admin := noFollow()
	signIn(t, admin, ts.URL, "jefe", "secreto")
	if code := postAdmin(t, admin, ts.URL, `{"action":"create-user","name":"carla","password":"clave1"}`); code != http.StatusOK {
		t.Fatalf("create-user = %d", code)
	}
	if pw := storedUserPassword(t, srv, "carla"); !isHashedPassword(pw) || loginCode(t, ts.URL, "carla", "clave1") != http.StatusOK {
		t.Errorf("created user: %q", pw)
	}
	if code := postAdmin(t, admin, ts.URL, `{"action":"update-user","name":"beto","password":"otra1"}`); code != http.StatusOK {
		t.Fatalf("update-user = %d", code)
	}
	if pw := storedUserPassword(t, srv, "beto"); !isHashedPassword(pw) || loginCode(t, ts.URL, "beto", "otra1") != http.StatusOK {
		t.Errorf("updated user: %q", pw)
	}

	before := storedAdminPassword(t, srv) // hashed by the sign-in above
	if code := postAdmin(t, admin, ts.URL, `{"action":"set-admin","name":"jefe","password":""}`); code != http.StatusOK {
		t.Fatalf("set-admin blank = %d", code)
	}
	if got := storedAdminPassword(t, srv); got != before || loginCode(t, ts.URL, "jefe", "secreto") != http.StatusOK {
		t.Errorf("a blank set-admin changed the password: %q -> %q", before, got)
	}
	if code := postAdmin(t, admin, ts.URL, `{"action":"set-admin","name":"jefe","password":"nuevo9"}`); code != http.StatusOK {
		t.Fatalf("set-admin = %d", code)
	}
	if pw := storedAdminPassword(t, srv); !isHashedPassword(pw) || loginCode(t, ts.URL, "jefe", "nuevo9") != http.StatusOK {
		t.Errorf("set-admin stored %q", pw)
	}
}

// TestB4AdminPasswordChangeHashed: the admin's own change (/api/password).
func TestB4AdminPasswordChangeHashed(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "jefe", "secreto")
	resp := do(t, client, "POST", ts.URL+"/api/password",
		strings.NewReader(`{"current":"secreto","new":"otro77"}`), map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("admin change = %d", resp.StatusCode)
	}
	if pw := storedAdminPassword(t, srv); !isHashedPassword(pw) || loginCode(t, ts.URL, "jefe", "otro77") != http.StatusOK {
		t.Errorf("admin stored %q", pw)
	}
}

// TestB4CheckPassword: the two shapes, a damaged hash, and an older count.
func TestB4CheckPassword(t *testing.T) {
	h := hashPassword("pw")
	if ok, re := checkPassword("pw", h); !ok || re {
		t.Errorf("fresh hash: ok=%v rehash=%v", ok, re)
	}
	if ok, _ := checkPassword("PW", h); ok {
		t.Error("wrong case matched")
	}
	if ok, re := checkPassword("pw", "pw"); !ok || !re {
		t.Errorf("plaintext: ok=%v rehash=%v", ok, re)
	}
	if ok, _ := checkPassword("", ""); ok {
		t.Error("blank matched blank")
	}
	for _, bad := range []string{pwHashPrefix, pwHashPrefix + "x$y$z", pwHashPrefix + "1000$@@$@@", h[:len(h)-3] + "$"} {
		if ok, _ := checkPassword("pw", bad); ok {
			t.Errorf("damaged %q matched", bad)
		}
	}
	if hashPassword("") != "" || hashPassword("pw") == h {
		t.Error("blank must stay blank, and two hashes of one password must differ (salt)")
	}
	// A hash with fewer iterations than today's still opens, and asks to be redone.
	salt := []byte("0123456789abcdef")
	key, _ := pbkdf2.Key(sha256.New, "pw", salt, 1000, 32)
	enc := base64.RawURLEncoding
	old := pwHashPrefix + strconv.Itoa(1000) + "$" + enc.EncodeToString(salt) + "$" + enc.EncodeToString(key)
	if ok, re := checkPassword("pw", old); !ok || !re {
		t.Errorf("older count: ok=%v rehash=%v", ok, re)
	}
}

// TestB4MustSetPasswordGate: a blank account signs in with "" and gets only
// whoami / password / lang / tz until it picks a password; then everything
// opens, the password is stored hashed and "" no longer signs in.
func TestB4MustSetPasswordGate(t *testing.T) {
	srv, ts, client := newTestServer(t)
	home := filepath.Join(srv.cfg.HomesDir, "nuevo")
	os.MkdirAll(filepath.Join(home, "data"), 0o755)
	os.MkdirAll(filepath.Join(home, "files"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "config.json"), []byte(`{"password":""}`), 0o644)

	resp := do(t, client, "POST", ts.URL+"/api/login",
		strings.NewReader(`{"user":"nuevo","password":""}`), map[string]string{"Content-Type": "application/json"})
	var in map[string]any
	json.NewDecoder(resp.Body).Decode(&in)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || in["must_set_password"] != true {
		t.Fatalf("blank login = %d %v", resp.StatusCode, in)
	}

	get := func(path string) (int, map[string]any) {
		resp := do(t, client, "GET", ts.URL+path, nil, nil)
		defer resp.Body.Close()
		var body map[string]any
		json.NewDecoder(resp.Body).Decode(&body)
		return resp.StatusCode, body
	}
	for _, p := range []string{"/api/whoami", "/api/lang", "/api/tz"} {
		if code, _ := get(p); code != http.StatusOK {
			t.Errorf("%s while blank = %d, want 200", p, code)
		}
	}
	for _, p := range []string{"/api/files?list=files", "/api/push", "/api/device", "/api/chat/unread", "/api/users", "/api/shares", "/api/location"} {
		code, body := get(p)
		if code != http.StatusForbidden || body["must_set_password"] != true {
			t.Errorf("%s while blank = %d %v, want 403 must_set_password", p, code, body)
		}
	}
	// Static pages still load (the launcher shows the dialog).
	if resp := do(t, client, "GET", ts.URL+URLPrefix+"/", nil, nil); resp.StatusCode != http.StatusOK {
		t.Errorf("launcher while blank = %d", resp.StatusCode)
	} else {
		resp.Body.Close()
	}

	resp = do(t, client, "POST", ts.URL+"/api/password",
		strings.NewReader(`{"current":"","new":"primera1"}`), map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set the first password = %d", resp.StatusCode)
	}
	if code, _ := get("/api/files?list=files"); code != http.StatusOK {
		t.Errorf("files after the password = %d, want 200", code)
	}
	if pw := storedUserPassword(t, srv, "nuevo"); !isHashedPassword(pw) {
		t.Errorf("first password stored as %q", pw)
	}
	if loginCode(t, ts.URL, "nuevo", "") != http.StatusUnauthorized || loginCode(t, ts.URL, "nuevo", "primera1") != http.StatusOK {
		t.Error("after the first password: blank still signs in, or the new one does not")
	}

	// The admin removing it again closes the doors again, on the live session.
	admin := noFollow()
	signIn(t, admin, ts.URL, "jefe", "secreto")
	if code := postAdmin(t, admin, ts.URL, `{"action":"update-user","name":"nuevo","password":null}`); code != http.StatusOK {
		t.Fatalf("clear password = %d", code)
	}
	if code, body := get("/api/files?list=files"); code != http.StatusForbidden || body["must_set_password"] != true {
		t.Errorf("files after the admin cleared it = %d %v", code, body)
	}
}
