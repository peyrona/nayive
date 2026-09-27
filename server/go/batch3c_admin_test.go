package main

// =============================================================================
// Review of batch 3: the admin keeps a name the new rule would refuse (#21
// regression), and every direct child of config/ is out of the file API's
// reach (#22).
// =============================================================================

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestAdminKeepsOldInvalidName: admin.html sends set-admin on every Save. An
// older install whose admin name breaks today's rule (a space) must still be
// able to save - with the same name - while a NEW bad name is still refused.
func TestAdminKeepsOldInvalidName(t *testing.T) {
	srv, ts, client := newTestServer(t)
	if err := srv.cfg.Update(func(c *ServerConfig) {
		c.Admin = &AdminAccount{Name: "el jefe", Password: "secreto"}
	}); err != nil {
		t.Fatalf("rename admin: %v", err)
	}
	signIn(t, client, ts.URL, "el jefe", "secreto")

	if code := postAdmin(t, client, ts.URL,
		`{"action":"set-admin","name":"el jefe","password":"nuevo1"}`); code != http.StatusOK {
		t.Fatalf("set-admin keeping the current name = %d, want 200", code)
	}
	if code := postAdmin(t, client, ts.URL,
		`{"action":"set-admin","name":"otro jefe","password":""}`); code != http.StatusBadRequest {
		t.Errorf("set-admin to a new bad name = %d, want 400", code)
	}
}

// TestConfigChildrenNotWritableByFileAPI: not only config/*.json - mail.key,
// turn_secret and the rest are refused too, as move and delete refuse them.
func TestConfigChildrenNotWritableByFileAPI(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "jefe", "secreto")
	key := filepath.Join(srv.cfg.ConfigDir, "mail.key")
	os.WriteFile(key, []byte("secret"), 0o600)

	for _, f := range []string{"config/mail.key", "config/turn_secret"} {
		resp := do(t, client, "PUT", ts.URL+"/api/files?file="+f,
			strings.NewReader("x"), map[string]string{"Content-Type": "text/plain"})
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("PUT %s = %d, want 403", f, resp.StatusCode)
		}
	}
	if got, _ := os.ReadFile(key); string(got) != "secret" {
		t.Errorf("mail.key changed: %q", got)
	}
}
