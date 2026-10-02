package main

// Tests for paths the audit found with no test at all (S2-#90): the reminder
// tick, the admin's delete-user, emptying and purging the papelera, and the
// cross-disk copy the trash falls back to.

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestReminderTickRingsARepeatingEvent: the whole tick, from calendar.ics to
// the push service. A daily series that began a month ago rings today's
// occurrence (S2-#3) - once, however many ticks see it.
func TestReminderTickRingsARepeatingEvent(t *testing.T) {
	srv, _, _ := newTestServer(t)
	cfg := srv.cfg

	// push.json keeps only real push services, so the device is FCM's - and
	// the push client dials a local server instead.
	var hits atomic.Int32
	service := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer service.Close()
	tr := service.Client().Transport.(*http.Transport).Clone()
	tr.TLSClientConfig.InsecureSkipVerify = true
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, service.Listener.Addr().String())
	}
	srv.push.client = &http.Client{Transport: tr, Timeout: pushTimeout}

	data := filepath.Join(cfg.HomesDir, "ana", "data")
	raw, _ := json.Marshal(map[string]any{"subs": []PushSub{testSub(t, "https://fcm.googleapis.com/fcm/send/a")},
		"window_minutes": 15})
	os.WriteFile(filepath.Join(data, "push.json"), raw, 0o644)

	first := time.Now().Add(5*time.Minute).UTC().AddDate(0, 0, -30)
	ics := "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:diario\r\nSUMMARY:Pastilla\r\n" +
		"DTSTART:" + first.Format("20060102T150405Z") + "\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	os.WriteFile(filepath.Join(data, "calendar.ics"), []byte(ics), 0o644)

	log := quietLog()
	r := NewReminders(cfg, srv.users, srv.trash, srv.sessions, srv.push, srv.trackers, log)
	r.tick()
	if n := hits.Load(); n != 1 {
		t.Fatalf("first tick: %d pushes, want 1 (today's occurrence)", n)
	}
	r.tick()
	if n := hits.Load(); n != 1 {
		t.Fatalf("second tick: %d pushes, want still 1", n)
	}
}

// TestAdminDeletesUser: the home goes, and so do the person's sessions and
// what they shared; a name that is not a home is a 404.
func TestAdminDeletesUser(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	beto := signedInClient(t, ts.URL, "beto", "xyz")
	os.MkdirAll(filepath.Join(srv.cfg.HomesDir, "ana", "files", "album"), 0o755)
	srv.shares.Create("ana", "beto", "files/album", "folder", "", "ro")
	admin := signedInClient(t, ts.URL, "jefe", "secreto")

	jsonCall(t, admin, "POST", ts.URL+"/api/admin", `{"action":"delete-user","name":"nadie"}`, 404, nil)
	jsonCall(t, beto, "POST", ts.URL+"/api/admin", `{"action":"delete-user","name":"ana"}`, 403, nil)
	jsonCall(t, admin, "POST", ts.URL+"/api/admin", `{"action":"delete-user","name":"beto"}`, 200, nil)

	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "beto")); !os.IsNotExist(err) {
		t.Errorf("beto's home is still there (err %v)", err)
	}
	if len(srv.shares.ByOwner("ana")) != 0 {
		t.Error("a share made to the deleted user survived")
	}
	resp := do(t, beto, "GET", ts.URL+"/api/files?file=files/suyo.txt", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("the deleted user's session still answers: %d", resp.StatusCode)
	}
}

// TestTrashPurgeAndEmpty: DELETE ?trash=&ids= purges one entry for good,
// POST ?trash=empty the rest; nothing comes back after either.
func TestTrashPurgeAndEmpty(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	var ids []string
	for _, name := range []string{"uno.txt", "dos.txt", "tres.txt"} {
		os.WriteFile(filepath.Join(files, name), []byte(name), 0o644)
		var out struct{ IDs []string }
		jsonCall(t, client, "DELETE", ts.URL+"/api/files?paths=files/"+name, "", 200, &out)
		ids = append(ids, out.IDs...)
	}
	if len(ids) != 3 {
		t.Fatalf("trashed ids = %v", ids)
	}
	listed := func() int {
		var l struct{ Items []TrashItem }
		jsonCall(t, client, "GET", ts.URL+"/api/files?trash=list", "", 200, &l)
		return len(l.Items)
	}

	var purged struct{ Count int }
	jsonCall(t, client, "DELETE", ts.URL+"/api/files?trash=purge&ids="+ids[0], "", 200, &purged)
	if purged.Count != 1 || listed() != 2 {
		t.Fatalf("purge one: count %d, %d left", purged.Count, listed())
	}
	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=restore&ids="+ids[0], "", 200, nil)
	if _, err := os.Stat(filepath.Join(files, "uno.txt")); !os.IsNotExist(err) {
		t.Error("a purged file came back on restore")
	}

	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=empty", "", 200, &purged)
	if purged.Count != 2 || listed() != 0 {
		t.Fatalf("empty: count %d, %d left", purged.Count, listed())
	}
}

// TestCopyTree: the cross-disk fallback (moveOrCopy) copies a folder whole -
// files, modes, subfolders, and a symlink AS a link. The EXDEV branch itself
// needs two filesystems and is not reachable here.
func TestCopyTree(t *testing.T) {
	src := filepath.Join(t.TempDir(), "album")
	os.MkdirAll(filepath.Join(src, "sub"), 0o755)
	os.WriteFile(filepath.Join(src, "a.txt"), []byte("a"), 0o600)
	os.WriteFile(filepath.Join(src, "sub", "b.txt"), []byte("bb"), 0o644)
	linked := os.Symlink("a.txt", filepath.Join(src, "enlace")) == nil

	dst := filepath.Join(t.TempDir(), "copia")
	if err := copyTree(src, dst); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(dst, "sub", "b.txt")); string(raw) != "bb" {
		t.Errorf("sub/b.txt = %q", raw)
	}
	if info, err := os.Stat(filepath.Join(dst, "a.txt")); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("a.txt lost its mode: %v %v", info, err)
	}
	if linked {
		if target, err := os.Readlink(filepath.Join(dst, "enlace")); err != nil || !strings.HasSuffix(target, "a.txt") {
			t.Errorf("the symlink was not copied as a link: %q %v", target, err)
		}
	}
}
