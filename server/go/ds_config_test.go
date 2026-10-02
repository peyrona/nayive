package main

// Data-safety seal (cleanup Phase 3, batch S1): a user's config.json that
// cannot be read or parsed is never written over (F1), and the admin's file
// API cannot replace it either (B5).

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// dsDamagedConfig writes ana's config.json with every field set, then breaks it
// with one stray comma (a hand edit, a Text save by the admin), and answers its
// path and the damaged bytes.
func dsDamagedConfig(t *testing.T, homes string) (string, string) {
	t.Helper()
	path := filepath.Join(homes, "ana", "data", "config.json")
	good := `{"password":"` + hashPassword("abc") + `","quota":2.0,"photo_max":2000,"lang":"es","trash_days":30,"mine":"keep me"}`
	bad := strings.Replace(good, `"keep me"}`, `"keep me",}`, 1)
	if err := os.WriteFile(path, []byte(bad), 0o644); err != nil {
		t.Fatal(err)
	}
	return path, bad
}

// TestDS_F1_DamagedConfigNotRewritten: every setter that rewrites config.json
// (the launcher's automatic time zone among them) refuses a file that does not
// parse; the bytes stay, and a blank password never signs in.
func TestDS_F1_DamagedConfigNotRewritten(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	path, bad := dsDamagedConfig(t, cfg.HomesDir)

	if _, ok := users.SetUserTZ("user", "ana", "Europe/Madrid"); ok {
		t.Error("SetUserTZ wrote over a damaged config.json")
	}
	if _, ok := users.SetUserLang("user", "ana", "en"); ok {
		t.Error("SetUserLang wrote over a damaged config.json")
	}
	if _, ok := users.SetUserTrashDays("user", "ana", "10"); ok {
		t.Error("SetUserTrashDays wrote over a damaged config.json")
	}
	if users.SetPassword("user", "ana", "nueva") {
		t.Error("SetPassword wrote over a damaged config.json")
	}
	if after, _ := os.ReadFile(path); string(after) != bad {
		t.Errorf("config.json changed:\n%s", after)
	}
	if users.Authenticate("ana", "") == "user" || users.NeedsPassword("user", "ana") {
		t.Error("a damaged config.json lets a blank password in")
	}
}

// TestDS_F1_UnreadableConfigNotRewritten: the same for a file that cannot be
// read at all (EIO, EACCES - here a 000 file).
func TestDS_F1_UnreadableConfigNotRewritten(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a 000 file")
	}
	users, cfg, _ := newTestUsers(t)
	path, bad := dsDamagedConfig(t, cfg.HomesDir)
	good := strings.Replace(bad, `"keep me",}`, `"keep me"}`, 1)
	os.WriteFile(path, []byte(good), 0o644)
	os.Chmod(path, 0o000)

	_, ok := users.SetUserTZ("user", "ana", "Europe/Lisbon")
	os.Chmod(path, 0o644)
	if ok {
		t.Error("SetUserTZ wrote over an unreadable config.json")
	}
	if after, _ := os.ReadFile(path); string(after) != good {
		t.Errorf("config.json changed:\n%s", after)
	}
}

// TestDS_F1_PasswordNotStringNotBlanked: a "password" that is not a string
// would be written back as "" - an account with no password.
func TestDS_F1_PasswordNotStringNotBlanked(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	path := filepath.Join(cfg.HomesDir, "ana", "data", "config.json")
	odd := `{"password": 12345, "quota": 2}`
	os.WriteFile(path, []byte(odd), 0o644)

	if _, ok := users.SetUserTZ("user", "ana", "Europe/Madrid"); ok {
		t.Error("SetUserTZ rewrote a config.json whose password is not a string")
	}
	if after, _ := os.ReadFile(path); string(after) != odd {
		t.Errorf("config.json changed:\n%s", after)
	}
	if users.Authenticate("ana", "") == "user" {
		t.Error("a blank password signs in")
	}
}

// TestDS_F1_ApiAnswersErrorOnDamagedConfig: through the API, the launcher's
// automatic POST /api/tz and Mi cuenta's language get an error - not a "bad
// value" 400, and never a 200.
func TestDS_F1_ApiAnswersErrorOnDamagedConfig(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	path, bad := dsDamagedConfig(t, srv.cfg.HomesDir)

	for _, url := range []string{"/api/tz?value=Europe/Madrid", "/api/lang?value=en", "/api/files?trash=days&value=10"} {
		if code, body := callJSON(t, client, "POST", ts.URL+url, ""); code != http.StatusInternalServerError {
			t.Errorf("POST %s = %d %s, want 500", url, code, body)
		}
	}
	if after, _ := os.ReadFile(path); string(after) != bad {
		t.Errorf("config.json changed:\n%s", after)
	}
}

// TestDS_F1_AdminUpdateRefusesDamaged: the panel's update of an account whose
// config.json is damaged is refused (never "usuario guardado"), and the file
// is left for the admin to repair by hand.
func TestDS_F1_AdminUpdateRefusesDamaged(t *testing.T) {
	srv, ts, admin := newTestServer(t)
	signIn(t, admin, ts.URL, "jefe", "secreto")
	path, bad := dsDamagedConfig(t, srv.cfg.HomesDir)

	code, body := callJSON(t, admin, "POST", ts.URL+"/api/admin", `{"action":"update-user","name":"ana","quota":5}`)
	if code == http.StatusOK {
		t.Errorf("update-user over a damaged config.json = 200 %s", body)
	}
	if after, _ := os.ReadFile(path); string(after) != bad {
		t.Errorf("config.json changed:\n%s", after)
	}
}

// TestDS_F1_SweepSkipsDamagedConfig: a person who keeps the bin for ever
// (trash_days -1) must not have it purged by the default days because their
// config.json cannot be read.
func TestDS_F1_SweepSkipsDamagedConfig(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	path := filepath.Join(cfg.HomesDir, "ana", "data", "config.json")
	os.WriteFile(path, []byte(`{"password":"abc","trash_days":-1,}`), 0o644)
	can := filepath.Join(cfg.HomesDir, "ana", ".trash")
	os.MkdirAll(can, 0o755)
	old := filepath.Join(can, "1000000000-deadbeef") // 2001: older than any cutoff
	os.WriteFile(old, []byte("kept for ever"), 0o644)
	os.WriteFile(filepath.Join(can, "index.json"),
		[]byte(`{"1000000000-deadbeef":{"orig":"files/a.txt","name":"a.txt","deleted":1000000000,"dir":false,"size":13}}`), 0o644)

	NewTrash(cfg.BaseDir, cfg.HomesDir, users, quietLog()).SweepExpired(30)
	if !pathExists(old) {
		t.Error("the bin of an account with an unreadable config.json was swept by the default days")
	}
}

// TestDS_B5_AdminCannotPutAccountFile: the admin's Drive cannot replace a
// user's config.json (the server rewrites it under its own lock; the panel is
// the way to change an account).
func TestDS_B5_AdminCannotPutAccountFile(t *testing.T) {
	srv, ts, admin := newTestServer(t)
	signIn(t, admin, ts.URL, "jefe", "secreto")
	path := filepath.Join(srv.cfg.HomesDir, "ana", "data", "config.json")
	before, _ := os.ReadFile(path)
	rel, err := filepath.Rel(srv.cfg.BaseDir, path)
	if err != nil {
		t.Fatal(err)
	}
	resp := do(t, admin, "PUT", ts.URL+"/api/files?file="+filepath.ToSlash(rel), strings.NewReader(`{"password":""}`), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("admin PUT of %s = %d, want 403", rel, resp.StatusCode)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Errorf("config.json changed: %q", after)
	}
	signIn(t, noFollow(), ts.URL, "ana", "abc") // the account still works
}
