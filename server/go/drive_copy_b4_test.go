package main

// Contract B: POST /api/files?from=&new= - Drive's "Copy to..." done on
// the server (copy.go), so a big video never goes through the browser.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// copyReq is one copy; it answers the status and the decoded body.
func copyReq(t *testing.T, c *http.Client, base, from, to string) (int, map[string]any) {
	t.Helper()
	q := url.Values{"from": {from}, "new": {to}}
	resp := do(t, c, "POST", base+"/api/files?"+q.Encode(), nil, nil)
	defer resp.Body.Close()
	var body map[string]any
	raw, _ := io.ReadAll(resp.Body)
	json.Unmarshal(raw, &body)
	return resp.StatusCode, body
}

func readOr(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return "<" + err.Error() + ">"
	}
	return string(b)
}

// TestCopyFile: a file is copied as a NEW file (own inode), the source stays,
// the answer says one file, and the owner's usage grows by its size.
func TestCopyFile(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	before := srv.users.UserUsageBytes("ana")

	code, body := copyReq(t, client, ts.URL, "files/mio.txt", "files/sub/copia.txt")
	if code != http.StatusOK || body["message"] != "copied" || body["files"] != float64(1) {
		t.Fatalf("copy = %d %v", code, body)
	}
	if got := readOr(filepath.Join(files, "sub", "copia.txt")); got != "mío\n" {
		t.Errorf("the copy holds %q", got)
	}
	if got := readOr(filepath.Join(files, "mio.txt")); got != "mío\n" {
		t.Errorf("the source now holds %q", got)
	}
	a, _ := os.Stat(filepath.Join(files, "mio.txt"))
	b, _ := os.Stat(filepath.Join(files, "sub", "copia.txt"))
	if fileID(a) == fileID(b) {
		t.Error("the copy shares the source's inode: it is a link, not a new file")
	}
	if b.Mode().Perm() != 0o644 {
		t.Errorf("the copy's mode = %v, want 0644", b.Mode().Perm())
	}
	if got := srv.users.UserUsageBytes("ana") - before; got != int64(len("mío\n")) {
		t.Errorf("usage grew by %d", got)
	}
	// No temp left behind in the folder.
	ents, _ := os.ReadDir(filepath.Join(files, "sub"))
	if len(ents) != 1 {
		t.Errorf("the folder holds %d entries, want only the copy", len(ents))
	}
}

// TestCopyFolder: a folder is copied whole, sub-folders and all, and a grant
// on the original stays where it was (a copy is not a move).
func TestCopyFolder(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	dir := album(t, srv.cfg)
	os.MkdirAll(filepath.Join(dir, "a", "b"), 0o755)
	os.MkdirAll(filepath.Join(dir, "vacia"), 0o755)
	os.WriteFile(filepath.Join(dir, "a", "b", "hondo.txt"), []byte("hondo"), 0o644)
	os.WriteFile(filepath.Join(dir, ".upload-abcdefgh"), []byte("temp"), 0o600)
	g := lendTo(t, srv.shares, "files/album", "photos", "ro")

	code, body := copyReq(t, client, ts.URL, "files/album", "files/album2")
	if code != http.StatusOK || body["files"] != float64(2) {
		t.Fatalf("copy = %d %v", code, body)
	}
	to := filepath.Join(srv.cfg.HomesDir, "ana", "files", "album2")
	if readOr(filepath.Join(to, "foto.jpg")) != "jpg" || readOr(filepath.Join(to, "a", "b", "hondo.txt")) != "hondo" {
		t.Error("the copy lacks a file")
	}
	if info, err := os.Stat(filepath.Join(to, "vacia")); err != nil || !info.IsDir() {
		t.Error("an empty sub-folder was not copied")
	}
	if pathExists(filepath.Join(to, ".upload-abcdefgh")) {
		t.Error("a half-written temp was copied")
	}
	if readOr(filepath.Join(dir, "foto.jpg")) != "jpg" {
		t.Error("the source changed")
	}
	for _, x := range srv.shares.ByOwner("ana") {
		if x.ID == g.ID && x.Root != "files/album" {
			t.Errorf("the grant moved to %q", x.Root)
		}
	}
}

// TestCopyNeverOverwrites: onto a file or a folder that is there -> 409, and
// what was there is untouched. A folder into itself is refused.
func TestCopyNeverOverwrites(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	dir := album(t, srv.cfg)
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.WriteFile(filepath.Join(files, "otro.txt"), []byte("otro"), 0o644)
	os.MkdirAll(filepath.Join(files, "ocupada"), 0o755)

	if code, _ := copyReq(t, client, ts.URL, "files/mio.txt", "files/otro.txt"); code != http.StatusConflict {
		t.Errorf("file onto a file = %d, want 409", code)
	}
	if readOr(filepath.Join(files, "otro.txt")) != "otro" {
		t.Error("the file already there was overwritten")
	}
	if code, _ := copyReq(t, client, ts.URL, "files/album", "files/ocupada"); code != http.StatusConflict {
		t.Errorf("folder onto a folder = %d, want 409", code)
	}
	if pathExists(filepath.Join(files, "ocupada", "foto.jpg")) {
		t.Error("the folder copy went into the folder already there")
	}
	if code, _ := copyReq(t, client, ts.URL, "files/album", "files/album/dentro"); code != http.StatusBadRequest {
		t.Errorf("folder into itself = %d, want 400", code)
	}
	if pathExists(filepath.Join(dir, "dentro")) {
		t.Error("a folder copied into itself left something")
	}
	if code, _ := copyReq(t, client, ts.URL, "files/nada.txt", "files/n2.txt"); code != http.StatusNotFound {
		t.Errorf("a missing source = %d, want 404", code)
	}
}

// TestCopyQuota: a copy that would not fit is refused before a byte is
// written: 507, nothing at the destination.
func TestCopyQuota(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.WriteFile(filepath.Join(files, "grande.bin"), make([]byte, 6000), 0o644)
	setUserQuota(t, srv, "ana", "abc", 0.00001) // ~10 KB
	srv.users.ForgetUsage("ana")

	if code, _ := copyReq(t, client, ts.URL, "files/grande.bin", "files/grande2.bin"); code != http.StatusInsufficientStorage {
		t.Errorf("copy over the quota = %d, want 507", code)
	}
	if pathExists(filepath.Join(files, "grande2.bin")) {
		t.Error("a refused copy left a file")
	}
	os.MkdirAll(filepath.Join(files, "carpeta"), 0o755)
	os.WriteFile(filepath.Join(files, "carpeta", "g.bin"), make([]byte, 6000), 0o644)
	srv.users.ForgetUsage("ana")
	if code, _ := copyReq(t, client, ts.URL, "files/carpeta", "files/carpeta2"); code != http.StatusInsufficientStorage {
		t.Errorf("folder copy over the quota = %d, want 507", code)
	}
	if pathExists(filepath.Join(files, "carpeta2")) {
		t.Error("a refused folder copy left a folder")
	}
	// A small one still fits.
	os.RemoveAll(filepath.Join(files, "carpeta"))
	srv.users.ForgetUsage("ana")
	if code, _ := copyReq(t, client, ts.URL, "files/mio.txt", "files/mio2.txt"); code != http.StatusOK {
		t.Errorf("a copy that fits = %d", code)
	}
}

// TestCopyShares: out of a read-only share is allowed (into the own home);
// into a share - even an "add" one - never.
func TestCopyShares(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	album(t, srv.cfg)
	ro := lendTo(t, srv.shares, "files/album", "photos", "ro")
	beto := signedInClient(t, ts.URL, "beto", "xyz")
	betoFiles := filepath.Join(srv.cfg.HomesDir, "beto", "files")

	if code, body := copyReq(t, beto, ts.URL, "shared/"+ro.Slug+"/foto.jpg", "files/foto.jpg"); code != http.StatusOK {
		t.Fatalf("copy out of a read-only share = %d %v", code, body)
	}
	if readOr(filepath.Join(betoFiles, "foto.jpg")) != "jpg" {
		t.Error("the copied photo is not in beto's files")
	}
	if code, _ := copyReq(t, beto, ts.URL, "shared/"+ro.Slug, "files/album-de-ana"); code != http.StatusOK {
		t.Errorf("copy of the whole shared folder = %d", code)
	}
	if readOr(filepath.Join(betoFiles, "album-de-ana", "foto.jpg")) != "jpg" {
		t.Error("the copied shared folder lacks its photo")
	}

	os.MkdirAll(filepath.Join(srv.cfg.HomesDir, "ana", "files", "buzon"), 0o755)
	add := lendTo(t, srv.shares, "files/buzon", "photos", "add")
	if code, _ := copyReq(t, beto, ts.URL, "files/suyo.txt", "shared/"+add.Slug+"/suyo.txt"); code != http.StatusForbidden {
		t.Errorf("copy INTO an add share = %d, want 403", code)
	}
	if code, _ := copyReq(t, beto, ts.URL, "files/suyo.txt", "shared/"+ro.Slug+"/suyo.txt"); code != http.StatusForbidden {
		t.Errorf("copy INTO a read-only share = %d, want 403", code)
	}
	if pathExists(filepath.Join(srv.cfg.HomesDir, "ana", "files", "buzon", "suyo.txt")) {
		t.Error("a refused copy landed in ana's folder")
	}
	// Someone else's home is not a share.
	if code, _ := copyReq(t, beto, ts.URL, "../ana/files/mio.txt", "files/robado.txt"); code != http.StatusForbidden {
		t.Errorf("copy out of another home = %d, want 403", code)
	}
}

// TestCopyRefusals: the structural folders, the account file, the Chat/eMail
// data and the bin are refused at either end, as move refuses them.
func TestCopyRefusals(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	home := filepath.Join(srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "data", "chat"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "chat", "c.json"), []byte("{}"), 0o644)
	os.MkdirAll(filepath.Join(home, ".trash", "x"), 0o755)
	os.WriteFile(filepath.Join(home, ".trash", "x", "t.txt"), []byte("t"), 0o644)

	for _, c := range []struct{ from, to string }{
		{"files", "files/todo"},
		{"data", "files/datos"},
		{"data/config.json", "files/config.json"},
		{"data/chat", "files/chat"},
		{"data/chat/c.json", "files/c.json"},
		{".trash/x/t.txt", "files/t.txt"},
		{"files/mio.txt", ".trash/mio.txt"},
		{"files/mio.txt", "files/.trash/mio.txt"},
		{"files/mio.txt", "data/chat/mio.txt"},
		{"files/mio.txt", "data/config.json"},
		{"files/mio.txt", "apps/mio.txt"},
	} {
		if code, _ := copyReq(t, client, ts.URL, c.from, c.to); code != http.StatusForbidden {
			t.Errorf("copy %s -> %s = %d, want 403", c.from, c.to, code)
		}
	}
	for _, p := range []string{"files/todo", "files/datos", "files/config.json", "files/chat",
		"files/c.json", "files/t.txt", "files/.trash", "data/chat/mio.txt"} {
		if pathExists(filepath.Join(home, p)) {
			t.Errorf("a refused copy made %s", p)
		}
	}
	// (Signing in may rewrite it - a password hashed at login - so the test
	// is only that nothing was copied over it.)
	if got := readOr(filepath.Join(home, "data", "config.json")); strings.Contains(got, "mío") {
		t.Errorf("the account file was overwritten: %q", got)
	}
	// The admin: never a home, config/ or apps/.
	admin := signedInClient(t, ts.URL, "jefe", "secreto")
	for _, c := range []struct{ from, to string }{
		{"homes/ana", "homes/ana2"},
		{"config", "config2"},
		{"homes/ana/files/mio.txt", "config/mio.txt"},
		{"apps", "apps2"},
	} {
		if code, _ := copyReq(t, admin, ts.URL, c.from, c.to); code != http.StatusForbidden {
			t.Errorf("admin copy %s -> %s = %d, want 403", c.from, c.to, code)
		}
	}
	// ...but a file from one home to another, yes.
	if code, _ := copyReq(t, admin, ts.URL, "homes/ana/files/mio.txt", "homes/beto/files/de-ana.txt"); code != http.StatusOK {
		t.Errorf("admin copy between homes = %d", code)
	}
	if readOr(filepath.Join(srv.cfg.HomesDir, "beto", "files", "de-ana.txt")) != "mío\n" {
		t.Error("the admin's copy is not in beto's home")
	}
}

// TestCopySymlinks: a link inside the copied folder is never followed and
// never copied - not one out of the home (beto's file, /etc), not one inside
// it. A link AS the source that leads out of the home is refused.
func TestCopySymlinks(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	dir := filepath.Join(files, "dir")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "propio.txt"), []byte("propio"), 0o644)
	betoFile := filepath.Join(srv.cfg.HomesDir, "beto", "files", "suyo.txt")
	os.Symlink(betoFile, filepath.Join(dir, "leak"))
	os.Symlink("../../../beto/files", filepath.Join(dir, "leakdir"))
	os.Symlink("/etc/hostname", filepath.Join(dir, "etc"))
	os.Symlink("../mio.txt", filepath.Join(dir, "dentro"))
	os.Symlink(betoFile, filepath.Join(files, "enlace.txt"))

	code, body := copyReq(t, client, ts.URL, "files/dir", "files/dir2")
	if code != http.StatusOK || body["files"] != float64(1) {
		t.Fatalf("copy = %d %v", code, body)
	}
	to := filepath.Join(files, "dir2")
	ents, _ := os.ReadDir(to)
	if len(ents) != 1 || ents[0].Name() != "propio.txt" {
		names := []string{}
		for _, e := range ents {
			names = append(names, e.Name())
		}
		t.Errorf("the copy holds %v, want only propio.txt", names)
	}
	filepath.Walk(to, func(p string, info os.FileInfo, err error) error {
		if err == nil && info.Mode().IsRegular() && strings.Contains(readOr(p), "de beto") {
			t.Errorf("beto's bytes leaked into %s", p)
		}
		return nil
	})
	if code, _ := copyReq(t, client, ts.URL, "files/enlace.txt", "files/robado.txt"); code != http.StatusForbidden {
		t.Errorf("a link out of the home as the source = %d, want 403", code)
	}
	if pathExists(filepath.Join(files, "robado.txt")) {
		t.Error("a link out of the home was copied")
	}
}
