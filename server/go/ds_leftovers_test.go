package main

// Data-safety seal (cleanup Phase 3, batch S7): the last server leftovers the
// reviews of S3 and S6 found - a request under way while the admin renames
// or deletes its account never reads as "not there", never answers "purged"
// for a file it did not reach, and never queues a film under a name that
// changed hands (L1 L2).

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDS_L2_GoneHomeNotFoundRoutes: copy, the .zip list, Compress and the
// Office twin, while the admin renames the account under them (the session
// was alive when the request came in), answer 503 - "try again" - never 404,
// which a page takes as "no such file". A path really missing from a home
// that is there is still 404 on each.
func TestDS_L2_GoneHomeNotFoundRoutes(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	for _, name := range []string{"a.txt", "caja.zip", "x.odt"} {
		os.WriteFile(filepath.Join(files, name), []byte("algo"), 0o644)
	}
	beto := noFollow()
	signIn(t, beto, ts.URL, "beto", "xyz")

	// The rename itself, without the admin handler's sign-out first: the
	// session stands for a request let in just before it.
	if got := srv.users.RenameAccount("ana", "ana2"); got != "renamed" {
		t.Fatalf("rename: %s", got)
	}
	for _, c := range []struct{ name, method, moved, missing string }{
		{"copy", "POST", "/api/files?from=files/a.txt&new=files/b.txt", "/api/files?from=files/nada.txt&new=files/b.txt"},
		{"zip list", "GET", "/api/zip?file=files/caja.zip", "/api/zip?file=files/nada.zip"},
		{"compress", "POST", "/api/zip?paths=files/a.txt", "/api/zip?paths=files/nada.txt"},
		{"office twin", "POST", "/api/office?file=files/x.odt", "/api/office?file=files/nada.odt"},
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
// the film, and a NEW person given the name later would inherit it. The same
// for a delete: a film whose upload ends after the admin dropped the name's
// jobs queues nothing under it.
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

	// Delete: the upload's path was approved before the admin dropped the
	// name's jobs, and reaches the queue after.
	beto, ok := srv.users.Resolve("user", "beto", "files/suya.avi")
	if !ok {
		t.Fatal("resolve beto")
	}
	srv.convert.DropUser("beto")
	if srv.convert.EnqueueAt("beto", "files/suya.avi", beto.epoch) {
		t.Errorf("a film was queued under a name whose jobs were just dropped")
	}
	if jobs := srv.convert.Status("beto"); len(jobs) != 0 {
		t.Errorf("beto's queue after the drop = %+v", jobs)
	}
}
