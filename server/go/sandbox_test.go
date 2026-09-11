package main

// =============================================================================
// The race os.Root closes (review item C1).
// =============================================================================
//
// Resolve approves a path; between that and its use, a folder on the way is
// swapped for a symlink pointing OUT of the home. The old code followed it,
// because every operation was a plain os.* call on an absolute path. Each
// operation below must now refuse - and the folder outside must come out
// exactly as it went in.
//
// Splitting Resolve from the operation is what makes the race deterministic:
// the test swaps in between the two, with no timing involved.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// swapOut resolves files/sub/<name> for ana, then replaces files/sub with a
// symlink to a folder outside every home holding its own <name>. It returns
// the now-stale approval and that outside folder.
func swapOut(t *testing.T, srv *Server, name string) (Resolved, string) {
	t.Helper()
	sub := filepath.Join(srv.cfg.HomesDir, "ana", "files", "sub")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(sub, name), []byte("mío\n"), 0o644)

	p, ok := srv.users.Resolve("user", "ana", "files/sub/"+name)
	if !ok {
		t.Fatalf("Resolve refused a plain path")
	}

	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, name), []byte("SECRETO\n"), 0o644)
	if err := os.Rename(sub, sub+"-antes"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if err := os.Symlink(outside, sub); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	// Proof the swap really escapes: a plain os call on the approved absolute
	// path - which is what every operation used to be - now reaches the
	// secret. Without this, the tests below could pass for the wrong reason.
	if b, _ := os.ReadFile(p.Abs); string(b) != "SECRETO\n" {
		t.Fatalf("the swap did not escape (%q) - the test proves nothing", b)
	}
	return p, outside
}

// checkUntouched fails unless the outside folder still holds exactly its one
// file, with its original content.
func checkUntouched(t *testing.T, outside, name string) {
	t.Helper()
	entries, _ := os.ReadDir(outside)
	names := []string{}
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 1 || names[0] != name {
		t.Errorf("the folder outside the home was changed: %v", names)
	}
	if b, _ := os.ReadFile(filepath.Join(outside, name)); string(b) != "SECRETO\n" {
		t.Errorf("the file outside the home was changed: %q", b)
	}
}

func TestSandboxRefusesSwappedFolder(t *testing.T) {
	t.Run("read", func(t *testing.T) {
		srv, _, _ := newTestServer(t)
		p, outside := swapOut(t, srv, "x.txt")
		req := httptest.NewRequest("GET", "/api/files?file=files/sub/x.txt", nil)
		rec := httptest.NewRecorder()
		srv.filesRead(rec, req, p, cleanQuery(req))
		if strings.Contains(rec.Body.String(), "SECRETO") {
			t.Errorf("read LEAKED the file outside the home")
		}
		if rec.Code != http.StatusNotFound {
			t.Errorf("read = %d, want 404", rec.Code)
		}
		checkUntouched(t, outside, "x.txt")
	})

	t.Run("write", func(t *testing.T) {
		srv, _, _ := newTestServer(t)
		p, outside := swapOut(t, srv, "x.txt")
		req := httptest.NewRequest("PUT", "/api/files?file=files/sub/x.txt",
			strings.NewReader("pisado\n"))
		rec := httptest.NewRecorder()
		if _, err := srv.streamToFile(rec, req, p, -1); err == nil {
			t.Errorf("an upload went through the swapped folder")
		}
		checkUntouched(t, outside, "x.txt")
	})

	t.Run("mkdir", func(t *testing.T) {
		srv, _, _ := newTestServer(t)
		p, outside := swapOut(t, srv, "x.txt")
		if err := p.at(filepath.Join(filepath.Dir(p.Rel), "nueva")).MkdirAll(); err == nil {
			t.Errorf("mkdir went through the swapped folder")
		}
		checkUntouched(t, outside, "x.txt")
	})

	t.Run("move out", func(t *testing.T) {
		srv, _, _ := newTestServer(t)
		p, outside := swapOut(t, srv, "x.txt")
		if err := renameResolved(p, p.at("files/movido.txt")); err == nil {
			t.Errorf("a move pulled a file out through the swapped folder")
		}
		checkUntouched(t, outside, "x.txt")
	})

	t.Run("move in", func(t *testing.T) {
		srv, _, _ := newTestServer(t)
		p, outside := swapOut(t, srv, "x.txt")
		src, ok := srv.users.Resolve("user", "ana", "files/mio.txt")
		if !ok {
			t.Fatalf("Resolve refused files/mio.txt")
		}
		dst := p.at(filepath.Join(filepath.Dir(p.Rel), "llegado.txt"))
		if err := renameResolved(src, dst); err == nil {
			t.Errorf("a move pushed a file out through the swapped folder")
		}
		checkUntouched(t, outside, "x.txt")
		if !src.Exists() {
			t.Errorf("the source of the refused move is gone")
		}
	})

	t.Run("trash", func(t *testing.T) {
		srv, _, _ := newTestServer(t)
		p, outside := swapOut(t, srv, "x.txt")
		if _, err := srv.trash.MoveIn("user", "ana", p, "files/sub/x.txt"); err == nil {
			t.Errorf("the trash took a file through the swapped folder")
		}
		checkUntouched(t, outside, "x.txt")
		if items := srv.trash.List("user", "ana"); len(items) != 0 {
			t.Errorf("a refused move left %d row(s) in the papelera", len(items))
		}
	})

	t.Run("purge", func(t *testing.T) {
		srv, _, _ := newTestServer(t)
		p, outside := swapOut(t, srv, "x.txt")
		if err := p.Remove(); err == nil {
			t.Errorf("a purge deleted through the swapped folder")
		}
		checkUntouched(t, outside, "x.txt")
	})
}

// TestSandboxKeepsInHomeSymlinks is the other half: a symlink that stays
// INSIDE the home still works, exactly as on the Python. os.Root only adds a
// refusal; it must take nothing away.
func TestSandboxKeepsInHomeSymlinks(t *testing.T) {
	srv, _, _ := newTestServer(t)
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(files, "real"), 0o755)
	os.Symlink(filepath.Join(files, "real"), filepath.Join(files, "enlace"))

	p, ok := srv.users.Resolve("user", "ana", "files/enlace/y.txt")
	if !ok {
		t.Fatalf("Resolve refused a path through an in-home symlink")
	}
	req := httptest.NewRequest("PUT", "/api/files?file=files/enlace/y.txt",
		strings.NewReader("hola\n"))
	rec := httptest.NewRecorder()
	if _, err := srv.streamToFile(rec, req, p, -1); err != nil {
		t.Fatalf("write through an in-home symlink = %d %s", rec.Code, rec.Body)
	}
	if b, _ := os.ReadFile(filepath.Join(files, "real", "y.txt")); string(b) != "hola\n" {
		t.Errorf("the file did not land behind the link: %q", b)
	}

	req = httptest.NewRequest("GET", "/api/files?file=files/enlace/y.txt", nil)
	rec = httptest.NewRecorder()
	srv.filesRead(rec, req, p, cleanQuery(req))
	if rec.Code != http.StatusOK || rec.Body.String() != "hola\n" {
		t.Errorf("read through an in-home symlink = %d %q", rec.Code, rec.Body)
	}
}
