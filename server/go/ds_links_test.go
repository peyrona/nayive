package main

// Data-safety seal: Drive's shortcuts (links.go) never write over anything.
//   L1 a shortcut is made under a free name only, even one taken at placement
//   L2 mending writes only the shortcut it read: one renamed, binned or
//      replaced meanwhile stays as it is
//   L3 the target is only ever read; a shared folder lends no shortcut

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestDS_LinksNeverReplace(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(files, "S"), 0o755)
	os.WriteFile(filepath.Join(files, "x.txt"), []byte("original"), 0o644)
	// The user's own file under the name the shortcut would take.
	os.WriteFile(filepath.Join(files, "S", "x.txt.nayive-link"), []byte("mine"), 0o644)

	// L1: taken before, and taken at the very placement.
	fired := dsTakeAtPlacement(t, "x.txt (2).nayive-link", "theirs")
	code, p := makeShortcut(t, client, ts.URL, "files/x.txt", "files/S")
	if code != http.StatusCreated || p != "files/S/x.txt (3).nayive-link" || fired.Load() != 1 {
		t.Fatalf("make = %d %q (hook fired %d)", code, p, fired.Load())
	}
	if b, _ := os.ReadFile(filepath.Join(files, "S", "x.txt.nayive-link")); string(b) != "mine" {
		t.Errorf("the file there before = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(files, "S", "x.txt (2).nayive-link")); string(b) != "theirs" {
		t.Errorf("the file taken at placement = %q", b)
	}
	if left, _ := filepath.Glob(filepath.Join(files, "S", ".upload-*")); len(left) != 0 {
		t.Errorf("temps left: %v", left)
	}

	// L2: mending a shortcut that changed after it was read writes nothing.
	sc, _ := srv.users.Resolve("user", "ana", "files/S/x.txt (3).nayive-link")
	lf, was, ok := readLinkFile(sc)
	if !ok {
		t.Fatal("the new shortcut does not read back")
	}
	os.WriteFile(sc.Abs, []byte("replaced by the user"), 0o644)
	lf.To = "files/elsewhere.txt"
	if err := srv.writeLinkFile(sc, lf, was); err != errLinkChanged {
		t.Errorf("mend over a changed shortcut = %v, want errLinkChanged", err)
	}
	if b, _ := os.ReadFile(sc.Abs); string(b) != "replaced by the user" {
		t.Errorf("the replaced shortcut = %q", b)
	}
	os.Remove(sc.Abs)
	if err := srv.writeLinkFile(sc, lf, was); err != errLinkChanged {
		t.Errorf("mend of a shortcut gone = %v, want errLinkChanged", err)
	}
	if _, err := os.Lstat(sc.Abs); !os.IsNotExist(err) {
		t.Error("mending made a shortcut that was gone")
	}

	// L3: the target as it was; nothing through a share.
	if b, _ := os.ReadFile(filepath.Join(files, "x.txt")); string(b) != "original" {
		t.Errorf("the target = %q", b)
	}
	q := url.Values{"link": {"shared/x/y.txt"}, "into": {"files/S"}}
	if code, _ := linkCall(t, client, "POST", ts.URL+"/api/files?"+q.Encode()); code != http.StatusForbidden {
		t.Errorf("a shortcut to something lent = %d, want 403", code)
	}
	q = url.Values{"link": {"files/x.txt"}, "into": {"shared/x"}}
	if code, _ := linkCall(t, client, "POST", ts.URL+"/api/files?"+q.Encode()); code != http.StatusForbidden {
		t.Errorf("a shortcut into something lent = %d, want 403", code)
	}
}
