package main

// =============================================================================
// Sharing: what one user lends another, and nothing more.
// =============================================================================
//
// The whole security story of sharing is TWO functions: the "shared" branch of
// ResolvePath (users.go) and Shares.RootPath (shares.go). Get either wrong and
// one account reads another's home.
//
// docs/user-sharing.md has a table of cases that were checked BY HAND with curl
// against the Python server. None of that carried over to this rewrite: until
// this file, no test here resolved a LIVE grant at all - only the refusal of
// grants that do not exist. These are those curl cases, written down.

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// lendTo is ana sharing something of hers with beto; it answers the slug the
// recipient then uses as "shared/<slug>/...".
func lendTo(t *testing.T, sh *Shares, root, app, mode string) *Grant {
	t.Helper()
	g := sh.Create("ana", "beto", root, app, "", mode)
	if g == nil {
		t.Fatalf("Create(%q) was refused", root)
	}
	return g
}

// album is a folder of ana's with one file already in it - the thing worth
// lending, and the thing a bad grant would let somebody past.
func album(t *testing.T, cfg *Config) string {
	t.Helper()
	dir := filepath.Join(cfg.HomesDir, "ana", "files", "album")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	os.WriteFile(filepath.Join(dir, "foto.jpg"), []byte("jpg"), 0o644)
	return dir
}

// sharePointsAt compares two paths the way the server does: symlinks followed,
// so a temp dir that is itself a link does not fail the test.
func sharePointsAt(got, want string) bool {
	a, err1 := resolveExisting(got)
	b, err2 := resolveExisting(want)
	return err1 == nil && err2 == nil && a == b
}

// signedInClient is a SECOND browser, for the tests that need both people at
// once. The cookie jar is what keeps the two sessions apart.
func signedInClient(t *testing.T, base, user, password string) *http.Client {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Jar:       jar,
		Transport: &http.Transport{DisableCompression: true},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	signIn(t, client, base, user, password)
	return client
}

// setUserQuota rewrites an account file with a quota in GIGABYTES (what the
// admin panel stores; UserQuotaBytes multiplies it up). gb <= 0 means no quota.
func setUserQuota(t *testing.T, srv *Server, user, password string, gb float64) {
	t.Helper()
	body := `{"password":"` + password + `"}`
	if gb > 0 {
		body = `{"password":"` + password + `","quota":` +
			strconv.FormatFloat(gb, 'f', -1, 64) + `}`
	}
	path := filepath.Join(srv.cfg.HomesDir, user, "data", "config.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// -----------------------------------------------------------------------------
// resolving a live grant
// -----------------------------------------------------------------------------

// TestSharedGrantResolves - the case that must WORK. A share nobody can open is
// not safe, it is broken.
func TestSharedGrantResolves(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	home := filepath.Join(cfg.HomesDir, "ana")
	dir := album(t, cfg)

	file := lendTo(t, users.shares, "files/mio.txt", "file", "ro")
	folder := lendTo(t, users.shares, "files/album", "photos", "ro")

	cases := []struct{ path, want string }{
		{"shared/" + file.Slug, filepath.Join(home, "files", "mio.txt")},
		{"shared/" + folder.Slug, dir},
		{"shared/" + folder.Slug + "/foto.jpg", filepath.Join(dir, "foto.jpg")},
	}
	for _, tc := range cases {
		got, writable := users.ResolvePath("user", "beto", tc.path)
		if got == "" {
			t.Errorf("ResolvePath(%q) was refused - the share does not work", tc.path)
			continue
		}
		if !sharePointsAt(got, tc.want) {
			t.Errorf("ResolvePath(%q) = %q, want %q", tc.path, got, tc.want)
		}
		// THE flag. writable=false is what makes every existing write guard
		// refuse a shared path with no extra code.
		if writable {
			t.Errorf("ResolvePath(%q) came back WRITABLE on a read-only grant", tc.path)
		}
	}

	// The slug belongs to the RECIPIENT's path space: it is not a back door
	// into ana's own home, and a third person cannot guess their way in.
	for _, who := range []string{"ana", "otro"} {
		if got, _ := users.ResolvePath("user", who, "shared/"+file.Slug); got != "" {
			t.Errorf("%s reached a share that is not theirs: %q", who, got)
		}
	}
}

// TestSharedPathStaysInsideTheGrant is the security test: what is lent is ONE
// file or ONE folder, never the home it sits in.
func TestSharedPathStaysInsideTheGrant(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	home := filepath.Join(cfg.HomesDir, "ana")
	album(t, cfg)
	os.WriteFile(filepath.Join(home, "files", "secreto.txt"), []byte("no"), 0o644)

	g := lendTo(t, users.shares, "files/album", "photos", "ro")
	slug := "shared/" + g.Slug

	refused := []string{
		slug + "/../secreto.txt",         // a sibling of the lent folder
		slug + "/../../data/config.json", // ana's password, one level up
		slug + "/../../../etc/passwd",
		slug + "/..",
		// "%2e%2e" must be caught as "..", never taken for a filename. This
		// calls ResolvePath DIRECTLY, which decodes once; over HTTP the query
		// parser has already decoded once more, so the doubly-encoded spelling
		// is checked through a real request in TestSharedPathRefusesEveryWrite.
		slug + "/%2e%2e/secreto.txt",
		slug + "/%2e%2e/%2e%2e/data/config.json",
		// "~" lends a shared TRIP's linked documents. This is a photo album, so
		// it lends nothing that way - and may not be used to address her home.
		slug + "/~/files/secreto.txt",
		slug + "/~/data/config.json",
		// Near misses on the slug itself.
		"shared/" + g.Slug + "x/foto.jpg",
		"shared/x" + g.Slug + "/foto.jpg",
	}
	for _, path := range refused {
		if got, _ := users.ResolvePath("user", "beto", path); got != "" {
			t.Errorf("ResolvePath(%q) ESCAPED the lent folder to %q", path, got)
		}
	}
}

// TestSharedSymlinkCannotLeaveTheLentFolder - the owner can plant a symlink in
// the folder they lent, and swap the folder itself for one. Both are real: they
// own those paths. Neither may turn a share into a way out.
func TestSharedSymlinkCannotLeaveTheLentFolder(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	home := filepath.Join(cfg.HomesDir, "ana")
	dir := album(t, cfg)

	// Inside the lent folder: her own account file, and the world outside.
	os.Symlink(filepath.Join(home, "data", "config.json"), filepath.Join(dir, "clave"))
	os.Symlink("/etc", filepath.Join(dir, "fuera"))
	os.Symlink(filepath.Join(cfg.HomesDir, "beto"), filepath.Join(dir, "beto"))

	g := lendTo(t, users.shares, "files/album", "photos", "ro")
	slug := "shared/" + g.Slug

	for _, path := range []string{
		slug + "/clave",
		slug + "/fuera/passwd",
		slug + "/beto/files/suyo.txt",
	} {
		if got, _ := users.ResolvePath("user", "beto", path); got != "" {
			t.Errorf("ResolvePath(%q) followed a symlink OUT of the lent folder to %q",
				path, got)
		}
	}

	// And now the grant's own root: ana swaps the whole album for a link to
	// /etc. RootPath re-checks on EVERY request precisely so that this, done
	// after the share was made, is refused rather than served.
	os.RemoveAll(dir)
	if err := os.Symlink("/etc", dir); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if root := users.shares.RootPath(g); root != "" {
		t.Errorf("RootPath followed the swapped folder to %q", root)
	}
	for _, path := range []string{slug, slug + "/passwd"} {
		if got, _ := users.ResolvePath("user", "beto", path); got != "" {
			t.Errorf("the owner swapped the share for a symlink and %q still reached %q",
				path, got)
		}
	}
}

// TestRevokeAndDropUserBiteAtOnce - a revoked share is gone on the NEXT
// request, not at the next restart, and deleting an account takes its shares
// with it in both directions.
func TestRevokeAndDropUserBiteAtOnce(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	album(t, cfg)
	g := lendTo(t, users.shares, "files/mio.txt", "file", "ro")

	if got, _ := users.ResolvePath("user", "beto", "shared/"+g.Slug); got == "" {
		t.Fatal("the share does not resolve to begin with")
	}
	// The RECIPIENT cannot revoke: it is not theirs to give back.
	if users.shares.Revoke(g.ID, "beto") {
		t.Error("the recipient revoked a share that is not theirs")
	}
	if got, _ := users.ResolvePath("user", "beto", "shared/"+g.Slug); got == "" {
		t.Error("a refused revoke still killed the share")
	}
	if !users.shares.Revoke(g.ID, "ana") {
		t.Fatal("the owner could not revoke her own share")
	}
	if got, _ := users.ResolvePath("user", "beto", "shared/"+g.Slug); got != "" {
		t.Errorf("a revoked share still resolves: %q", got)
	}

	// Deleting the account drops what it lent AND what was lent to it.
	other := lendTo(t, users.shares, "files/album", "photos", "ro")
	if n := users.shares.DropUser("ana"); n != 1 {
		t.Errorf("DropUser dropped %d grants, want 1", n)
	}
	if got, _ := users.ResolvePath("user", "beto", "shared/"+other.Slug); got != "" {
		t.Errorf("a deleted owner's share still resolves: %q", got)
	}
	if len(users.shares.ForUser("beto")) != 0 {
		t.Error("the recipient still has rows pointing at a deleted account")
	}
}

// TestCreateGuardsTheGrantItself - Create does not validate `root`: its CALLER
// does. So a bad root is a hand-edited shares.json, and RootPath is the only
// thing standing between that and the file API.
func TestCreateGuardsTheGrantItself(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	album(t, cfg)
	sh := users.shares

	escape := sh.Create("ana", "beto", "files/../../beto/files", "folder", "fuga", "ro")
	if escape == nil {
		t.Fatal("Create refused - this test needs the row to exist")
	}
	if root := sh.RootPath(escape); root != "" {
		t.Errorf("a grant with .. in its root resolved to %q", root)
	}
	if got, _ := users.ResolvePath("user", "beto", "shared/"+escape.Slug); got != "" {
		t.Errorf("a hand-edited grant reached %q", got)
	}

	// "add" only means something on a folder you can add to. On a single file
	// it quietly becomes "ro" - ONE place decides that, so no caller can store
	// a grant that means nothing.
	single := sh.Create("ana", "beto", "files/mio.txt", "file", "un archivo", "add")
	if single == nil {
		t.Fatal("Create refused")
	}
	if single.Mode != "ro" || CanAdd(single) {
		t.Errorf("add on a single file: mode = %q, CanAdd = %v; want ro, false",
			single.Mode, CanAdd(single))
	}
	if got := sh.Create("ana", "beto", "files/album", "photos", "Álbum", "add"); !CanAdd(got) {
		t.Error("add on a photo album was downgraded - that is the one case it is for")
	}
	// The same thing to the same person twice is a 409, not a second row.
	if again := sh.Create("ana", "beto", "files/mio.txt", "file", "otro nombre", "ro"); again != nil {
		t.Error("the same file was shared with the same person twice")
	}

	// TWO files that end up with the same title must NOT get the same slug:
	// the slug is the whole address, so a collision would hand the recipient
	// the wrong file.
	for _, sub := range []string{"uno", "dos"} {
		os.MkdirAll(filepath.Join(cfg.HomesDir, "ana", "files", sub), 0o755)
		os.WriteFile(filepath.Join(cfg.HomesDir, "ana", "files", sub, "informe.txt"),
			[]byte(sub), 0o644)
	}
	a := sh.Create("ana", "beto", "files/uno/informe.txt", "file", "informe.txt", "ro")
	b := sh.Create("ana", "beto", "files/dos/informe.txt", "file", "informe.txt", "ro")
	if a == nil || b == nil {
		t.Fatal("Create refused")
	}
	if a.Slug == b.Slug {
		t.Fatalf("two shares to the same person share the slug %q", a.Slug)
	}
	for slug, want := range map[string]string{a.Slug: "uno", b.Slug: "dos"} {
		got, _ := users.ResolvePath("user", "beto", "shared/"+slug)
		raw, _ := os.ReadFile(got)
		if string(raw) != want {
			t.Errorf("shared/%s opened %q, want the file from %s/", slug, raw, want)
		}
	}
}

// -----------------------------------------------------------------------------
// through the file API
// -----------------------------------------------------------------------------

// TestSharedPathRefusesEveryWrite - read-only means read: the five ways to
// change something all answer 403, and the owner's bytes are still there after.
func TestSharedPathRefusesEveryWrite(t *testing.T) {
	srv, ts, client := newTestServer(t)
	dir := album(t, srv.cfg)
	g := srv.shares.Create("ana", "beto", "files/album", "photos", "Álbum", "ro")
	if g == nil {
		t.Fatal("Create refused")
	}
	signIn(t, client, ts.URL, "beto", "xyz")
	base := "/api/files?file=shared/" + g.Slug

	resp := do(t, client, "GET", ts.URL+base+"/foto.jpg", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET a shared file = %d, want 200 - reading is the point", resp.StatusCode)
	}

	// Traversal through the REAL request path, where the query parser decodes
	// once and ResolvePath decodes again - so the doubly-encoded spelling is
	// the one that becomes "..". Whatever it decodes to, the secret next door
	// must never come back.
	secret := filepath.Join(srv.cfg.HomesDir, "ana", "files", "secreto.txt")
	os.WriteFile(secret, []byte("la clave de ana"), 0o644)
	for _, tail := range []string{
		"/../secreto.txt",
		"/%2e%2e/secreto.txt",
		"/%252e%252e/secreto.txt",
		"/../../data/config.json",
	} {
		resp := do(t, client, "GET", ts.URL+base+tail, nil, nil)
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Errorf("GET %s = 200 and returned %q", tail, raw)
		}
		if strings.Contains(string(raw), "la clave de ana") {
			t.Errorf("GET %s handed over the file next door", tail)
		}
	}

	for _, c := range []struct{ label, method, url, body string }{
		{"overwrite the owner's file", "PUT", base + "/foto.jpg", "destruida"},
		{"add a file", "PUT", base + "/nueva.txt", "hola"},
		{"make a folder", "PUT", "/api/files?type=dir&name=sub&parent=shared/" + g.Slug, ""},
		{"trash it", "DELETE", "/api/files?paths=shared/" + g.Slug + "/foto.jpg", ""},
		{"rename it", "POST",
			"/api/files?old=shared/" + g.Slug + "/foto.jpg&new=shared/" + g.Slug + "/otra.jpg", ""},
		{"move it out into my own home", "POST",
			"/api/files?old=shared/" + g.Slug + "/foto.jpg&new=files/robada.jpg", ""},
	} {
		var body io.Reader
		if c.body != "" {
			body = strings.NewReader(c.body)
		}
		resp := do(t, client, c.method, ts.URL+c.url, body, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s: %s = %d, want 403", c.label, c.method, resp.StatusCode)
		}
	}

	if raw, _ := os.ReadFile(filepath.Join(dir, "foto.jpg")); string(raw) != "jpg" {
		t.Errorf("the owner's file changed to %q", raw)
	}
	if pathExists(filepath.Join(dir, "nueva.txt")) {
		t.Error("a read-only share let somebody add a file")
	}
}

// TestAddModeOnlyAdds - "pueden añadir archivos" grants exactly ONE new right:
// a PUT on a name that is not there yet. The other four stay shut, and this is
// the mode where that matters, because here writable really is true.
func TestAddModeOnlyAdds(t *testing.T) {
	srv, ts, client := newTestServer(t)
	dir := album(t, srv.cfg)
	g := srv.shares.Create("ana", "beto", "files/album", "photos", "Álbum", "add")
	if g == nil || !CanAdd(g) {
		t.Fatal("the add grant was not created")
	}
	signIn(t, client, ts.URL, "beto", "xyz")
	base := "/api/files?file=shared/" + g.Slug

	// 1. A NEW name goes in, and lands in ANA's folder, not beto's.
	resp := do(t, client, "PUT", ts.URL+base+"/mia.jpg", strings.NewReader("la mía"), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("adding a new file = %d, want 200", resp.StatusCode)
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "mia.jpg")); err != nil || string(raw) != "la mía" {
		t.Errorf("the added file is not in the owner's folder: %q (%v)", raw, err)
	}

	// 2. A name that IS there: 409, and the owner's bytes survive. An overwrite
	// here would destroy their file with no trip through the papelera.
	resp = do(t, client, "PUT", ts.URL+base+"/foto.jpg", strings.NewReader("destruida"), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("overwriting on an add grant = %d, want 409", resp.StatusCode)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "foto.jpg")); string(raw) != "jpg" {
		t.Errorf("the owner's file was overwritten: %q", raw)
	}

	// 3. Everything else is still refused - including deleting the file beto
	// himself just added. You put photos in; you never take any out.
	for _, c := range []struct{ label, method, url string }{
		{"delete my own upload", "DELETE", "/api/files?paths=shared/" + g.Slug + "/mia.jpg"},
		{"delete the owner's file", "DELETE", "/api/files?paths=shared/" + g.Slug + "/foto.jpg"},
		{"make a folder", "PUT", "/api/files?type=dir&name=sub&parent=shared/" + g.Slug},
		{"rename my own upload", "POST",
			"/api/files?old=shared/" + g.Slug + "/mia.jpg&new=shared/" + g.Slug + "/otra.jpg"},
		{"move it out", "POST",
			"/api/files?old=shared/" + g.Slug + "/mia.jpg&new=files/robada.jpg"},
	} {
		resp := do(t, client, c.method, ts.URL+c.url, nil, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s on an add grant = %d, want 403", c.label, resp.StatusCode)
		}
	}
	if !pathExists(filepath.Join(dir, "mia.jpg")) || !pathExists(filepath.Join(dir, "foto.jpg")) {
		t.Error("something was deleted out of the shared folder")
	}

	// 4. And it cannot be passed on. On an add grant the path IS writable, so
	// this is the one case where only the explicit IsSharedPath check refuses.
	resp = do(t, client, "POST", ts.URL+"/api/shares",
		strings.NewReader(`{"to":"ana","root":"shared/`+g.Slug+`"}`),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("re-sharing what was lent to me = %d, want 403", resp.StatusCode)
	}
}

// TestAddModeSpendsTheOwnersQuota - the bytes land in the owner's home, so they
// are the owner's bytes. If the guest's quota were charged instead, a full
// account could be filled from outside and a guest would pay for a disk they
// never touched.
func TestAddModeSpendsTheOwnersQuota(t *testing.T) {
	srv, ts, client := newTestServer(t)
	album(t, srv.cfg)
	g := srv.shares.Create("ana", "beto", "files/album", "photos", "Álbum", "add")
	if g == nil {
		t.Fatal("Create refused")
	}
	signIn(t, client, ts.URL, "beto", "xyz")
	url := ts.URL + "/api/files?file=shared/" + g.Slug + "/grande.bin"
	big := strings.Repeat("x", 8192)

	// ANA is full; beto has no quota at all. Refused - it is her disk.
	setUserQuota(t, srv, "ana", "abc", 0.000001) // ~1 KB
	setUserQuota(t, srv, "beto", "xyz", 0)
	resp := do(t, client, "PUT", url, strings.NewReader(big), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusInsufficientStorage {
		t.Errorf("adding to a FULL owner's folder = %d, want 507", resp.StatusCode)
	}
	if pathExists(filepath.Join(srv.cfg.HomesDir, "ana", "files", "album", "grande.bin")) {
		t.Error("the file was written past the owner's quota")
	}

	// The other way round: BETO is full, ana is not. The same upload must go
	// through - his quota was never the one that mattered.
	setUserQuota(t, srv, "ana", "abc", 0)
	setUserQuota(t, srv, "beto", "xyz", 0.000001)
	srv.users.ForgetUsage("ana")
	srv.users.ForgetUsage("beto")
	resp = do(t, client, "PUT", url, strings.NewReader(big), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("adding while the GUEST is full = %d, want 200 - the owner pays",
			resp.StatusCode)
	}
}

// -----------------------------------------------------------------------------
// making a share
// -----------------------------------------------------------------------------

// TestShareCreateRefusals - every way of asking for something that is not yours
// to give. One condition per request: the checks run in order, so a body that
// breaks two rules only ever proves the first.
func TestShareCreateRefusals(t *testing.T) {
	srv, ts, client := newTestServer(t)
	album(t, srv.cfg)
	signIn(t, client, ts.URL, "ana", "abc")

	post := func(body string) int {
		resp := do(t, client, "POST", ts.URL+"/api/shares", strings.NewReader(body),
			map[string]string{"Content-Type": "application/json"})
		defer resp.Body.Close()
		return resp.StatusCode
	}

	for _, c := range []struct {
		label, body string
		want        int
	}{
		{"with myself", `{"to":"ana","root":"files/mio.txt"}`, http.StatusBadRequest},
		{"with nobody", `{"to":"","root":"files/mio.txt"}`, http.StatusBadRequest},
		{"with somebody who is not here", `{"to":"nadie","root":"files/mio.txt"}`,
			http.StatusBadRequest},
		{"nothing at all", `{"to":"beto","root":""}`, http.StatusBadRequest},
		{"a whole root folder", `{"to":"beto","root":"files"}`, http.StatusBadRequest},
		{"the other root folder", `{"to":"beto","root":"data"}`, http.StatusBadRequest},
		// data/config.json IS the account: its password and its quota.
		{"my own account file", `{"to":"beto","root":"data/config.json"}`,
			http.StatusBadRequest},
		{"the apps themselves", `{"to":"beto","root":"apps/index.html"}`,
			http.StatusForbidden},
		{"somebody else's home", `{"to":"beto","root":"homes/beto/files/suyo.txt"}`,
			http.StatusForbidden},
		{"my way out of the sandbox", `{"to":"beto","root":"../../etc/passwd"}`,
			http.StatusForbidden},
		{"a file that is not there", `{"to":"beto","root":"files/inventado.txt"}`,
			http.StatusNotFound},
	} {
		if got := post(c.body); got != c.want {
			t.Errorf("sharing %s = %d, want %d", c.label, got, c.want)
		}
	}

	// What must work - and must not work twice.
	if got := post(`{"to":"beto","root":"files/mio.txt"}`); got != http.StatusCreated {
		t.Fatalf("sharing my own file = %d, want 201", got)
	}
	if got := post(`{"to":"beto","root":"files/mio.txt"}`); got != http.StatusConflict {
		t.Errorf("sharing the same file twice = %d, want 409", got)
	}

	// The admin has no home to share from, and its paths mean something else
	// entirely - it is kept out of this completely, read side included.
	admin := signedInClient(t, ts.URL, "jefe", "secreto")
	for _, method := range []string{"GET", "POST", "DELETE"} {
		resp := do(t, admin, method, ts.URL+"/api/shares",
			strings.NewReader(`{"to":"beto","root":"homes/ana/files/mio.txt"}`),
			map[string]string{"Content-Type": "application/json"})
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("the admin's %s /api/shares = %d, want 403", method, resp.StatusCode)
		}
	}
}

// TestUsersListIsNamesOnly - the share picker needs the other names and nothing
// else. A regular user cannot call /api/admin, so this is the one place an
// account list leaks, and it must leak as little as possible.
func TestUsersListIsNamesOnly(t *testing.T) {
	_, ts, client := newTestServer(t)

	resp := do(t, client, "GET", ts.URL+"/api/users", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("/api/users with no session = %d, want 401", resp.StatusCode)
	}

	signIn(t, client, ts.URL, "ana", "abc")
	resp = do(t, client, "GET", ts.URL+"/api/users", nil, nil)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	body := string(raw)

	if !strings.Contains(body, `"beto"`) {
		t.Errorf("the other user is missing, so nobody can be picked: %s", body)
	}
	if strings.Contains(body, `"ana"`) {
		t.Errorf("the list offers me myself: %s", body)
	}
	for _, leak := range []string{"password", "abc", "xyz", "quota", "secreto", "jefe"} {
		if strings.Contains(body, leak) {
			t.Errorf("/api/users leaked %q: %s", leak, body)
		}
	}
}
