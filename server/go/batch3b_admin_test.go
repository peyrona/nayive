package main

// =============================================================================
// The admin account's name (audits #21, #64), the open panel (#67), and the
// server's own config files (#22).
// =============================================================================

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// postAdmin sends one /api/admin action and returns its status.
func postAdmin(t *testing.T, client *http.Client, base, body string) int {
	t.Helper()
	resp := do(t, client, "POST", base+"/api/admin", strings.NewReader(body),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	return resp.StatusCode
}

// whoami is the signed-in (user, role), or ("", "") with no session.
func whoami(t *testing.T, client *http.Client, base string) (string, string) {
	t.Helper()
	resp := do(t, client, "GET", base+"/api/whoami", nil, nil)
	defer resp.Body.Close()
	var me struct{ User, Role string }
	json.NewDecoder(resp.Body).Decode(&me)
	return me.User, me.Role
}

// forgetAdmin turns the fixture into a server with no admin account.
func forgetAdmin(t *testing.T, srv *Server) {
	t.Helper()
	if err := srv.cfg.Update(func(c *ServerConfig) { c.Admin = nil }); err != nil {
		t.Fatalf("clear admin: %v", err)
	}
}

// TestAdminSetupRefusesBadName: the first admin's name follows the same rule
// as every account's.
func TestAdminSetupRefusesBadName(t *testing.T) {
	srv, ts, client := newTestServer(t)
	forgetAdmin(t, srv)
	os.RemoveAll(srv.cfg.HomesDir) // a fresh install: no users either

	for _, name := range []string{"../jefe", "a/b", ".oculto"} {
		body := `{"action":"setup","name":"` + name + `","password":"x"}`
		if code := postAdmin(t, client, ts.URL, body); code != http.StatusBadRequest {
			t.Errorf("setup as %q = %d, want 400", name, code)
		}
	}
	if code := postAdmin(t, client, ts.URL,
		`{"action":"setup","name":"jefe","password":"x"}`); code != http.StatusOK {
		t.Errorf("setup as a good name = %d, want 200", code)
	}
}

// TestAdminRenameRefusesBadOrTakenName: the admin cannot take a regular user's
// name, nor one no account could have.
func TestAdminRenameRefusesBadOrTakenName(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "jefe", "secreto")

	for _, c := range []struct {
		name string
		want int
	}{
		{"ana", http.StatusConflict},
		{"a/b", http.StatusBadRequest},
		{".oculto", http.StatusBadRequest},
	} {
		body := `{"action":"set-admin","name":"` + c.name + `","password":""}`
		if code := postAdmin(t, client, ts.URL, body); code != c.want {
			t.Errorf("set-admin to %q = %d, want %d", c.name, code, c.want)
		}
	}
	if u, _ := whoami(t, client, ts.URL); u != "jefe" {
		t.Errorf("after refusals the admin is %q, want jefe", u)
	}
}

// TestAdminRenameMovesSessions: after a rename, THIS session carries the new
// name (so a password change works), and the old name's other sessions end.
func TestAdminRenameMovesSessions(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "jefe", "secreto")
	other := signedInClient(t, ts.URL, "jefe", "secreto") // another device

	if code := postAdmin(t, client, ts.URL,
		`{"action":"set-admin","name":"jefa","password":""}`); code != http.StatusOK {
		t.Fatalf("set-admin = %d", code)
	}
	if u, role := whoami(t, client, ts.URL); u != "jefa" || role != "admin" {
		t.Errorf("this session after the rename = %q/%q, want jefa/admin", u, role)
	}
	if u, _ := whoami(t, other, ts.URL); u != "" {
		t.Errorf("the other device is still signed in as %q", u)
	}

	resp := do(t, client, "POST", ts.URL+"/api/password",
		strings.NewReader(`{"current":"secreto","new":"nuevo1"}`),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("password change after the rename = %d, want 200", resp.StatusCode)
	}
}

// TestAdminListingClosedWhenUsersExist: with no admin configured the panel is
// open - but only on a fresh install, for the listing as for setup.
func TestAdminListingClosedWhenUsersExist(t *testing.T) {
	srv, ts, client := newTestServer(t)
	forgetAdmin(t, srv)

	resp := do(t, client, "GET", ts.URL+"/api/admin", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("anonymous listing with users = %d, want 409", resp.StatusCode)
	}

	os.RemoveAll(srv.cfg.HomesDir) // a fresh install: the panel opens
	resp = do(t, client, "GET", ts.URL+"/api/admin", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("anonymous listing on a fresh install = %d, want 200", resp.StatusCode)
	}
}

// TestServerConfigNotWritableByFileAPI: config/*.json is read once at start
// and rewritten whole by the admin panel; a PUT from Drive would be silently
// undone, or undo the panel's next save.
func TestServerConfigNotWritableByFileAPI(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "jefe", "secreto")
	before, _ := os.ReadFile(filepath.Join(srv.cfg.ConfigDir, "server.json"))

	for _, f := range []string{"config/server.json", "config/nuevo.json"} {
		resp := do(t, client, "PUT", ts.URL+"/api/files?file="+f,
			strings.NewReader("{}"), map[string]string{"Content-Type": "application/json"})
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("PUT %s = %d, want 403", f, resp.StatusCode)
		}
	}
	after, _ := os.ReadFile(filepath.Join(srv.cfg.ConfigDir, "server.json"))
	if string(after) != string(before) {
		t.Errorf("server.json changed:\n%s", after)
	}

	// Any other file of the admin's still saves.
	resp := do(t, client, "PUT", ts.URL+"/api/files?file=nota.json",
		strings.NewReader("{}"), map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("PUT nota.json = %d, want 200", resp.StatusCode)
	}
}
