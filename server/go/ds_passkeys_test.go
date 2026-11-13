package main

// Data-safety seal: a new password removes the sign-in passkeys
// (login_passkey.go dropLoginKeys) - and NOTHING else.
//
// Whoever learnt the old password may have added a passkey of their own; a
// password change must lock them out, as it ends their sessions. The file
// removed is homes/<user>/data/passkeys.json, or config/admin-passkeys.json:
// the account's config.json and every other file beside it stay as they were.
// A blank admin Save (no password typed) keeps the admin's passkeys.

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDS_Passkeys_NewPasswordDropsThemOnly: the user's own change, the
// admin's reset and clear of a user, the admin's own change; a blank
// set-admin keeps them.
func TestDS_Passkeys_NewPasswordDropsThemOnly(t *testing.T) {
	srv, ts, ana := newTestServer(t)
	signIn(t, ana, ts.URL, "ana", "abc")
	data := filepath.Join(srv.cfg.HomesDir, "ana", "data")
	pk := filepath.Join(data, "passkeys.json")
	other := filepath.Join(data, "tasks.json")
	os.WriteFile(other, []byte(`{"tasks":["keep me"]}`), 0o644)

	add := func(c *http.Client, password, path string) {
		t.Helper()
		if code := pkAdd(t, c, ts.URL, password, newFakeKey(t)); code != 200 {
			t.Fatalf("add = %d", code)
		}
		if !pathExists(path) {
			t.Fatalf("no passkeys file at %s", path)
		}
	}
	untouched := func(when string) {
		t.Helper()
		if readOr(other) != `{"tasks":["keep me"]}` {
			t.Errorf("%s: a file beside passkeys.json changed: %q", when, readOr(other))
		}
		if !pathExists(filepath.Join(data, "config.json")) {
			t.Errorf("%s: the account file is gone", when)
		}
	}

	// 1. Her own change.
	add(ana, "abc", pk)
	resp := do(t, ana, "POST", ts.URL+"/api/password",
		strings.NewReader(`{"current":"abc","new":"nueva1"}`), map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("change password = %d", resp.StatusCode)
	}
	if pathExists(pk) {
		t.Errorf("her own password change kept her passkeys")
	}
	untouched("own change")
	if loginCode(t, ts.URL, "ana", "nueva1") != http.StatusOK {
		t.Errorf("the new password does not sign in")
	}

	// 2. The admin sets a new one for her; 3. the admin clears it.
	admin := noFollow()
	signIn(t, admin, ts.URL, "jefe", "secreto")
	for _, c := range []struct{ when, body string }{
		{"admin reset", `{"action":"update-user","name":"ana","password":"otra22"}`},
		{"admin clear", `{"action":"update-user","name":"ana","password":null}`},
	} {
		ana = noFollow()
		pw := "nueva1"
		if c.when == "admin clear" {
			pw = "otra22"
		}
		signIn(t, ana, ts.URL, "ana", pw)
		add(ana, pw, pk)
		if code := postAdmin(t, admin, ts.URL, c.body); code != http.StatusOK {
			t.Fatalf("%s = %d", c.when, code)
		}
		if pathExists(pk) {
			t.Errorf("%s kept her passkeys", c.when)
		}
		untouched(c.when)
	}

	// An admin save that sets no password (a quota) keeps them.
	adminCall(t, ts.URL, `{"action":"update-user","name":"ana","password":"tercera3"}`, http.StatusOK)
	ana = noFollow()
	signIn(t, ana, ts.URL, "ana", "tercera3")
	add(ana, "tercera3", pk)
	if code := postAdmin(t, admin, ts.URL, `{"action":"update-user","name":"ana","quota":0}`); code != http.StatusOK {
		t.Fatalf("update-user quota = %d", code)
	}
	if !pathExists(pk) {
		t.Errorf("an admin save with no password removed her passkeys")
	}

	// 4. The admin's own: a blank Save keeps them, a new password drops them.
	apk := filepath.Join(srv.cfg.ConfigDir, "admin-passkeys.json")
	add(admin, "secreto", apk)
	if code := postAdmin(t, admin, ts.URL, `{"action":"set-admin","name":"jefe","password":""}`); code != http.StatusOK {
		t.Fatalf("set-admin blank = %d", code)
	}
	if !pathExists(apk) {
		t.Errorf("a blank set-admin removed the admin's passkeys")
	}
	if code := postAdmin(t, admin, ts.URL, `{"action":"set-admin","name":"jefe","password":"nuevo9"}`); code != http.StatusOK {
		t.Fatalf("set-admin = %d", code)
	}
	if pathExists(apk) {
		t.Errorf("a new admin password kept the admin's passkeys")
	}
	if !pathExists(pk) {
		t.Errorf("the admin's change removed a user's passkeys")
	}
	if !pathExists(filepath.Join(srv.cfg.ConfigDir, "server.json")) {
		t.Errorf("server.json is gone")
	}
}
