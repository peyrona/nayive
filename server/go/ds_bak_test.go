package main

// Data-safety seal (2026-10-05, docs/upload-less-plan.md step 1b): the office
// editors' .bak copy is made on the server (POST ?from=<path>&bak=1). It
// replaces only the .bak of that file, inside .bak/, only from the version
// the save was made from, and never past the quota.

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func dsBak(t *testing.T, client *http.Client, base, rel string, h map[string]string) int {
	t.Helper()
	resp := do(t, client, "POST", base+"/api/files?from="+rel+"&bak=1", nil, h)
	resp.Body.Close()
	return resp.StatusCode
}

// TestDS_Bak_ReplacesOnlyItsOwn: the file's bytes land in <dir>/.bak/<name>,
// over the old .bak - and nothing else changes: not the file, not a file of
// that name outside .bak/.
func TestDS_Bak_ReplacesOnlyItsOwn(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	home := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(home, "Cartas", ".bak"), 0o755)
	os.WriteFile(filepath.Join(home, "Cartas", "carta.docx"), []byte("version two"), 0o644)
	os.WriteFile(filepath.Join(home, "Cartas", ".bak", "carta.docx"), []byte("version one"), 0o644)
	os.WriteFile(filepath.Join(home, "carta.docx"), []byte("another file"), 0o644)

	tag := dsGetTag(t, client, ts.URL, "files/Cartas/carta.docx")
	if code := dsBak(t, client, ts.URL, "files/Cartas/carta.docx", map[string]string{"If-Match": tag}); code != http.StatusOK {
		t.Fatalf("bak = %d, want 200", code)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "Cartas", ".bak", "carta.docx")); string(b) != "version two" {
		t.Errorf(".bak holds %q, want the file's bytes", b)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "Cartas", "carta.docx")); string(b) != "version two" {
		t.Errorf("the file itself changed: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "carta.docx")); string(b) != "another file" {
		t.Errorf("a file of that name outside .bak/ changed: %q", b)
	}

	// A file with no .bak/ yet: the folder is made.
	os.WriteFile(filepath.Join(home, "nueva.txt"), []byte("hola"), 0o644)
	if code := dsBak(t, client, ts.URL, "files/nueva.txt", nil); code != http.StatusOK {
		t.Fatalf("bak with no .bak/ = %d", code)
	}
	if b, _ := os.ReadFile(filepath.Join(home, ".bak", "nueva.txt")); string(b) != "hola" {
		t.Errorf("files/.bak/nueva.txt = %q", b)
	}
}

// TestDS_Bak_OnlyFromTheSavedVersion: a file another device changed since the
// save was made keeps its .bak (412) - the .bak is the copy from BEFORE this
// session's first save, not someone else's newer one.
func TestDS_Bak_OnlyFromTheSavedVersion(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	home := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(home, ".bak"), 0o755)
	os.WriteFile(filepath.Join(home, "a.txt"), []byte("mine"), 0o644)
	os.WriteFile(filepath.Join(home, ".bak", "a.txt"), []byte("the old copy"), 0o644)
	held := dsGetTag(t, client, ts.URL, "files/a.txt")

	if code, _ := dsPutTag(t, client, ts.URL, "files/a.txt", "the phone's", nil); code != http.StatusOK {
		t.Fatalf("the phone's PUT = %d", code)
	}
	if code := dsBak(t, client, ts.URL, "files/a.txt", map[string]string{"If-Match": held}); code != http.StatusPreconditionFailed {
		t.Errorf("bak from an old version = %d, want 412", code)
	}
	if b, _ := os.ReadFile(filepath.Join(home, ".bak", "a.txt")); string(b) != "the old copy" {
		t.Errorf(".bak changed: %q", b)
	}
	if code := dsBak(t, client, ts.URL, "files/missing.txt", nil); code != http.StatusNotFound {
		t.Errorf("bak of a missing file = %d, want 404", code)
	}
	if _, err := os.Stat(filepath.Join(home, ".bak", "missing.txt")); err == nil {
		t.Errorf("a .bak appeared for a file that is not there")
	}
}

// TestDS_Bak_NeverOutsideOrShared: a path inside .bak/ itself, a shared
// path and a folder are refused, and a .bak name taken by a folder is never
// replaced.
func TestDS_Bak_NeverOutsideOrShared(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	home := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(home, ".bak", "x.txt"), 0o755) // a folder where the .bak would go
	os.WriteFile(filepath.Join(home, ".bak", "x.txt", "keep"), []byte("keep"), 0o644)
	os.WriteFile(filepath.Join(home, "x.txt"), []byte("x"), 0o644)
	os.MkdirAll(filepath.Join(home, "dir"), 0o755)

	if code := dsBak(t, client, ts.URL, "files/x.txt", nil); code != http.StatusConflict {
		t.Errorf("bak over a folder = %d, want 409", code)
	}
	if b, _ := os.ReadFile(filepath.Join(home, ".bak", "x.txt", "keep")); string(b) != "keep" {
		t.Errorf("the folder in the way lost its file")
	}
	if code := dsBak(t, client, ts.URL, "files/.bak/x.txt", nil); code != http.StatusBadRequest {
		t.Errorf("bak of a .bak = %d, want 400", code)
	}
	if code := dsBak(t, client, ts.URL, "files/dir", nil); code != http.StatusNotFound {
		t.Errorf("bak of a folder = %d, want 404", code)
	}
	if code := dsBak(t, client, ts.URL, "shared/someone/x.txt", nil); code != http.StatusForbidden && code != http.StatusNotFound {
		t.Errorf("bak in a shared path = %d, want 403/404", code)
	}
}

// TestDS_Bak_Quota: a copy that does not fit is refused (507) and the old
// .bak stays.
func TestDS_Bak_Quota(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	home := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(home, ".bak"), 0o755)
	os.WriteFile(filepath.Join(home, "big.bin"), make([]byte, 6000), 0o644)
	os.WriteFile(filepath.Join(home, ".bak", "big.bin"), []byte("small"), 0o644)
	setUserQuota(t, srv, "ana", "abc", 0.00001) // ~10 KB: 6 KB used, no room for 6 KB more
	srv.users.ForgetUsage("ana")

	if code := dsBak(t, client, ts.URL, "files/big.bin", nil); code != http.StatusInsufficientStorage {
		t.Errorf("bak past the quota = %d, want 507", code)
	}
	if b, _ := os.ReadFile(filepath.Join(home, ".bak", "big.bin")); string(b) != "small" {
		t.Errorf("the old .bak changed: %d bytes", len(b))
	}
}
