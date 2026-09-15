package main

// =============================================================================
// Nothing is lost by accident.
// =============================================================================
//
// One test per rule added on 2026-09-11, after a review of every path in the
// server that deletes or overwrites. Each rule is a deliberate difference from
// the Python, which does not have it - see docs/go-port.md, "Deliberate
// differences".

import (
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestSweepOrphansByTimeInTheBin - an item in the papelera whose index.json row
// was lost is still swept, and by how long it has been IN THE BIN: the entryId's
// epoch, never the file's own timestamp (a move into .trash keeps that intact,
// so a file written today can have been deleted years ago, and the other way
// round).
func TestSweepOrphansByTimeInTheBin(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	trash := NewTrash(cfg.BaseDir, cfg.HomesDir, users, log)

	can := filepath.Join(cfg.HomesDir, "ana", ".trash")
	os.MkdirAll(can, 0o755)
	entryID := func(daysAgo int) string {
		when := time.Now().AddDate(0, 0, -daysAgo).Unix()
		return strconv.FormatInt(when, 10) + "-deadbeef"
	}

	// Every one of these is written NOW, so the file timestamps are all today:
	// only the id can tell them apart.
	old := filepath.Join(can, entryID(40))  // 40 days in the bin
	fresh := filepath.Join(can, entryID(3)) // 3 days in the bin
	junk := filepath.Join(can, "notas.txt") // not a trash entry at all
	index := filepath.Join(can, "index.json")
	for _, p := range []string{old, fresh, junk} {
		os.WriteFile(p, []byte("x"), 0o644)
	}
	os.WriteFile(index, []byte("{}"), 0o644) // an index that lost its rows

	trash.SweepExpired(30)

	if pathExists(old) {
		t.Error("an orphan 40 days in the bin was kept")
	}
	if !pathExists(fresh) {
		t.Error("an orphan only 3 days in the bin was deleted")
	}
	if !pathExists(junk) {
		t.Error("the sweep deleted a file that is not a trash entry")
	}
	if !pathExists(index) {
		t.Error("the sweep deleted index.json")
	}
}

// TestSweepSparesUserFiles - the startup sweep deletes for good, so it must
// take the server's own leftovers and nothing that merely LOOKS like one.
func TestSweepSparesUserFiles(t *testing.T) {
	_, cfg, _ := newTestUsers(t)
	home := filepath.Join(cfg.HomesDir, "ana")
	write := func(path string, mode os.FileMode) {
		os.MkdirAll(filepath.Dir(path), 0o755)
		os.WriteFile(path, []byte("x"), mode)
		os.Chmod(path, mode) // the umask must not decide the test
	}

	gone := map[string]os.FileMode{
		filepath.Join(home, "data", "config.json.123.4.tmp"):      0o644,
		filepath.Join(cfg.ConfigDir, "shares.json.99.1.tmp"):      0o644,
		filepath.Join(home, ".trash", "index.json.7.2.tmp"):       0o644,
		filepath.Join(home, "files", "fotos", ".upload-abc12345"): 0o600, // never finished
	}
	kept := map[string]os.FileMode{
		filepath.Join(home, "files", "notas.2024.05.tmp"):      0o644, // a user's own name
		filepath.Join(home, "data", "photos", "copia.1.2.tmp"): 0o644, // deeper in data/
		filepath.Join(home, "files", ".upload-settings"):       0o644, // a finished file
	}
	for p, mode := range gone {
		write(p, mode)
	}
	for p, mode := range kept {
		write(p, mode)
	}

	NewFileTree(cfg.BaseDir, cfg.HomesDir, cfg.ConfigDir, nil).SweepStaleTemp()

	for p := range gone {
		if pathExists(p) {
			t.Errorf("the sweep left the server's own leftover %s", p)
		}
	}
	for p := range kept {
		if !pathExists(p) {
			t.Errorf("the sweep DELETED a user's file: %s", p)
		}
	}
}

// TestPurgeOnlyThumbnails - skipping the papelera is for derived data only.
func TestPurgeOnlyThumbnails(t *testing.T) {
	srv, ts, client := newTestServer(t)
	data := filepath.Join(srv.cfg.HomesDir, "ana", "data")
	tasks := filepath.Join(data, "tasks.json")
	os.WriteFile(tasks, []byte("[]"), 0o644)
	thumb := filepath.Join(data, "photos", "thumbs", "10_20.jpg")
	os.MkdirAll(filepath.Dir(thumb), 0o755)
	os.WriteFile(thumb, []byte("jpg"), 0o644)
	signIn(t, client, ts.URL, "ana", "abc")

	resp := do(t, client, "DELETE", ts.URL+"/api/files?paths=data/tasks.json&purge=1", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("purge of data/tasks.json = %d, want 403", resp.StatusCode)
	}
	if !pathExists(tasks) {
		t.Errorf("purge ERASED data/tasks.json")
	}

	resp = do(t, client, "DELETE",
		ts.URL+"/api/files?paths=data/photos/thumbs/10_20.jpg&purge=1", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("purge of a thumbnail = %d, want 200", resp.StatusCode)
	}
	if pathExists(thumb) {
		t.Errorf("the thumbnail was not purged")
	}
}

// TestAccountFileProtected - a user cannot overwrite, trash, purge or move
// the file that IS their account, and still signs in afterwards.
func TestAccountFileProtected(t *testing.T) {
	srv, ts, client := newTestServer(t)
	cfgFile := filepath.Join(srv.cfg.HomesDir, "ana", "data", "config.json")
	before, _ := os.ReadFile(cfgFile)
	signIn(t, client, ts.URL, "ana", "abc")

	for _, c := range []struct{ method, url, body string }{
		{"PUT", "/api/files?file=data/config.json", `{"password":"abc"}`},
		{"DELETE", "/api/files?paths=data/config.json", ""},
		{"DELETE", "/api/files?paths=data/config.json&purge=1", ""},
		{"POST", "/api/files?old=data/config.json&new=data/otro.json", ""},
		{"POST", "/api/files?old=files/mio.txt&new=data/config.json", ""},
	} {
		var body io.Reader
		if c.body != "" {
			body = strings.NewReader(c.body)
		}
		resp := do(t, client, c.method, ts.URL+c.url, body, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403", c.method, c.url, resp.StatusCode)
		}
	}
	if after, _ := os.ReadFile(cfgFile); string(after) != string(before) {
		t.Errorf("config.json changed: %q", after)
	}
	signIn(t, client, ts.URL, "ana", "abc") // the account still works
}

// TestAdminCannotTrashAccountFile - the admin's Drive is rooted at the base
// directory, so every account file is one click away. It is refused; an
// ordinary file of the admin's is not.
func TestAdminCannotTrashAccountFile(t *testing.T) {
	srv, _, _ := newTestServer(t)
	base := srv.cfg.BaseDir
	os.MkdirAll(filepath.Join(base, "files"), 0o755)
	os.WriteFile(filepath.Join(base, "files", "nota.txt"), []byte("hola"), 0o644)

	if !srv.isStructuralDir("admin", "", filepath.Join(base, "homes", "ana", "data", "config.json")) {
		t.Errorf("the admin may move or trash homes/ana/data/config.json")
	}
	if srv.isStructuralDir("admin", "", filepath.Join(base, "files", "nota.txt")) {
		t.Errorf("an ordinary file of the admin's is refused")
	}
}

// TestSharesNeverOverwriteUnreadableFile - a shares.json that cannot be read
// is set aside, never written over, and the new share is still saved.
func TestSharesNeverOverwriteUnreadableFile(t *testing.T) {
	_, cfg, _ := newTestUsers(t)
	path := filepath.Join(cfg.ConfigDir, "shares.json")
	broken := `{"shares": [ {"slug": "viaje", oops`
	os.WriteFile(path, []byte(broken), 0o644)

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	shares := NewShares(cfg.ConfigDir, cfg.HomesDir, log)
	if g := shares.Create("ana", "beto", "files/mio.txt", "folder", "", "ro"); g == nil {
		t.Fatalf("Create refused")
	}

	aside, _ := filepath.Glob(path + ".broken-*")
	if len(aside) != 1 {
		t.Fatalf("the unreadable shares.json was not kept aside: %v", aside)
	}
	if b, _ := os.ReadFile(aside[0]); string(b) != broken {
		t.Errorf("the kept copy is not the original: %q", b)
	}
	if b, _ := os.ReadFile(path); !strings.Contains(string(b), "files/mio.txt") {
		t.Errorf("the new share was not saved: %q", b)
	}
}
