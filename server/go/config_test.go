package main

// =============================================================================
// apps_dir: the code apart from the data.
// =============================================================================

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// TestAppsDirOutsideTheRunRoot - the install layout: the apps in client/apps,
// everything the server writes in store/, tied together by "apps_dir".
func TestAppsDirOutsideTheRunRoot(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	apps := filepath.Join(root, "client", "apps")
	store := filepath.Join(root, "store")
	os.MkdirAll(filepath.Join(apps, "shared"), 0o755)
	os.WriteFile(filepath.Join(apps, "login.html"), []byte("<h1>entra</h1>"), 0o644)
	os.MkdirAll(filepath.Join(store, "config"), 0o755)
	os.MkdirAll(filepath.Join(store, "homes"), 0o755)
	cfgPath := filepath.Join(store, "config", "server.json")
	os.WriteFile(cfgPath, []byte(`{"host":"127.0.0.1","port":0,"base_dir":".",
		"apps_dir":"../client/apps","admin":{"name":"jefe","password":"secreto"}}`), 0o644)

	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	for _, c := range []struct{ name, got, want string }{
		{"BaseDir", cfg.BaseDir, store},
		{"AppsDir", cfg.AppsDir, apps},
		{"HomesDir", cfg.HomesDir, filepath.Join(store, "homes")},
		{"ConfigDir", cfg.ConfigDir, filepath.Join(store, "config")},
	} {
		if c.got != c.want {
			t.Errorf("%s = %s, want %s", c.name, c.got, c.want)
		}
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv, err := NewServer(cfg, log)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	t.Cleanup(func() { srv.Close() })
	ts := httptest.NewServer(srv.routes())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + URLPrefix + "/login.html")
	if err != nil {
		t.Fatalf("GET login.html: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET %s/login.html = %d, want 200", URLPrefix, resp.StatusCode)
	}

	// A user reads apps/... from the apps folder, never from store/apps.
	want := filepath.Join(apps, "login.html")
	if r, ok := srv.users.Resolve("user", "ana", "apps/login.html"); !ok || r.Abs != want || r.Writable {
		t.Errorf("apps/login.html resolves to %q (ok=%v writable=%v), want read-only %s",
			r.Abs, ok, r.Writable, want)
	}

	// The admin's Drive root is the store: the apps are not in it.
	for _, n := range ListChildren(cfg.BaseDir, "") {
		if n.Path == "apps" {
			t.Errorf("the admin's Drive root lists apps/")
		}
	}
}

// TestAppsDirDefault - no "apps_dir": the apps sit inside the base dir, as
// they did before the setting existed.
func TestAppsDirDefault(t *testing.T) {
	_, cfg, root := newTestUsers(t)
	if want := filepath.Join(root, "apps"); cfg.AppsDir != want {
		t.Errorf("AppsDir = %s, want %s", cfg.AppsDir, want)
	}
}
