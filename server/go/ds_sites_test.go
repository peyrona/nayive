package main

// Data-safety seal: sites_admin.go - the admin panel's edits of a site's
// .password file. Each edit changes only one person's line, keeps everything
// else in the file byte for byte, writes the file whole (never half), never
// writes through a link, and the last person out makes the site public.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// newSitesAdmin is a test server with a sites folder, the admin signed in.
func newSitesAdmin(t *testing.T) (*Server, string, *http.Client, string) {
	t.Helper()
	srv, ts, client := newTestServer(t)
	sites := t.TempDir()
	for _, s := range []string{"cv", "blog"} {
		os.MkdirAll(filepath.Join(sites, s), 0o755)
		os.WriteFile(filepath.Join(sites, s, "index.html"), []byte(s), 0o644)
	}
	srv.cfg.Update(func(c *ServerConfig) { c.SitesDir = sites })
	signIn(t, client, ts.URL, "jefe", "secreto")
	return srv, ts.URL, client, sites
}

func siteAdmin(t *testing.T, client *http.Client, base string, body map[string]any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	code, out := callJSON(t, client, "POST", base+"/api/admin", string(raw))
	var m map[string]any
	json.Unmarshal(out, &m)
	return code, m
}

func siteStatus(t *testing.T, client *http.Client, base, path, name, pw string) int {
	t.Helper()
	var h map[string]string
	if name != "" {
		h = basic(name, pw)
	}
	resp := do(t, client, "GET", base+path, nil, h)
	resp.Body.Close()
	return resp.StatusCode
}

func TestDS_Sites_AddChangeRemove(t *testing.T) {
	_, base, client, sites := newSitesAdmin(t)
	file := filepath.Join(sites, "cv", ".password")
	open := noFollow() // a visitor, no Nayive session

	set := func(name, pw string) int {
		code, _ := siteAdmin(t, client, base, map[string]any{"action": "set-site-person", "site": "cv", "name": name, "password": pw})
		return code
	}
	if code := set("ana", "uno"); code != 200 {
		t.Fatalf("add ana = %d", code)
	}
	if info, err := os.Stat(file); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf(".password = %v %v, want mode 0600", info, err)
	}
	if siteStatus(t, open, base, "/cv/", "", "") != 401 || siteStatus(t, open, base, "/cv/", "ana", "uno") != 200 {
		t.Error("ana's login does not open the locked site")
	}
	if siteStatus(t, open, base, "/blog/", "", "") != 200 {
		t.Error("another site got locked too")
	}
	raw, _ := os.ReadFile(file)
	if strings.Contains(string(raw), "uno") {
		t.Error("the plain password reached the disk")
	}

	// A note and a hand-made line the panel does not understand stay as they are.
	os.WriteFile(file, append([]byte("# family only\r\nodd line\n"), raw...), 0o600)
	set("luis", "dos")
	set("ana", "tres") // a new password, in ana's old place
	raw, _ = os.ReadFile(file)
	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	if len(lines) != 4 || lines[0] != "# family only" || lines[1] != "odd line" ||
		!strings.HasPrefix(lines[2], "ana:") || !strings.HasPrefix(lines[3], "luis:") {
		t.Errorf("file after edits:\n%s", raw)
	}
	if siteStatus(t, open, base, "/cv/", "ana", "uno") != 401 || siteStatus(t, open, base, "/cv/", "ana", "tres") != 200 {
		t.Error("ana's new password is not the one that works")
	}

	_, list := siteAdmin(t, client, base, map[string]any{"action": "list-sites"})
	got, _ := json.Marshal(list["sites"])
	want := `[{"broken":false,"locked":false,"name":"blog","people":[]},{"broken":false,"locked":true,"name":"cv","people":["ana","luis"]}]`
	if string(got) != want {
		t.Errorf("list-sites = %s\nwant %s", got, want)
	}

	rm := func(name string) (int, map[string]any) {
		return siteAdmin(t, client, base, map[string]any{"action": "remove-site-person", "site": "cv", "name": name})
	}
	if code, _ := rm("nadie"); code != 404 {
		t.Errorf("remove an unknown person = %d, want 404", code)
	}
	if code, m := rm("ana"); code != 200 || m["locked"] != true {
		t.Errorf("remove ana = %d %v", code, m)
	}
	if siteStatus(t, open, base, "/cv/", "ana", "tres") != 401 || siteStatus(t, open, base, "/cv/", "luis", "dos") != 200 {
		t.Error("removing ana changed someone else, or ana still gets in")
	}
	if code, m := rm("luis"); code != 200 || m["locked"] != false {
		t.Errorf("remove the last person = %d %v", code, m)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Error("the last person out left the file (the site stays locked for all)")
	}
	if siteStatus(t, open, base, "/cv/", "", "") != 200 {
		t.Error("the site is not public again")
	}
	if left, _ := filepath.Glob(filepath.Join(sites, "cv", ".password*")); len(left) != 0 {
		t.Errorf("leftovers: %v", left)
	}
}

func TestDS_Sites_Refusals(t *testing.T) {
	_, base, client, sites := newSitesAdmin(t)
	elsewhere := t.TempDir()
	os.Symlink(elsewhere, filepath.Join(sites, "link"))
	os.MkdirAll(filepath.Join(sites, ".hidden"), 0o755)
	os.MkdirAll(filepath.Join(sites, "api"), 0o755)

	for _, c := range []struct {
		site, name, pw string
		code           int
	}{
		{"link", "ana", "x", 404},    // never written through a link
		{".hidden", "ana", "x", 404}, // not a site
		{"api", "ana", "x", 404},     // a name Nayive answers itself
		{"../cv", "ana", "x", 404},   // no path in the name
		{"nope", "ana", "x", 404},    // no such folder
		{"cv", "a:b", "x", 400},      // breaks the line format
		{"cv", "a\nb", "x", 400},
		{"cv", " ana", "x", 400},
		{"cv", "#ana", "x", 400}, // would read as a note
		{"cv", "", "x", 400},
		{"cv", "ana", "", 400}, // no password
	} {
		code, m := siteAdmin(t, client, base, map[string]any{"action": "set-site-person", "site": c.site, "name": c.name, "password": c.pw})
		if code != c.code {
			t.Errorf("set %q %q = %d %v, want %d", c.site, c.name, code, m, c.code)
		}
	}
	if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
		t.Errorf("wrote through the link: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(sites, "cv", ".password")); !os.IsNotExist(err) {
		t.Error("a refused edit wrote the file")
	}

	// A .password that is a link or too big is not rewritten.
	target := filepath.Join(elsewhere, "target")
	os.WriteFile(target, []byte("keep\n"), 0o644)
	os.Symlink(target, filepath.Join(sites, "blog", ".password"))
	if code, _ := siteAdmin(t, client, base, map[string]any{"action": "set-site-person", "site": "blog", "name": "ana", "password": "x"}); code != 409 {
		t.Errorf("linked .password = %d, want 409", code)
	}
	if raw, _ := os.ReadFile(target); string(raw) != "keep\n" {
		t.Errorf("the link's target changed: %q", raw)
	}

	// A regular user may not touch any of it.
	user := noFollow()
	signIn(t, user, base, "ana", "abc")
	for _, action := range []string{"list-sites", "set-site-person", "remove-site-person", "rename-site-person"} {
		code, _ := siteAdmin(t, user, base, map[string]any{"action": action, "site": "cv", "name": "ana", "new_name": "eva", "password": "x"})
		if code != 403 {
			t.Errorf("%s as a regular user = %d, want 403", action, code)
		}
	}
}

// TestDS_Sites_ParallelEditsAllLand - two admin tabs at once lose nobody.
func TestDS_Sites_ParallelEditsAllLand(t *testing.T) {
	_, base, client, sites := newSitesAdmin(t)
	names := []string{"p1", "p2", "p3", "p4", "p5", "p6"}
	var wg sync.WaitGroup
	for _, n := range names {
		wg.Add(1)
		go func() {
			defer wg.Done()
			siteAdmin(t, client, base, map[string]any{"action": "set-site-person", "site": "cv", "name": n, "password": "pw-" + n})
		}()
	}
	wg.Wait()
	raw, _ := os.ReadFile(filepath.Join(sites, "cv", ".password"))
	people := parseSitePasswords(raw)
	for _, n := range names {
		if ok, _ := checkPassword("pw-"+n, people[n]); !ok {
			t.Errorf("%s lost in parallel edits:\n%s", n, raw)
		}
	}
}

// TestDS_Sites_BrokenFileListed - a file that opens for nobody shows as such.
func TestDS_Sites_BrokenFileListed(t *testing.T) {
	_, base, client, sites := newSitesAdmin(t)
	os.WriteFile(filepath.Join(sites, "cv", ".password"), []byte("ana:plain\n"), 0o600)
	_, list := siteAdmin(t, client, base, map[string]any{"action": "list-sites"})
	got, _ := json.Marshal(list["sites"])
	if !strings.Contains(string(got), `{"broken":true,"locked":true,"name":"cv","people":[]}`) {
		t.Errorf("list-sites = %s", got)
	}
	// Adding a person mends it, and keeps the old line.
	siteAdmin(t, client, base, map[string]any{"action": "set-site-person", "site": "cv", "name": "luis", "password": "x"})
	raw, _ := os.ReadFile(filepath.Join(sites, "cv", ".password"))
	if !strings.HasPrefix(string(raw), "ana:plain\nluis:$pbkdf2") {
		t.Errorf("file = %q", raw)
	}
}

// TestDS_Sites_Rename - a new name keeps the password and the line's place;
// notes, other people and refusals leave the file byte for byte.
func TestDS_Sites_Rename(t *testing.T) {
	_, base, client, sites := newSitesAdmin(t)
	file := filepath.Join(sites, "cv", ".password")
	open := noFollow()
	for _, p := range [][2]string{{"ana", "uno"}, {"luis", "dos"}} {
		siteAdmin(t, client, base, map[string]any{"action": "set-site-person", "site": "cv", "name": p[0], "password": p[1]})
	}
	raw, _ := os.ReadFile(file)
	os.WriteFile(file, append([]byte("# my note\n"), raw...), 0o600)
	before, _ := os.ReadFile(file)

	ren := func(name, newName string) int {
		code, _ := siteAdmin(t, client, base, map[string]any{"action": "rename-site-person", "site": "cv", "name": name, "new_name": newName})
		return code
	}
	for _, c := range []struct {
		name, newName string
		want          int
	}{
		{"nadie", "x", 404},  // not there
		{"ana", "luis", 409}, // the name is taken
		{"ana", "a:b", 400},  // a bad name
		{"ana", "", 400},     // empty
	} {
		if got := ren(c.name, c.newName); got != c.want {
			t.Errorf("rename %q -> %q = %d, want %d", c.name, c.newName, got, c.want)
		}
	}
	if after, _ := os.ReadFile(file); string(after) != string(before) {
		t.Errorf("a refused rename changed the file:\n%s", after)
	}

	if code := ren("ana", "eva"); code != 200 {
		t.Fatalf("rename ana -> eva = %d", code)
	}
	after, _ := os.ReadFile(file)
	want := strings.Replace(string(before), "ana:", "eva:", 1)
	if string(after) != want {
		t.Errorf("rename changed more than the name:\n%s\nwant\n%s", after, want)
	}
	if siteStatus(t, open, base, "/cv/", "eva", "uno") != 200 || siteStatus(t, open, base, "/cv/", "ana", "uno") != 401 ||
		siteStatus(t, open, base, "/cv/", "luis", "dos") != 200 {
		t.Error("after the rename: eva must get in with ana's password, ana must not, luis unchanged")
	}
	if left, _ := filepath.Glob(filepath.Join(sites, "cv", ".password.*")); len(left) != 0 {
		t.Errorf("leftovers: %v", left)
	}
}
