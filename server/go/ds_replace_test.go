package main

// Data-safety seal (cleanup Phase 3, batch S2): a file is never replaced
// without asking, and a delete removes only what it should.
//   G1 create-only PUT (If-None-Match: *)      D8  restore onto a taken name
//   D9 "add, never replace" at the rename      D10 every check-then-rename
//   D11 the converter bins only what it made   G4  empty only what was seen
//   G5 a failed extract / copy takes back only its own files

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// dsTakeAtPlacement makes the next placement of a file named `name` find
// that name taken: a file holding `body` appears there in the very instant
// before renameNoReplace takes it - the window no earlier check can see. It
// answers a counter of the times it fired.
func dsTakeAtPlacement(t *testing.T, name, body string) *atomic.Int32 {
	t.Helper()
	var fired atomic.Int32
	hook := func(root *os.Root, from, to string, linked bool) {
		if !linked && filepath.Base(to) == name && fired.Add(1) == 1 {
			if err := root.WriteFile(to, []byte(body), 0o644); err != nil {
				t.Errorf("the test could not take %s: %v", to, err)
			}
		}
	}
	testPlaceHook.Store(&hook)
	t.Cleanup(func() { testPlaceHook.Store(nil) })
	return &fired
}

// dsSaveAtSourceMidMove makes the next move of a file named `name` meet a
// save at its OLD place between the link and the unlink: a new file holding
// `body` is renamed over `from`, as an upload does.
func dsSaveAtSourceMidMove(t *testing.T, name, body string) *atomic.Int32 {
	t.Helper()
	var fired atomic.Int32
	hook := func(root *os.Root, from, to string, linked bool) {
		if linked && filepath.Base(from) == name && fired.Add(1) == 1 {
			tmp := from + ".saving"
			if err := root.WriteFile(tmp, []byte(body), 0o644); err != nil {
				t.Errorf("the test could not save %s: %v", from, err)
			}
			if err := root.Rename(tmp, from); err != nil {
				t.Errorf("the test could not save %s: %v", from, err)
			}
		}
	}
	testPlaceHook.Store(&hook)
	t.Cleanup(func() { testPlaceHook.Store(nil) })
	return &fired
}

// dsWaitTemp waits until a ".upload-" temp shows in dir: the PUT streaming
// there is past every check made before its body.
func dsWaitTemp(t *testing.T, dir string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".upload-") {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the streaming PUT never made its temp")
}

// dsSlowPut starts a PUT whose body arrives in two halves: the first now,
// the rest when the returned func is called. That func answers the status.
func dsSlowPut(t *testing.T, client *http.Client, url, body string, header map[string]string) func() int {
	t.Helper()
	pr, pw := io.Pipe()
	req, _ := http.NewRequest("PUT", url, pr)
	req.ContentLength = int64(len(body))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	answered := make(chan int, 1)
	go func() {
		resp, err := client.Do(req)
		if err != nil {
			answered <- 0
			return
		}
		resp.Body.Close()
		answered <- resp.StatusCode
	}()
	pw.Write([]byte(body[:4]))
	return func() int {
		pw.Write([]byte(body[4:]))
		pw.Close()
		return <-answered
	}
}

func dsRead(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return "<missing>"
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// G1: PUT with If-None-Match: * never replaces a file
// ---------------------------------------------------------------------------

// TestDS_G1_CreateOnlyPutRefusesTakenName: a create-only PUT onto a name
// that is taken answers 412 and writes nothing; onto a free name it saves.
// A PUT without the header still replaces, as every caller expects.
func TestDS_G1_CreateOnlyPutRefusesTakenName(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.WriteFile(filepath.Join(files, "foto.jpg"), []byte("the phone's photo"), 0o644)
	only := map[string]string{"If-None-Match": "*"}

	resp := do(t, client, "PUT", ts.URL+"/api/files?file=files/foto.jpg", strings.NewReader("the PC's photo"), only)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPreconditionFailed {
		t.Errorf("create-only PUT onto a taken name = %d, want 412", resp.StatusCode)
	}
	if got := dsRead(filepath.Join(files, "foto.jpg")); got != "the phone's photo" {
		t.Errorf("foto.jpg = %q: replaced", got)
	}

	resp = do(t, client, "PUT", ts.URL+"/api/files?file=files/nueva.jpg", strings.NewReader("new"), only)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || dsRead(filepath.Join(files, "nueva.jpg")) != "new" {
		t.Errorf("create-only PUT onto a free name = %d", resp.StatusCode)
	}

	resp = do(t, client, "PUT", ts.URL+"/api/files?file=files/foto.jpg", strings.NewReader("replaced on purpose"), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || dsRead(filepath.Join(files, "foto.jpg")) != "replaced on purpose" {
		t.Errorf("a plain PUT no longer replaces: %d", resp.StatusCode)
	}
}

// TestDS_G1_CreateOnlyPutNameTakenWhileStreaming: the name was free when the
// body started; another device saved a file of that name before it ended.
// The create-only PUT answers 412 and the other file stays.
func TestDS_G1_CreateOnlyPutNameTakenWhileStreaming(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	dir := filepath.Join(srv.cfg.HomesDir, "ana", "files", "Fotos")
	os.MkdirAll(dir, 0o755)

	finish := dsSlowPut(t, client, ts.URL+"/api/files?file=files/Fotos/IMG_1.jpg",
		"PC-photo-bytes", map[string]string{"If-None-Match": "*"})
	dsWaitTemp(t, dir)

	phone := signedInClient(t, ts.URL, "ana", "abc")
	resp := do(t, phone, "PUT", ts.URL+"/api/files?file=files/Fotos/IMG_1.jpg", strings.NewReader("phone-photo"), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the phone's PUT = %d", resp.StatusCode)
	}

	if code := finish(); code != http.StatusPreconditionFailed {
		t.Errorf("create-only PUT whose name was taken while it streamed = %d, want 412", code)
	}
	if got := dsRead(filepath.Join(dir, "IMG_1.jpg")); got != "phone-photo" {
		t.Errorf("IMG_1.jpg = %q: the phone's photo was replaced", got)
	}
}

// TestDS_G1_CreateOnlyPutNameTakenAtPlacement: the name is taken in the very
// instant the upload takes it (after every check): 412, the file stays.
func TestDS_G1_CreateOnlyPutNameTakenAtPlacement(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	fired := dsTakeAtPlacement(t, "doc.txt", "saved meanwhile")

	resp := do(t, client, "PUT", ts.URL+"/api/files?file=files/doc.txt", strings.NewReader("mine"),
		map[string]string{"If-None-Match": "*"})
	resp.Body.Close()
	if fired.Load() == 0 {
		t.Fatal("the upload did not place its file through renameNoReplace")
	}
	if resp.StatusCode != http.StatusPreconditionFailed {
		t.Errorf("answer = %d, want 412", resp.StatusCode)
	}
	if got := dsRead(filepath.Join(files, "doc.txt")); got != "saved meanwhile" {
		t.Errorf("doc.txt = %q: replaced", got)
	}
	// The temp goes as the handler returns, a moment after its answer.
	temps := func() (n int) {
		entries, _ := os.ReadDir(files)
		for _, e := range entries {
			if isTempName(e.Name()) {
				n++
			}
		}
		return n
	}
	for deadline := time.Now().Add(5 * time.Second); temps() > 0; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the refused upload left its temp")
		}
	}
}

// ---------------------------------------------------------------------------
// D9: a guest's "add" never replaces the owner's file
// ---------------------------------------------------------------------------

func dsAddGrant(t *testing.T, srv *Server) (dir, slug string) {
	t.Helper()
	dir = filepath.Join(srv.cfg.HomesDir, "ana", "files", "boda")
	os.MkdirAll(dir, 0o755)
	g := srv.shares.Create("ana", "beto", "files/boda", "photos", "Boda", "add")
	if g == nil || g.Mode != "add" {
		t.Fatalf("grant %+v", g)
	}
	return dir, g.Slug
}

// TestDS_D9_GuestAddNameTakenWhileStreaming: beto's upload into ana's "add"
// album passed the "exists?" check before its body; ana saved her own
// VID_0001.mp4 there meanwhile. Beto's answer is 409 and ana's video stays.
func TestDS_D9_GuestAddNameTakenWhileStreaming(t *testing.T) {
	srv, ts, owner := newTestServer(t)
	signIn(t, owner, ts.URL, "ana", "abc")
	dir, slug := dsAddGrant(t, srv)
	guest := signedInClient(t, ts.URL, "beto", "xyz")

	finish := dsSlowPut(t, guest, ts.URL+"/api/files?file=shared/"+slug+"/VID_0001.mp4", "BETO-video-bytes", nil)
	dsWaitTemp(t, dir)

	resp := do(t, owner, "PUT", ts.URL+"/api/files?file=files/boda/VID_0001.mp4", strings.NewReader("ANA-own-video"), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("owner PUT = %d", resp.StatusCode)
	}

	if code := finish(); code != http.StatusConflict {
		t.Errorf("the guest's add over a name taken meanwhile = %d, want 409", code)
	}
	if got := dsRead(filepath.Join(dir, "VID_0001.mp4")); got != "ANA-own-video" {
		t.Errorf("VID_0001.mp4 = %q: the owner's video was replaced", got)
	}
}

// TestDS_D9_GuestAddNameTakenAtPlacement: the same, the name taken in the
// instant the guest's file takes it.
func TestDS_D9_GuestAddNameTakenAtPlacement(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	dir, slug := dsAddGrant(t, srv)
	guest := signedInClient(t, ts.URL, "beto", "xyz")
	dsTakeAtPlacement(t, "IMG_9.jpg", "ana's photo")

	resp := do(t, guest, "PUT", ts.URL+"/api/files?file=shared/"+slug+"/IMG_9.jpg", strings.NewReader("beto's photo"), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("answer = %d, want 409", resp.StatusCode)
	}
	if got := dsRead(filepath.Join(dir, "IMG_9.jpg")); got != "ana's photo" {
		t.Errorf("IMG_9.jpg = %q: replaced", got)
	}
}

// TestDS_D9_GuestAddMakesNoFolders: an "add" share lends ana's folders to
// drop files in; beto's PUT into a folder that is not there is refused, as
// his mkdir is, and makes nothing (B5-17). Into a folder that is: saved.
func TestDS_D9_GuestAddMakesNoFolders(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	dir, slug := dsAddGrant(t, srv)
	guest := signedInClient(t, ts.URL, "beto", "xyz")

	resp := do(t, guest, "PUT", ts.URL+"/api/files?file=shared/"+slug+"/new/deep/IMG_1.jpg", strings.NewReader("beto's photo"), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("PUT into a new folder = %d, want 403", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(dir, "new")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the refused PUT made a folder: %v", err)
	}

	os.MkdirAll(filepath.Join(dir, "day1"), 0o755)
	resp = do(t, guest, "PUT", ts.URL+"/api/files?file=shared/"+slug+"/day1/IMG_2.jpg", strings.NewReader("beto's photo"), nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("PUT into a folder that is there = %d, want 200", resp.StatusCode)
	}
	if got := dsRead(filepath.Join(dir, "day1", "IMG_2.jpg")); got != "beto's photo" {
		t.Errorf("IMG_2.jpg = %q", got)
	}
}

// ---------------------------------------------------------------------------
// D8: a restore never replaces anything
// ---------------------------------------------------------------------------

func dsBinIDs(t *testing.T, client *http.Client, base, rel string) []string {
	t.Helper()
	var out struct{ IDs []string }
	jsonCall(t, client, "DELETE", base+"/api/files?paths="+rel, "", 200, &out)
	return out.IDs
}

// TestDS_D8_RestoreSameNameSameSecond: two bin items of one name, restored
// in one call while that name is taken: each gets its own name, and all
// three versions are in the folder (the second used to replace the first).
func TestDS_D8_RestoreSameNameSameSecond(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	x := filepath.Join(files, "x.txt")

	os.WriteFile(x, []byte("version ONE"), 0o644)
	id1 := dsBinIDs(t, client, ts.URL, "files/x.txt")
	os.WriteFile(x, []byte("version TWO"), 0o644)
	id2 := dsBinIDs(t, client, ts.URL, "files/x.txt")
	os.WriteFile(x, []byte("current"), 0o644)

	var res struct{ Renamed []string }
	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=restore&ids="+id1[0]+"%3B"+id2[0], "", 200, &res)
	if len(res.Renamed) != 2 || res.Renamed[0] == res.Renamed[1] {
		t.Errorf("renamed = %v, want two different names", res.Renamed)
	}
	found := map[string]bool{}
	entries, _ := os.ReadDir(files)
	for _, e := range entries {
		found[dsRead(filepath.Join(files, e.Name()))] = true
	}
	for _, want := range []string{"version ONE", "version TWO", "current"} {
		if !found[want] {
			t.Errorf("%q is not in files/ (renamed %v)", want, res.Renamed)
		}
	}
	var l struct{ Items []TrashItem }
	jsonCall(t, client, "GET", ts.URL+"/api/files?trash=list", "", 200, &l)
	if len(l.Items) != 0 {
		t.Errorf("bin still lists %d items", len(l.Items))
	}
}

// TestDS_D8_RestoreNameTakenAtPlacement: the original name was free when the
// restore looked, and taken in the instant it moved: the item comes back
// under a "(restaurado ...)" name, the new file stays.
func TestDS_D8_RestoreNameTakenAtPlacement(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.WriteFile(filepath.Join(files, "acta.txt"), []byte("binned"), 0o644)
	ids := dsBinIDs(t, client, ts.URL, "files/acta.txt")
	dsTakeAtPlacement(t, "acta.txt", "saved meanwhile")

	var res struct{ Renamed []string }
	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=restore&ids="+ids[0], "", 200, &res)
	if got := dsRead(filepath.Join(files, "acta.txt")); got != "saved meanwhile" {
		t.Errorf("acta.txt = %q: replaced by the restore", got)
	}
	if len(res.Renamed) != 1 || !strings.Contains(res.Renamed[0], "restaurado") {
		t.Fatalf("renamed = %v", res.Renamed)
	}
	if got := dsRead(filepath.Join(files, res.Renamed[0])); got != "binned" {
		t.Errorf("%s = %q", res.Renamed[0], got)
	}
}

// ---------------------------------------------------------------------------
// D10: no check-then-rename replaces a file saved in between
// ---------------------------------------------------------------------------

// TestDS_D10_RenameNoReplaceKinds: the primitive itself, for every pair it
// meets, and moveResolved (the bin's move in and out) on top of it.
func TestDS_D10_RenameNoReplaceKinds(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	w := func(name, body string) { os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644) }
	w("a.txt", "A")
	w("b.txt", "B")
	os.MkdirAll(filepath.Join(dir, "full", "x"), 0o755)
	os.MkdirAll(filepath.Join(dir, "other"), 0o755)
	w("full/x/f.txt", "F")

	for _, c := range []struct{ from, to string }{
		{"a.txt", "b.txt"},  // a file onto a file
		{"other", "full"},   // a folder onto a folder with something in it
		{"other", "b.txt"},  // a folder onto a file
		{"a.txt", "full/x"}, // a file onto a folder
	} {
		if err := renameNoReplace(root, c.from, c.to); !errors.Is(err, fs.ErrExist) {
			t.Errorf("%s -> %s: %v, want fs.ErrExist", c.from, c.to, err)
		}
	}
	if dsRead(filepath.Join(dir, "a.txt")) != "A" || dsRead(filepath.Join(dir, "b.txt")) != "B" ||
		dsRead(filepath.Join(dir, "full", "x", "f.txt")) != "F" || !pathExists(filepath.Join(dir, "other")) {
		t.Error("a refused move changed something")
	}

	before, _ := os.Stat(filepath.Join(dir, "a.txt"))
	if err := renameNoReplace(root, "a.txt", "c.txt"); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(filepath.Join(dir, "c.txt"))
	if pathExists(filepath.Join(dir, "a.txt")) || !os.SameFile(before, after) {
		t.Error("a free move did not move the same file")
	}

	p, _ := newResolved(dir, filepath.Join(dir, "c.txt"), true)
	if err := moveResolved(p, p.at("b.txt")); !errors.Is(err, fs.ErrExist) || dsRead(filepath.Join(dir, "b.txt")) != "B" {
		t.Errorf("moveResolved onto a file: %v, b.txt = %q", err, dsRead(filepath.Join(dir, "b.txt")))
	}
}

// TestDS_D10_MoveNameTakenAtPlacement: Drive's move/rename onto a name that
// was free at the check and taken in the instant of the move: 409, both stay.
func TestDS_D10_MoveNameTakenAtPlacement(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.WriteFile(filepath.Join(files, "a.txt"), []byte("moving"), 0o644)
	fired := dsTakeAtPlacement(t, "b.txt", "saved meanwhile")

	code, body := callJSON(t, client, "POST", ts.URL+"/api/files?old=files/a.txt&new=files/b.txt", "")
	if fired.Load() == 0 {
		t.Fatal("the move did not go through renameNoReplace")
	}
	if code != http.StatusConflict {
		t.Errorf("move = %d %s, want 409", code, body)
	}
	if dsRead(filepath.Join(files, "b.txt")) != "saved meanwhile" || dsRead(filepath.Join(files, "a.txt")) != "moving" {
		t.Error("a file was lost or replaced")
	}
}

// TestDS_D10_SaveAtSourceMidMoveKept: a file is moved (Drive) or binned while
// a save of it lands at its old place between the link and the unlink: the
// moved file is the old one, and the new save stays where it was saved.
func TestDS_D10_SaveAtSourceMidMoveKept(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	os.WriteFile(filepath.Join(files, "a.txt"), []byte("old"), 0o644)
	fired := dsSaveAtSourceMidMove(t, "a.txt", "saved meanwhile")
	if code, body := callJSON(t, client, "POST", ts.URL+"/api/files?old=files/a.txt&new=files/b.txt", ""); code != 200 {
		t.Fatalf("move = %d %s", code, body)
	}
	if fired.Load() == 0 {
		t.Fatal("the move did not go through renameNoReplace")
	}
	if dsRead(filepath.Join(files, "b.txt")) != "old" || dsRead(filepath.Join(files, "a.txt")) != "saved meanwhile" {
		t.Errorf("move: b.txt = %q, a.txt = %q; want old / saved meanwhile",
			dsRead(filepath.Join(files, "b.txt")), dsRead(filepath.Join(files, "a.txt")))
	}

	os.WriteFile(filepath.Join(files, "c.txt"), []byte("old"), 0o644)
	dsSaveAtSourceMidMove(t, "c.txt", "saved meanwhile")
	dsBinIDs(t, client, ts.URL, "files/c.txt")
	if got := dsRead(filepath.Join(files, "c.txt")); got != "saved meanwhile" {
		t.Errorf("bin: c.txt = %q, want the save made while it was binned", got)
	}
}

// dsWaitsForStripe: `act` (a request) touches the file at `abs`; while that
// file's upload stripe is held it must wait, and finish once it is let go.
func dsWaitsForStripe(t *testing.T, abs, what string, act func() int) {
	t.Helper()
	unlock := lockPath(abs)
	done := make(chan int, 1)
	go func() { done <- act() }()
	// Proving something does NOT happen needs a bounded wait: 300 ms is far
	// longer than the whole request takes when nothing holds the stripe.
	select {
	case code := <-done:
		unlock()
		t.Fatalf("%s ran (%d) while a save held the file's stripe", what, code)
	case <-time.After(300 * time.Millisecond):
	}
	unlock()
	if code := <-done; code != 200 {
		t.Errorf("%s = %d after the stripe was let go", what, code)
	}
}

// TestDS_D10_MoveAndBinWaitForUploadStripe: a move or a bin of a file waits
// for an upload of that file to finish its rename (lockPath).
func TestDS_D10_MoveAndBinWaitForUploadStripe(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.WriteFile(filepath.Join(files, "a.txt"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(files, "c.txt"), []byte("c"), 0o644)
	abs := func(rel string) string { p, _ := srv.users.ResolvePath("user", "ana", rel); return p }

	dsWaitsForStripe(t, abs("files/a.txt"), "the move", func() int {
		code, _ := callJSON(t, client, "POST", ts.URL+"/api/files?old=files/a.txt&new=files/b.txt", "")
		return code
	})
	dsWaitsForStripe(t, abs("files/c.txt"), "the bin", func() int {
		code, _ := callJSON(t, client, "DELETE", ts.URL+"/api/files?paths=files/c.txt", "")
		return code
	})
}

// TestDS_D10_MediaPartNameTakenAtPlacement: a phone's photo filed into the
// folder while Drive saved one of its name: the phone's gets the next name.
func TestDS_D10_MediaPartNameTakenAtPlacement(t *testing.T) {
	home := t.TempDir()
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	os.MkdirAll(filepath.Join(home, "data", ".upload"), 0o755)
	os.WriteFile(filepath.Join(home, "data", ".upload", "p.part"), []byte("phone"), 0o600)
	dsTakeAtPlacement(t, "IMG_1.jpg", "from Drive")

	rel, err := fileMediaPart(root, filepath.Join("data", ".upload", "p.part"), "files/Camara", "IMG_1.jpg")
	if err != nil {
		t.Fatal(err)
	}
	if rel != "files/Camara/IMG_1 (2).jpg" || dsRead(filepath.Join(home, filepath.FromSlash(rel))) != "phone" {
		t.Errorf("filed as %q", rel)
	}
	if got := dsRead(filepath.Join(home, "files", "Camara", "IMG_1.jpg")); got != "from Drive" {
		t.Errorf("IMG_1.jpg = %q: replaced", got)
	}
}

// TestDS_D10_ChatKeepNameTakenAtPlacement: Chat's "keep in my files" while a
// file of that name was saved there: kept as "(2)", the other stays.
func TestDS_D10_ChatKeepNameTakenAtPlacement(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos"), 0o755)
	photo := f.upload(t, "photo", "IMG_1.jpg", keepJPEG)
	dsTakeAtPlacement(t, "IMG_1.jpg", "saved meanwhile")

	var kept struct {
		Path string `json:"path"`
	}
	f.call(t, f.owner, "POST", fmt.Sprintf("/api/chat/conv/%s/messages/%d/keep", conv, photo.ID),
		`{"dir":"files/Fotos"}`, 200, &kept)
	if kept.Path != "files/Fotos/IMG_1 (2).jpg" {
		t.Errorf("kept as %q", kept.Path)
	}
	if got := dsRead(filepath.Join(home, "files", "Fotos", "IMG_1.jpg")); got != "saved meanwhile" {
		t.Errorf("IMG_1.jpg = %q: replaced", got)
	}
	if got := dsRead(filepath.Join(home, "files", "Fotos", "IMG_1 (2).jpg")); got != string(keepJPEG) {
		t.Error("the kept photo is not under its new name")
	}
}

// TestDS_D10_OfficeTwinNameTakenAtPlacement: a twin made without "replace"
// meets a "Save as x.docx" made while LibreOffice ran: refused, kept. With
// "replace" (an upload's new twin) it still replaces.
func TestDS_D10_OfficeTwinNameTakenAtPlacement(t *testing.T) {
	dir := t.TempDir()
	made := filepath.Join(t.TempDir(), "doc.docx")
	os.WriteFile(made, []byte("PK the twin"), 0o644)
	dst, _ := newResolved(dir, filepath.Join(dir, "x.docx"), true)
	dsTakeAtPlacement(t, "x.docx", "saved from Write")

	if err := placeFile(made, dst, false); !errors.Is(err, fs.ErrExist) {
		t.Errorf("placeFile = %v, want fs.ErrExist", err)
	}
	if got := dsRead(filepath.Join(dir, "x.docx")); got != "saved from Write" {
		t.Errorf("x.docx = %q: replaced", got)
	}
	if err := placeFile(made, dst, true); err != nil || dsRead(filepath.Join(dir, "x.docx")) != "PK the twin" {
		t.Errorf("placeFile with replace: %v", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("%d entries left, want x.docx alone (no temp)", len(entries))
	}
}

// TestDS_D10_ConvertMP4NameTakenAtPlacement: the finished mp4 meets an
// "x.mp4" saved while it took its name: it becomes "x (1).mp4".
func TestDS_D10_ConvertMP4NameTakenAtPlacement(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	os.WriteFile(filepath.Join(dir, ".convert-abcdefgh"), []byte("mp4"), 0o644)
	dsTakeAtPlacement(t, "x.mp4", "uploaded meanwhile")

	rel, err := placeMP4(root, ".convert-abcdefgh", "x.avi")
	if err != nil || rel != "x (1).mp4" {
		t.Fatalf("placeMP4 = %q %v", rel, err)
	}
	if dsRead(filepath.Join(dir, "x.mp4")) != "uploaded meanwhile" || dsRead(filepath.Join(dir, "x (1).mp4")) != "mp4" {
		t.Error("a file was lost or replaced")
	}
}

// ---------------------------------------------------------------------------
// D11: the converter bins the original only if it is still the same file
// ---------------------------------------------------------------------------

// TestDS_D11_ConvertBinsOnlyItsOwnOriginal: while ffmpeg runs, x.avi is
// renamed to y.avi and a NEW x.avi saved. At the end the mp4 is made, and
// both films stay where they are: the new x.avi is not the converted one.
func TestDS_D11_ConvertBinsOnlyItsOwnOriginal(t *testing.T) {
	needFFmpeg(t)
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	pelis := filepath.Join(srv.cfg.HomesDir, "ana", "files", "Pelis")
	avi := makeAVI(t)
	upload(t, client, ts.URL+"/api/files?file=files/Pelis/x.avi", avi)
	gen := filepath.Join(t.TempDir(), "gen.avi")
	os.WriteFile(gen, avi, 0o644)

	// ffmpeg, with the swap done as it starts (the real ffmpeg does the work).
	real, _ := exec.LookPath("ffmpeg")
	script := filepath.Join(t.TempDir(), "ffmpeg")
	os.WriteFile(script, []byte(fmt.Sprintf("#!/bin/sh\nmv '%[1]s/x.avi' '%[1]s/y.avi' && cp '%[2]s' '%[1]s/x.avi'\nexec '%[3]s' \"$@\"\n",
		pelis, gen, real)), 0o755)
	srv.convert.ffmpeg = script

	out, err := srv.convert.convert(context.Background(), ConvertJob{User: "ana", Path: "files/Pelis/x.avi"})
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if out != "files/Pelis/x.mp4" || !pathExists(filepath.Join(pelis, "x.mp4")) {
		t.Errorf("mp4 = %q", out)
	}
	if !pathExists(filepath.Join(pelis, "x.avi")) {
		t.Error("the NEW x.avi went to the bin: it was not the file converted")
	}
	if !pathExists(filepath.Join(pelis, "y.avi")) {
		t.Error("y.avi (the original, renamed) is gone")
	}
}

// ---------------------------------------------------------------------------
// G4: "Empty the bin" purges only what the user saw
// ---------------------------------------------------------------------------

// TestDS_G4_EmptyOnlyTheIdsSeen: the bin view showed one item; another
// device binned a second before the user confirmed. ?trash=empty&ids= purges
// the one seen; an empty list purges nothing; no ids (an older page) all.
func TestDS_G4_EmptyOnlyTheIdsSeen(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.WriteFile(filepath.Join(files, "visto.txt"), []byte("seen"), 0o644)
	seen := dsBinIDs(t, client, ts.URL, "files/visto.txt")
	os.WriteFile(filepath.Join(files, "Tesis.docx"), []byte("PK binned by mistake on the phone"), 0o644)
	later := dsBinIDs(t, client, ts.URL, "files/Tesis.docx")

	listed := func() map[string]bool {
		var l struct{ Items []TrashItem }
		jsonCall(t, client, "GET", ts.URL+"/api/files?trash=list", "", 200, &l)
		out := map[string]bool{}
		for _, it := range l.Items {
			out[it.ID] = true
		}
		return out
	}

	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=empty&ids="+seen[0], "", 200, nil)
	if l := listed(); l[seen[0]] || !l[later[0]] {
		t.Errorf("after emptying what was seen the bin holds %v; want the phone's item alone", l)
	}
	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=empty&ids=", "", 200, nil)
	if l := listed(); !l[later[0]] {
		t.Error("an empty ids list purged the bin")
	}
	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=empty", "", 200, nil)
	if l := listed(); len(l) != 0 {
		t.Errorf("an empty with no ids (older page) left %v", l)
	}
}

// ---------------------------------------------------------------------------
// G5: a failed extract / folder copy takes back only what it made
// ---------------------------------------------------------------------------

// dsFailAfter is a cappedWriter target: the first write drops the user's
// file into the copy's new folder (as a move from another tab), the second
// fails the job.
type dsFailAfter struct {
	n    int
	drop func()
}

func (d *dsFailAfter) Write(p []byte) (int, error) {
	d.n++
	if d.n == 1 {
		d.drop()
		return len(p), nil
	}
	return 0, errors.New("disk error")
}

// TestDS_G5_FailedFolderCopyKeepsFilesPutIn: a folder copy fails half way;
// the document the user saved into the new folder meanwhile stays, what the
// copy made goes.
func TestDS_G5_FailedFolderCopyKeepsFilesPutIn(t *testing.T) {
	base := t.TempDir()
	os.MkdirAll(filepath.Join(base, "Album"), 0o755)
	os.WriteFile(filepath.Join(base, "Album", "a.txt"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(base, "Album", "b.txt"), []byte("b"), 0o644)
	root, err := os.OpenRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	mine := filepath.Join(base, "Copia", "mio.docx")
	cw := &cappedWriter{w: &dsFailAfter{drop: func() { os.WriteFile(mine, []byte("the user's"), 0o644) }}, ceiling: -1}
	entries := []copyEntry{{rel: "Album", dir: true}, {rel: "Album/a.txt", sub: "a.txt"}, {rel: "Album/b.txt", sub: "b.txt"}}

	if _, err := copyFolder(root, root, "Copia", entries, cw); err == nil {
		t.Fatal("the copy did not fail")
	}
	if got := dsRead(mine); got != "the user's" {
		t.Errorf("mio.docx = %q: deleted with the failed copy", got)
	}
	if pathExists(filepath.Join(base, "Copia", "a.txt")) || pathExists(filepath.Join(base, "Copia", "b.txt")) {
		t.Error("the failed copy left its own files")
	}
}

// dsOnMade runs `drop` once, right after a job notes a file named `name` as
// made (testMadeHook): the instant to put the user's own file into the job's
// new folder, while the job runs.
func dsOnMade(t *testing.T, name string, drop func()) *atomic.Int32 {
	t.Helper()
	var fired atomic.Int32
	hook := func(path string) {
		if filepath.Base(path) == name && fired.Add(1) == 1 {
			drop()
		}
	}
	testMadeHook.Store(&hook)
	t.Cleanup(func() { testMadeHook.Store(nil) })
	return &fired
}

// TestDS_G5_FailedExtractKeepsFilesMovedIn: "Extract here" of a zip whose
// last entry is damaged; after its first file the user moves a document into
// the new folder. The extract fails: what it made goes (its file, its
// subfolder, the half entry), the document stays.
func TestDS_G5_FailedExtractKeepsFilesMovedIn(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	// Declares 5 bytes, inflates to 100 000: the reader stops it (a damaged entry).
	var packed bytes.Buffer
	packed.Write(deflated(t, strings.Repeat("A", 100000)))
	liar := zip.FileHeader{Name: "Fotos/miente.txt", Method: zip.Deflate,
		CompressedSize64: uint64(packed.Len()), UncompressedSize64: 5}
	upload(t, client, ts.URL+"/api/files?file=files/Fotos.zip",
		makeZip(t, file("Fotos/sub/a.txt", "a"), zipPart{h: liar, raw: packed.Bytes()}))

	mine := filepath.Join(files, "Fotos", "mio.docx")
	fired := dsOnMade(t, "a.txt", func() { os.WriteFile(mine, []byte("the user's"), 0o644) })

	if code, a := callZip(t, client, "POST", ts.URL+"/api/zip?file=files/Fotos.zip"); code != http.StatusUnprocessableEntity {
		t.Fatalf("extract = %d %v, want 422", code, a)
	}
	if fired.Load() == 0 {
		t.Fatal("the extract did not note its files (madeHere)")
	}
	if got := dsRead(mine); got != "the user's" {
		t.Fatalf("mio.docx = %q: deleted with the failed extract", got)
	}
	if entries, _ := os.ReadDir(filepath.Join(files, "Fotos")); len(entries) != 1 {
		t.Errorf("the failed extract left %d entries beside mio.docx", len(entries)-1)
	}
}

// TestDS_G5_FailedCrossDiskCopyKeepsFilesPutIn: the bin's copy across two
// disks (a restore of a folder) fails half way; a file the user put into the
// folder meanwhile stays, what the copy made goes, the original stays whole.
func TestDS_G5_FailedCrossDiskCopyKeepsFilesPutIn(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a 000 file")
	}
	base := t.TempDir()
	src, dst := filepath.Join(base, "bin-item"), filepath.Join(base, "Album")
	os.MkdirAll(src, 0o755)
	os.WriteFile(filepath.Join(src, "a.txt"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(src, "b.txt"), []byte("b"), 0o644)
	os.Chmod(filepath.Join(src, "b.txt"), 0o000) // the copy fails on it
	t.Cleanup(func() { os.Chmod(filepath.Join(src, "b.txt"), 0o644) })
	mine := filepath.Join(dst, "mio.txt")
	dsOnMade(t, "a.txt", func() { os.WriteFile(mine, []byte("the user's"), 0o644) })

	if err := moveOrCopy(src, dst); err == nil {
		t.Fatal("the copy did not fail")
	}
	if got := dsRead(mine); got != "the user's" {
		t.Errorf("mio.txt = %q: deleted with the failed copy", got)
	}
	if pathExists(filepath.Join(dst, "a.txt")) {
		t.Error("the failed copy left its own a.txt")
	}
	if dsRead(filepath.Join(src, "a.txt")) != "a" {
		t.Error("the original lost a file")
	}
}

// TestDS_D11_BinIfSameLooksUnderTheStripe: the converter's "is it still the
// file I converted?" is answered under the path's stripe: a file saved over
// the original while an upload holds the stripe is seen, and stays.
func TestDS_D11_BinIfSameLooksUnderTheStripe(t *testing.T) {
	srv, _, _ := newTestServer(t)
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	x := filepath.Join(files, "x.avi")
	os.WriteFile(x, []byte("the film converted"), 0o644)
	src, _ := srv.users.Resolve("user", "ana", "files/x.avi")
	was, _ := src.Stat()

	unlock := lockPath(src.Abs) // an upload of x.avi, in its final rename
	done := make(chan error, 1)
	go func() { _, err := srv.trash.MoveInIfSame("user", "ana", src, "files/x.avi", was); done <- err }()
	// Proving something does NOT happen needs a bounded wait (see dsWaitsForStripe).
	select {
	case err := <-done:
		unlock()
		t.Fatalf("binned (%v) while an upload held the file's stripe", err)
	case <-time.After(300 * time.Millisecond):
	}
	os.WriteFile(x+".new", []byte("a NEW x.avi"), 0o644) // the upload's rename
	os.Rename(x+".new", x)
	unlock()
	if err := <-done; !errors.Is(err, errNotSameFile) {
		t.Errorf("MoveInIfSame = %v, want errNotSameFile", err)
	}
	if got := dsRead(x); got != "a NEW x.avi" {
		t.Errorf("x.avi = %q: the new file went to the bin", got)
	}
}

// TestDS_D10_PositionsWriteTakesStripe: a trip's positions.json (seen and
// moved in Drive) is written under its upload stripe, like a PUT of it.
func TestDS_D10_PositionsWriteTakesStripe(t *testing.T) {
	srv, _, _ := newTestServer(t)
	trip, raw := dsTripRoute(t, srv)
	os.WriteFile(filepath.Join(trip, tripPositionsFile), raw, 0o644)
	abs, _ := srv.users.ResolvePath("user", "ana", "data/trips/t1/"+tripPositionsFile)

	dsWaitsForStripe(t, abs, "the position write", func() int {
		if srv.recordPositions("ana", dsNewPoint()) != 1 {
			return 0
		}
		return 200
	})
	if after, _ := os.ReadFile(filepath.Join(trip, tripPositionsFile)); string(after) == string(raw) {
		t.Error("positions.json was not written")
	}
}

// TestDS_D10_UploadSavedWhenTempNameStays: the upload's file took its name
// but its temp's name could not be removed: the answer is "saved" (a 500
// would make a create-only retry meet its own file), and the startup sweep
// takes the leftover name - never the file.
func TestDS_D10_UploadSavedWhenTempNameStays(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores a read-only folder")
	}
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	dir := filepath.Join(srv.cfg.HomesDir, "ana", "files", "Fotos")
	os.MkdirAll(dir, 0o755)
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	hook := func(root *os.Root, from, to string, linked bool) {
		if linked && filepath.Base(to) == "IMG_1.jpg" {
			os.Chmod(dir, 0o555) // the temp's name can no longer be removed
		}
	}
	testPlaceHook.Store(&hook)
	t.Cleanup(func() { testPlaceHook.Store(nil) })

	resp := do(t, client, "PUT", ts.URL+"/api/files?file=files/Fotos/IMG_1.jpg", strings.NewReader("photo"),
		map[string]string{"If-None-Match": "*"})
	resp.Body.Close()
	os.Chmod(dir, 0o755)
	if resp.StatusCode != http.StatusOK {
		t.Errorf("answer = %d for a file that is saved, want 200", resp.StatusCode)
	}
	if got := dsRead(filepath.Join(dir, "IMG_1.jpg")); got != "photo" {
		t.Fatalf("IMG_1.jpg = %q", got)
	}
	temps := func() (n int) {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if isTempName(e.Name()) {
				n++
			}
		}
		return n
	}
	if temps() != 1 {
		t.Fatalf("%d temps left, want the one whose name stayed", temps())
	}
	srv.tree.SweepStaleTemp()
	if temps() != 0 || dsRead(filepath.Join(dir, "IMG_1.jpg")) != "photo" {
		t.Errorf("after the sweep: %d temps, IMG_1.jpg = %q", temps(), dsRead(filepath.Join(dir, "IMG_1.jpg")))
	}
}

// TestDS_D10_FolderMoveOntoFileMadeMeanwhile: a folder moved onto a name
// that was free at the look and is a FILE by the rename: 409, both stay.
func TestDS_D10_FolderMoveOntoFileMadeMeanwhile(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(files, "A"), 0o755)
	os.WriteFile(filepath.Join(files, "A", "x.txt"), []byte("x"), 0o644)
	fired := dsTakeAtPlacement(t, "B", "a file saved as B")

	code, body := callJSON(t, client, "POST", ts.URL+"/api/files?old=files/A&new=files/B", "")
	if fired.Load() == 0 {
		t.Fatal("the folder move did not go through renameNoReplace")
	}
	if code != http.StatusConflict {
		t.Errorf("move = %d %s, want 409", code, body)
	}
	if dsRead(filepath.Join(files, "B")) != "a file saved as B" || dsRead(filepath.Join(files, "A", "x.txt")) != "x" {
		t.Error("a file was lost or replaced")
	}
}
