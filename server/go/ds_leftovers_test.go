package main

// Data-safety seal (cleanup Phase 3, batch S7): the last server leftovers the
// reviews of S3 and S6 found - a request under way while the admin renames
// or deletes its account never reads as "not there", never answers "purged"
// for a file it did not reach, and never queues a film under a name that
// changed hands (L1 L2).

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestDS_L2_GoneHomeNotFoundRoutes: copy, the .zip list, Compress, the
// Office twin and Download (its POST, and the GET of one asked for before),
// while the admin renames the account under them (the session was alive when
// the request came in), answer 503 - "try again" - never 404, which a page
// takes as "no such file". A path really missing from a home that is there
// is still 404 on each.
func TestDS_L2_GoneHomeNotFoundRoutes(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	for _, name := range []string{"a.txt", "caja.zip", "x.odt"} {
		os.WriteFile(filepath.Join(files, name), []byte("algo"), 0o644)
	}
	beto := noFollow()
	signIn(t, beto, ts.URL, "beto", "xyz")
	var dl struct{ ID string }
	jsonCall(t, client, "POST", ts.URL+"/api/download?paths=files/a.txt", "", http.StatusOK, &dl)

	// The rename itself, without the admin handler's sign-out first: the
	// session stands for a request let in just before it.
	if got := srv.users.RenameAccount("ana", "ana2"); got != "renamed" {
		t.Fatalf("rename: %s", got)
	}
	resp := do(t, client, "GET", ts.URL+"/api/download?id="+dl.ID, nil, nil)
	if raw := readBody(t, resp); resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("a download asked for before the rename = %d %s, want 503", resp.StatusCode, raw)
	}
	for _, c := range []struct{ name, method, moved, missing string }{
		{"copy", "POST", "/api/files?from=files/a.txt&new=files/b.txt", "/api/files?from=files/nada.txt&new=files/b.txt"},
		{"zip list", "GET", "/api/zip?file=files/caja.zip", "/api/zip?file=files/nada.zip"},
		{"compress", "POST", "/api/zip?paths=files/a.txt", "/api/zip?paths=files/nada.txt"},
		{"office twin", "POST", "/api/office?file=files/x.odt", "/api/office?file=files/nada.odt"},
		{"download", "POST", "/api/download?paths=files/a.txt", "/api/download?paths=files/nada.txt"},
	} {
		resp := do(t, client, c.method, ts.URL+c.moved, nil, nil)
		if raw := readBody(t, resp); resp.StatusCode != http.StatusServiceUnavailable {
			t.Errorf("%s while the home moved = %d %s, want 503", c.name, resp.StatusCode, raw)
		}
		resp = do(t, beto, c.method, ts.URL+c.missing, nil, nil)
		if raw := readBody(t, resp); resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s of a path really not there = %d %s, want 404", c.name, resp.StatusCode, raw)
		}
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana")); err == nil {
		t.Errorf("homes/ana/ came back (a ghost home)")
	}
}

// TestDS_L2_PurgeNotAnsweredWhenHomeMoved: a purge (an app's real delete of
// its thumbnails) under way when the admin renamed the account reached
// nothing - it is never answered "purged", and the file is still in the
// renamed home.
func TestDS_L2_PurgeNotAnsweredWhenHomeMoved(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	rel := filepath.Join("data", "photos", "thumbs", "10_20.jpg")
	thumb := filepath.Join(srv.cfg.HomesDir, "ana", rel)
	os.MkdirAll(filepath.Dir(thumb), 0o755)
	os.WriteFile(thumb, []byte("jpg"), 0o644)

	if got := srv.users.RenameAccount("ana", "ana2"); got != "renamed" {
		t.Fatalf("rename: %s", got)
	}
	resp := do(t, client, "DELETE", ts.URL+"/api/files?paths=data/photos/thumbs/10_20.jpg&purge=1", nil, nil)
	raw := readBody(t, resp)
	if resp.StatusCode == http.StatusOK {
		t.Errorf("a purge while the home moved = 200 %s: answered as done", raw)
	}
	if !strings.Contains(string(raw), "10_20.jpg") {
		t.Errorf("the answer does not name what was not deleted: %s", raw)
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana2", rel)); err != nil {
		t.Errorf("the thumbnail left the renamed home: %v", err)
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana")); err == nil {
		t.Errorf("homes/ana/ came back (a ghost home)")
	}
}

// TestDS_L1_EnqueueAfterRenameQueuesNoOldName: "Subir y convertir" whose
// body still streams when the admin renames ana to ana2. The film lands in
// ana2's home, but no job is left under "ana" - where it would never find
// the film, and a NEW person given the name later would inherit it.
func TestDS_L1_EnqueueAfterRenameQueuesNoOldName(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	if !srv.convert.Available() {
		// Enqueue needs ffmpeg to be there; nothing runs it in a test (the
		// worker starts in main), so any name will do.
		srv.convert.ffmpeg, srv.convert.ffprobe = "ffmpeg", "ffprobe"
	}
	os.MkdirAll(filepath.Join(srv.cfg.HomesDir, "ana", "files", "Pelis"), 0o755)
	rel := "files/Pelis/x.avi"
	target, ok := srv.users.Resolve("user", "ana", rel)
	if !ok {
		t.Fatal("resolve")
	}

	hook := func() {
		adminCall(t, ts.URL, `{"action":"rename-user","name":"ana","new_name":"ana2"}`, http.StatusOK)
	}
	body := "un avi de verdad no hace falta"
	r := httptest.NewRequest("PUT", "/api/files?file="+rel+"&convert=mp4",
		&renameOnRead{hook: hook, body: strings.NewReader(body)})
	r.ContentLength = int64(len(body))
	w := httptest.NewRecorder()
	srv.filesWrite(w, r, "user", "ana", rel, target)

	if w.Code != http.StatusOK {
		t.Fatalf("the upload answered %d %s, want 200 (it lands in the renamed home)", w.Code, w.Body.String())
	}
	if got, _ := os.ReadFile(filepath.Join(srv.cfg.HomesDir, "ana2", "files", "Pelis", "x.avi")); string(got) != body {
		t.Fatalf("the film is not in ana2's home: %q", got)
	}
	if jobs := srv.convert.Status("ana"); len(jobs) != 0 {
		t.Errorf("a job was queued under the old name: %+v", jobs)
	}
	if jobs := srv.convert.Status("ana2"); len(jobs) > 1 {
		t.Errorf("ana2's queue = %+v, want at most her one film", jobs)
	}
	var saved struct {
		Queue []ConvertJob `json:"queue"`
	}
	loadJSONFile(filepath.Join(srv.cfg.ConfigDir, "convert.json"), &saved)
	for _, j := range saved.Queue {
		if j.User == "ana" {
			t.Errorf("convert.json holds a job under the old name: %+v", j)
		}
	}
	adminCall(t, ts.URL, `{"action":"create-user","name":"ana","password":"nueva123"}`, http.StatusOK)
	if jobs := srv.convert.Status("ana"); len(jobs) != 0 {
		t.Fatalf("the NEW ana inherits a job: %+v", jobs)
	}
}

// TestDS_L1_DeleteMovesEpochBeforeDroppingFilms: the admin's delete moves
// the name's counter BEFORE it drops the name's films. Else an upload that
// reaches the queue in between - after the drop, before the counter -
// queued its film under the deleted name, for whoever is given it next. The
// delete is held at the queue's lock (inside Converter.DropUser): by then
// the counter must have moved, so such an upload is refused.
func TestDS_L1_DeleteMovesEpochBeforeDroppingFilms(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	admin := noFollow()
	signIn(t, admin, ts.URL, "jefe", "secreto")
	upload, ok := srv.users.Resolve("user", "beto", "files/suya.avi")
	if !ok {
		t.Fatal("resolve")
	}

	srv.convert.mu.Lock()
	var unlock sync.Once
	defer unlock.Do(srv.convert.mu.Unlock)
	done := make(chan int, 1)
	go func() {
		req, _ := http.NewRequest("POST", ts.URL+"/api/admin", strings.NewReader(`{"action":"delete-user","name":"beto"}`))
		req.Header.Set("Content-Type", "application/json")
		resp, err := admin.Do(req)
		if err != nil {
			done <- 0
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()
	// The delete runs until it waits for the lock. A wait on a condition:
	// with the right order the counter moves at once; with the wrong one it
	// never moves while the lock is held, and this gives up.
	for end := time.Now().Add(5 * time.Second); !upload.epoch.moved() && time.Now().Before(end); {
		time.Sleep(5 * time.Millisecond)
	}
	moved := upload.epoch.moved()
	unlock.Do(srv.convert.mu.Unlock)
	if code := <-done; code != http.StatusOK {
		t.Fatalf("delete-user = %d", code)
	}
	if !moved {
		t.Fatalf("the delete dropped the films before it moved the counter: an upload ending then queues under the deleted name")
	}
}

// TestDS_L1_PhoneUploadQueuesNoOldName: a video the phone app uploads while
// the admin renames its owner (ana to ana2) is filed in ana2's home, but no
// job is left under "ana". The rename lands while the end is under way:
// after its folder opened, before the film is filed.
func TestDS_L1_PhoneUploadQueuesNoOldName(t *testing.T) {
	shortHold(t)
	srv, ts, client := newTestServer(t)
	if !srv.convert.Available() {
		srv.convert.ffmpeg, srv.convert.ffprobe = "ffmpeg", "ffprobe" // nothing runs it in a test
	}
	signIn(t, client, ts.URL, "ana", "abc")
	id := enrolPhone(t, client, ts.URL)
	jsonCall(t, client, "PUT", ts.URL+"/api/device/"+id, `{"media":true}`, 200, nil)
	m := mediaPhone{t, ts.URL}

	data := bytes.Repeat([]byte("avi"), 100)
	code, st := m.start("vid-1", "VID_1.avi", int64(len(data)), time.Now())
	if code != 200 {
		t.Fatalf("start = %d %v", code, st)
	}
	up := st["upload"].(string)
	if code, out := m.put(up, 0, data); code != 200 {
		t.Fatalf("put = %d %v", code, out)
	}

	var once sync.Once
	hook := func(root *os.Root, from, to string, linked bool) {
		once.Do(func() {
			// What the admin's rename does to the home and the queue.
			srv.users.RenameAccount("ana", "ana2")
			srv.convert.RenameUser("ana", "ana2")
		})
	}
	testPlaceHook.Store(&hook)
	t.Cleanup(func() { testPlaceHook.Store(nil) })
	code, out := m.end(up)
	testPlaceHook.Store(nil)
	if code != 200 {
		t.Fatalf("end = %d %v, want 200 (the film is filed in the renamed home)", code, out)
	}
	rel, _ := out["path"].(string)
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana2", filepath.FromSlash(rel))); err != nil {
		t.Fatalf("the film is not in ana2's home: %v", err)
	}
	if jobs := srv.convert.Status("ana"); len(jobs) != 0 {
		t.Errorf("a job was queued under the old name: %+v", jobs)
	}
	if jobs := srv.convert.Status("ana2"); len(jobs) > 1 {
		t.Errorf("ana2's queue = %+v, want at most her one film", jobs)
	}
	raw, _ := os.ReadFile(filepath.Join(srv.cfg.ConfigDir, "convert.json"))
	var saved struct{ Queue []ConvertJob }
	json.Unmarshal(raw, &saved)
	for _, j := range saved.Queue {
		if j.User == "ana" {
			t.Errorf("convert.json holds a job under the old name: %+v", j)
		}
	}
}
