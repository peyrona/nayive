package main

// =============================================================================
// sites_dir: plain web sites served beside Nayive.
// =============================================================================

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newSitesServer is newTestServer with a sites folder holding a "cv" site, a
// folder named like a Nayive route, and the files a site must never give away.
func newSitesServer(t *testing.T) (*Server, string, *http.Client) {
	t.Helper()
	srv, ts, client := newTestServer(t)

	sites := t.TempDir()
	write := func(rel, body string) {
		path := filepath.Join(sites, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(path), 0o755)
		os.WriteFile(path, []byte(body), 0o644)
	}
	write("cv/index.html", "<h1>cv</h1>")
	write("cv/style.css", "h1{color:red}")
	write("cv/sub/nota.txt", "sin index")
	write("cv/.git/config", "secreto")
	write("api/index.html", "<h1>no</h1>")
	srv.cfg.Update(func(c *ServerConfig) { c.SitesDir = sites })
	return srv, ts.URL, client
}

func TestSites(t *testing.T) {
	_, base, client := newSitesServer(t)

	for _, c := range []struct {
		method, path string
		status       int
		body, ctype  string
		location     string
	}{
		{"GET", "/cv/", 200, "<h1>cv</h1>", "text/html", ""},
		{"GET", "/cv/index.html", 200, "<h1>cv</h1>", "text/html", ""},
		{"HEAD", "/cv/", 200, "", "text/html", ""},
		{"GET", "/cv", 302, "", "", "/cv/"},
		{"GET", "/cv/sub", 302, "", "", "/cv/sub/"},
		{"GET", "/cv/style.css", 200, "h1{color:red}", "text/css", ""},
		{"GET", "/cv/sub/", 404, "Not found.\n", "", ""}, // no index.html, no listing
		{"GET", "/cv/sub/nota.txt", 200, "sin index", "", ""},
		{"GET", "/cv/.git/config", 404, "Not found.\n", "", ""},
		{"GET", "/cv/nada.html", 404, "Not found.\n", "", ""},
		{"GET", "/nope/", 404, "Not found.\n", "", ""},
		{"GET", "/api", 404, "Not found.\n", "", ""}, // a route's name, not a site
		{"POST", "/cv/", 405, "Method not allowed.\n", "", ""},
		{"GET", "/cv/../api/", 403, "Forbidden.\n", "", ""},
	} {
		resp := do(t, client, c.method, base+c.path, nil, nil)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != c.status {
			t.Errorf("%s %s = %d, want %d", c.method, c.path, resp.StatusCode, c.status)
			continue
		}
		if c.body != "" && string(body) != c.body {
			t.Errorf("%s %s body = %q, want %q", c.method, c.path, body, c.body)
		}
		if ct := resp.Header.Get("Content-Type"); c.ctype != "" && !strings.HasPrefix(ct, c.ctype) {
			t.Errorf("%s %s Content-Type = %q, want %s", c.method, c.path, ct, c.ctype)
		}
		if loc := resp.Header.Get("Location"); loc != c.location {
			t.Errorf("%s %s Location = %q, want %q", c.method, c.path, loc, c.location)
		}
	}

	// The front door is unchanged.
	resp := do(t, client, "GET", base+"/", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound ||
		!strings.HasPrefix(resp.Header.Get("Location"), URLPrefix+"/login.html") {
		t.Errorf("GET / = %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
}

// TestSitesNewFolderNeedsNoRestart - the folder is opened per request.
func TestSitesNewFolderNeedsNoRestart(t *testing.T) {
	srv, base, client := newSitesServer(t)
	dir := filepath.Join(srv.cfg.SitesPath(), "blog")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("nuevo"), 0o644)

	resp := do(t, client, "GET", base+"/blog/", nil, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "nuevo" {
		t.Errorf("GET /blog/ = %d %q", resp.StatusCode, body)
	}
}

// TestSitesOff - no "sites_dir": every such URL is the old plain 404.
func TestSitesOff(t *testing.T) {
	srv, base, client := newSitesServer(t)
	srv.cfg.Update(func(c *ServerConfig) { c.SitesDir = "" })

	resp := do(t, client, "GET", base+"/cv/", nil, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound || string(body) != "Not found.\n" {
		t.Errorf("GET /cv/ with sites off = %d %q", resp.StatusCode, body)
	}
}

// TestSitesDirResolved - absolute, "~/" and relative to the run-root; unset is off.
func TestSitesDirResolved(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	for _, c := range []struct{ value, want string }{
		{"", ""},
		{"/srv/web", "/srv/web"},
		{"~/web_sites", filepath.Join(home, "web_sites")},
		{"../web", ""}, // filled in below: relative to the run-root
	} {
		root := t.TempDir()
		os.MkdirAll(filepath.Join(root, "config"), 0o755)
		cfgPath := filepath.Join(root, "config", "server.json")
		os.WriteFile(cfgPath, []byte(`{"sites_dir":"`+c.value+`"}`), 0o644)

		cfg, err := LoadConfig(cfgPath)
		if err != nil {
			t.Fatalf("LoadConfig: %v", err)
		}
		want := c.want
		if c.value == "../web" {
			want = filepath.Join(filepath.Dir(root), "web")
		}
		if got := cfg.SitesPath(); got != want {
			t.Errorf("sites_dir %q -> %q, want %q", c.value, got, want)
		}
	}
}

// TestSitesDirNeverNayiveData - a sites folder that is, holds or sits inside
// the run-root would publish server.json and every home: it is ignored.
func TestSitesDirNeverNayiveData(t *testing.T) {
	_, cfg, root := newTestUsers(t)
	for _, value := range []string{root, filepath.Dir(root), "homes", "config", "/"} {
		cfg.Server.SitesDir = value
		if got := cfg.SitesPath(); got != "" {
			t.Errorf("sites_dir %q -> %q, want off", value, got)
		}
	}
}

// TestAdminSetSites - the panel's field: checked, saved, live at once, cleared.
func TestAdminSetSites(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "jefe", "secreto")
	post := func(value string) (int, string) {
		code, body := callJSON(t, client, "POST", ts.URL+"/api/admin",
			`{"action":"set-sites","sites_dir":"`+value+`"}`)
		return code, string(body)
	}

	sites := t.TempDir()
	os.MkdirAll(filepath.Join(sites, "cv"), 0o755)
	os.WriteFile(filepath.Join(sites, "cv", "index.html"), []byte("cv"), 0o644)

	if code, body := post(filepath.Join(sites, "nope")); code != http.StatusBadRequest {
		t.Errorf("missing folder = %d %s, want 400", code, body)
	}
	if code, body := post(srv.cfg.Here); code != http.StatusBadRequest {
		t.Errorf("the run-root = %d %s, want 400", code, body)
	}
	if code, body := post(sites); code != http.StatusOK {
		t.Fatalf("set-sites = %d %s", code, body)
	}
	saved, _ := os.ReadFile(srv.cfg.Path)
	if !strings.Contains(string(saved), `"sites_dir": "`+sites+`"`) {
		t.Errorf("server.json lacks sites_dir:\n%s", saved)
	}
	resp := do(t, client, "GET", ts.URL+"/cv/", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /cv/ right after saving = %d, want 200", resp.StatusCode)
	}

	if code, body := post(""); code != http.StatusOK {
		t.Fatalf("clear = %d %s", code, body)
	}
	saved, _ = os.ReadFile(srv.cfg.Path)
	if strings.Contains(string(saved), "sites_dir") {
		t.Errorf("cleared sites_dir still in server.json:\n%s", saved)
	}
	resp = do(t, client, "GET", ts.URL+"/cv/", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("GET /cv/ after clearing = %d, want 404", resp.StatusCode)
	}
}
