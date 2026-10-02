package main

// Data-safety seal (cleanup Phase 3, batch S6): the follow-ups of batch S3 -
// a request under way while the admin renames or deletes its account never
// reads as "empty", never brings the old home back, never skips a save's
// version check, and a deleted person's queued films never convert for a new
// person of the same name (L1 L2 L3).

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestDS_L3_OldTagPutTaken: the real PUT route takes a save tagged with the
// account's old name from the renamed account's session (a page loaded
// before the rename), into the renamed home; from another account's session
// the same save stays 423.
func TestDS_L3_OldTagPutTaken(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	adminCall(t, ts.URL, `{"action":"rename-user","name":"ana","new_name":"ana2"}`, http.StatusOK)
	put := func(c *http.Client, body string) (int, string) {
		resp := do(t, c, "PUT", ts.URL+"/api/files?file=data/tareas.json", strings.NewReader(body),
			map[string]string{whoHeader: whoValue("user", "ana")})
		return resp.StatusCode, string(readBody(t, resp))
	}

	ana2 := noFollow()
	signIn(t, ana2, ts.URL, "ana2", "abc")
	if code, raw := put(ana2, `{"de":"ana"}`); code != http.StatusOK {
		t.Fatalf("a save tagged user:ana from ana2's session = %d %s, want 200", code, raw)
	}
	if got, _ := os.ReadFile(filepath.Join(srv.cfg.HomesDir, "ana2", "data", "tareas.json")); string(got) != `{"de":"ana"}` {
		t.Fatalf("the save is not in the renamed home: %q", got)
	}

	beto := noFollow()
	signIn(t, beto, ts.URL, "beto", "xyz")
	if code, _ := put(beto, `{"de":"otra"}`); code != http.StatusLocked {
		t.Fatalf("a save tagged user:ana from beto's session = %d, want 423", code)
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "beto", "data", "tareas.json")); err == nil {
		t.Fatalf("ana's save landed in beto's home")
	}
}

// TestDS_L2_GoneHomeIsNotEmpty: a read under way when the admin renamed the
// account (its session was alive when it came in) answers 503 - "try again"
// - never 404, which the browser's store takes as "no file yet, first run".
// A file really missing from a home that is there is still a 404.
func TestDS_L2_GoneHomeIsNotEmpty(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.WriteFile(filepath.Join(srv.cfg.HomesDir, "ana", "data", "tasks.json"), []byte(`[1,2,3]`), 0o644)
	os.WriteFile(filepath.Join(files, "a.txt"), []byte("a"), 0o644)

	// The rename itself, without the admin handler's sign-out first: the
	// session stands for a request let in just before it.
	if got := srv.users.RenameAccount("ana", "ana2"); got != "renamed" {
		t.Fatalf("rename: %s", got)
	}
	for _, c := range []struct{ method, url string }{
		{"GET", "/api/files?file=data/tasks.json"},
		{"HEAD", "/api/files?file=data/tasks.json"},
		{"GET", "/api/files?dir=files"},
		{"POST", "/api/files?old=files/a.txt&new=files/b.txt"},
	} {
		resp := do(t, client, c.method, ts.URL+c.url, nil, nil)
		raw := readBody(t, resp)
		if resp.StatusCode != http.StatusServiceUnavailable {
			t.Errorf("%s %s while the home moved = %d %s, want 503", c.method, c.url, resp.StatusCode, raw)
		}
	}
	// A save from the version the page holds: "try again", never a conflict
	// over a file nobody changed.
	tag := ""
	if info, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana2", "data", "tasks.json")); err == nil {
		tag = fileETag(info)
	}
	resp := do(t, client, "PUT", ts.URL+"/api/files?file=data/tasks.json", strings.NewReader(`[1]`),
		map[string]string{"If-Match": tag})
	if raw := readBody(t, resp); resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("PUT If-Match while the home moved = %d %s, want 503", resp.StatusCode, raw)
	}
	// A delete is not answered "trashed" for a file it never reached.
	resp = do(t, client, "DELETE", ts.URL+"/api/files?paths=files/a.txt", nil, nil)
	if raw := readBody(t, resp); resp.StatusCode == http.StatusOK {
		t.Errorf("DELETE while the home moved = 200 %s", raw)
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana2", "files", "a.txt")); err != nil {
		t.Errorf("a.txt is not in the renamed home: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(srv.cfg.HomesDir, "ana2", "data", "tasks.json")); string(got) != `[1,2,3]` {
		t.Errorf("tasks.json in the renamed home = %q", got)
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana")); err == nil {
		t.Errorf("homes/ana/ came back (a ghost home)")
	}

	beto := noFollow()
	signIn(t, beto, ts.URL, "beto", "xyz")
	for _, url := range []string{"/api/files?file=data/nada.json", "/api/files?dir=files/nada"} {
		resp := do(t, beto, "GET", ts.URL+url, nil, nil)
		readBody(t, resp)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s (really not there) = %d, want 404", url, resp.StatusCode)
		}
	}
}

// TestDS_L2_TrashNoGhostHome: a delete, or a restore, under way when the
// admin renamed the account fails - it never makes homes/<old>/.trash (a
// ghost home) - and the file stays where it is, in the renamed home.
func TestDS_L2_TrashNoGhostHome(t *testing.T) {
	srv, _, _ := newTestServer(t)
	os.WriteFile(filepath.Join(srv.cfg.HomesDir, "ana", "files", "a.txt"), []byte("a"), 0o644)
	target, ok := srv.users.Resolve("user", "ana", "files/a.txt")
	if !ok {
		t.Fatal("resolve")
	}
	if got := srv.users.RenameAccount("ana", "ana2"); got != "renamed" {
		t.Fatalf("rename: %s", got)
	}
	ghost := filepath.Join(srv.cfg.HomesDir, "ana")

	if _, err := srv.trash.MoveIn("user", "ana", target, "files/a.txt"); err == nil {
		t.Errorf("a delete for the old name went to a bin")
	}
	if _, err := os.Stat(ghost); err == nil {
		t.Fatalf("a delete under way re-created homes/ana/ (a ghost home)")
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana2", "files", "a.txt")); err != nil {
		t.Fatalf("a.txt left the renamed home: %v", err)
	}

	srv.trash.Restore("user", "ana", []string{"1700000000-0123abcd"})
	if _, err := os.Stat(ghost); err == nil {
		t.Fatalf("a restore under way re-created homes/ana/ (a ghost home)")
	}

	// The bin still works for the renamed account, its can made on demand.
	again, _ := srv.users.Resolve("user", "ana2", "files/a.txt")
	if _, err := srv.trash.MoveIn("user", "ana2", again, "files/a.txt"); err != nil {
		t.Fatalf("ana2's own delete: %v", err)
	}
	if items, err := srv.trash.List("user", "ana2"); err != nil || len(items) != 1 {
		t.Fatalf("ana2's bin = %v, %v; want a.txt", items, err)
	}
}

// TestDS_L2_ChatNoGhostHome: a guest's message into a chat whose owner the
// admin renamed a moment ago (the hub still holds the old name) is not
// answered "sent" from a ghost homes/<old>/ - it is refused, and nothing
// comes back under the old name.
func TestDS_L2_ChatNoGhostHome(t *testing.T) {
	f := newChatFixture(t)
	conv, _, _ := dsChatConv(t, f, 1)
	if got := f.srv.users.RenameAccount("ana", "ana2"); got != "renamed" {
		t.Fatalf("rename: %s", got)
	}

	code, body := callJSON(t, anonymous(), "POST", f.base+"/api/c/"+f.carmen+"/conv/"+conv+"/messages", `{"kind":"text","text":"hola"}`)
	if code == http.StatusCreated || code == http.StatusOK {
		t.Errorf("a message into the moved home was answered %d %s", code, body)
	}
	if _, err := os.Stat(filepath.Join(f.srv.cfg.HomesDir, "ana")); err == nil {
		t.Fatalf("the chat re-created homes/ana/ (a ghost home)")
	}
}

// TestDS_L2_MkdirInHomeNeverMakesHome: the helper every server write under a
// home makes its folders with: inside a home that is there, yes; the home
// itself, never.
func TestDS_L2_MkdirInHomeNeverMakesHome(t *testing.T) {
	homes := t.TempDir()
	os.MkdirAll(filepath.Join(homes, "ana"), 0o755)
	if err := mkdirInHome(homes, filepath.Join(homes, "ana", "data", "devices")); err != nil {
		t.Fatalf("inside a home: %v", err)
	}
	if info, err := os.Stat(filepath.Join(homes, "ana", "data", "devices")); err != nil || !info.IsDir() {
		t.Fatalf("the folder was not made: %v", err)
	}
	if err := mkdirInHome(homes, filepath.Join(homes, "ido", "data", "devices")); err == nil {
		t.Errorf("a folder in a missing home was made")
	}
	if _, err := os.Stat(filepath.Join(homes, "ido")); err == nil {
		t.Fatalf("homes/ido/ was made (a ghost home)")
	}
}

// renameOnRead is a request body that runs `hook` the first time the server
// reads it - by then the upload has its folder open (streamToFile) - and
// then hands out `body`.
type renameOnRead struct {
	hook func()
	body io.Reader
}

func (b *renameOnRead) Read(p []byte) (int, error) {
	if b.hook != nil {
		b.hook()
		b.hook = nil
	}
	return b.body.Read(p)
}

// TestDS_L2_UploadChecksTheOpenFolder: an upload under way when the admin
// renames the account lands in the renamed home - so its last checks, under
// the path's lock, must look there too: a change made while the body
// streamed still answers 412, a save from the current version is taken, and
// an empty body never replaces a document.
func TestDS_L2_UploadChecksTheOpenFolder(t *testing.T) {
	cases := []struct {
		name    string
		file    string
		body    string
		headers func(info os.FileInfo) map[string]string
		change  bool // the file changes while the body streams
		want    int
		left    string // what the renamed home holds at the end
	}{
		{"changed meanwhile, If-Unmodified-Since", "files/nota.txt", "la mía",
			func(info os.FileInfo) map[string]string {
				return map[string]string{"If-Unmodified-Since": info.ModTime().UTC().Format(http.TimeFormat)}
			}, true, http.StatusPreconditionFailed, "la del otro móvil"},
		{"unchanged, If-Match", "files/nota.txt", "la mía",
			func(info os.FileInfo) map[string]string {
				return map[string]string{"If-Match": fileETag(info)}
			}, false, http.StatusOK, "la mía"},
		{"an empty body over a document", "data/tasks.json", "",
			func(os.FileInfo) map[string]string { return nil }, false, http.StatusConflict, "la de antes"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv, _, _ := newTestServer(t)
			path := filepath.Join(srv.cfg.HomesDir, "ana", filepath.FromSlash(c.file))
			os.WriteFile(path, []byte("la de antes"), 0o644)
			old := time.Now().Add(-time.Hour).Truncate(time.Second)
			os.Chtimes(path, old, old)
			info, _ := os.Stat(path)
			target, ok := srv.users.Resolve("user", "ana", c.file)
			if !ok {
				t.Fatal("resolve")
			}

			moved := filepath.Join(srv.cfg.HomesDir, "ana2", filepath.FromSlash(c.file))
			hook := func() {
				if c.change { // another device saves, then the admin renames
					os.WriteFile(path, []byte("la del otro móvil"), 0o644)
					later := old.Add(time.Minute)
					os.Chtimes(path, later, later)
				}
				if got := srv.users.RenameAccount("ana", "ana2"); got != "renamed" {
					t.Errorf("rename: %s", got)
				}
			}
			r := httptest.NewRequest("PUT", "/api/files?file="+c.file, &renameOnRead{hook: hook, body: strings.NewReader(c.body)})
			r.ContentLength = int64(len(c.body))
			for k, v := range c.headers(info) {
				r.Header.Set(k, v)
			}
			w := httptest.NewRecorder()
			srv.filesWrite(w, r, "user", "ana", c.file, target)

			if w.Code != c.want {
				t.Errorf("answered %d %s, want %d", w.Code, w.Body.String(), c.want)
			}
			if got, _ := os.ReadFile(moved); string(got) != c.left {
				t.Errorf("the renamed home holds %q, want %q", got, c.left)
			}
			if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana")); err == nil {
				t.Errorf("homes/ana/ came back (a ghost home)")
			}
		})
	}
}

// TestDS_L1_DeleteUserDropsConversions: the admin deletes ana while a film
// of hers waits in the queue. The job goes - from memory and from
// convert.json - so a NEW person later called ana never has it converted,
// nor binned, in their home.
func TestDS_L1_DeleteUserDropsConversions(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	job := ConvertJob{User: "ana", Path: "files/Pelis/prueba.avi", Added: time.Now().Unix()}
	other := ConvertJob{User: "beto", Path: "files/suya.avi", Added: time.Now().Unix()}
	srv.convert.mu.Lock()
	srv.convert.queue = append(srv.convert.queue, job, other)
	srv.convert.saveLocked()
	srv.convert.mu.Unlock()

	adminCall(t, ts.URL, `{"action":"delete-user","name":"ana"}`, http.StatusOK)
	adminCall(t, ts.URL, `{"action":"create-user","name":"ana","password":"nueva"}`, http.StatusOK)

	if jobs := srv.convert.Status("ana"); len(jobs) != 0 {
		t.Fatalf("the new ana has the deleted person's %d conversion(s) queued: %+v", len(jobs), jobs)
	}
	if jobs := srv.convert.Status("beto"); len(jobs) != 1 {
		t.Errorf("beto's job went too: %+v", jobs)
	}
	var saved struct {
		Queue []ConvertJob `json:"queue"`
	}
	loadJSONFile(filepath.Join(srv.cfg.ConfigDir, "convert.json"), &saved)
	if len(saved.Queue) != 1 || saved.Queue[0] != other {
		t.Fatalf("convert.json = %+v, want beto's job only (a restart would bring ana's back)", saved.Queue)
	}
}

// TestDS_L1_DroppedRunningJobTellsNobody: the job converting right now when
// its owner is deleted leaves the queue at once (nothing shows it as
// running), and its end is told to nobody - the name may be a new person's:
// a new ana with a phone, given the name while it ran, gets no push of it.
func TestDS_L1_DroppedRunningJobTellsNobody(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	job := ConvertJob{User: "ana", Path: "files/Pelis/prueba.avi", Added: time.Now().Unix()}
	next := ConvertJob{User: "beto", Path: "files/suya.avi", Added: time.Now().Unix()}
	srv.convert.mu.Lock()
	srv.convert.queue = []ConvertJob{job, next}
	srv.convert.running = true // Run took the head
	srv.convert.mu.Unlock()

	srv.convert.DropUser("ana")
	if st := srv.convert.Status("beto"); len(st) != 1 || st[0].State != "queued" {
		t.Fatalf("beto's job = %+v, want it queued (ana's was the one running)", st)
	}
	if srv.convert.stillQueued(job) {
		t.Fatalf("the dropped job still counts as queued: its end would be pushed to the name")
	}

	// The home goes and a NEW ana gets the name, with a phone. Then the
	// dropped run ends: her home has no such film, so it fails - and the
	// failure is what would be pushed to her.
	adminCall(t, ts.URL, `{"action":"delete-user","name":"ana"}`, http.StatusOK)
	adminCall(t, ts.URL, `{"action":"create-user","name":"ana","password":"nueva123"}`, http.StatusOK)
	pushed := zoneRingService(t, srv)
	sub := testSub(t, "https://fcm.googleapis.com/fcm/send/nueva-ana")
	if got := srv.users.AddPushSub("ana", sub.Endpoint, sub.Keys.P256dh, sub.Keys.Auth, "es", "Móvil", nil); got != "added" {
		t.Fatalf("the new ana's phone: %s", got)
	}
	srv.convert.runOne(context.Background(), job)
	if got := pushed(); len(got) != 0 {
		t.Fatalf("the new ana was told of the deleted person's film: pushes to %v", got)
	}
}
