package main

// Tests for the Go review of 2026-11-14 (docs/audit/go-2026-11-14.md).

import (
	"archive/zip"
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// addTestUser makes one more account in a test server's homes.
func addTestUser(t *testing.T, srv *Server, name, password string) {
	t.Helper()
	home := filepath.Join(srv.cfg.HomesDir, name)
	os.MkdirAll(filepath.Join(home, "data"), 0o755)
	os.MkdirAll(filepath.Join(home, "files"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "config.json"), []byte(`{"password":"`+password+`"}`), 0o644)
}

// G1: the admin's file API never READS config/ - not a file, not inside a
// Download or Compress of the base dir.
func TestGoReviewConfigNotReadable(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "jefe", "secreto")
	os.WriteFile(filepath.Join(srv.cfg.ConfigDir, "ssh-totp.json"), []byte(`{"secret":"x"}`), 0o600)

	for _, f := range []string{"config/server.json", "config/ssh-totp.json"} {
		resp := do(t, client, "GET", ts.URL+"/api/files?file="+f, nil, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("GET %s = %d, want 403", f, resp.StatusCode)
		}
	}
	// Another file of the admin's still reads.
	os.WriteFile(filepath.Join(srv.cfg.BaseDir, "nota.txt"), []byte("hola"), 0o644)
	resp := do(t, client, "GET", ts.URL+"/api/files?file=nota.txt", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET nota.txt = %d, want 200", resp.StatusCode)
	}

	items, _, _, roots, status, _ := srv.zipSources("admin", "jefe", []string{"homes", "config"})
	closeRoots(roots)
	if status != http.StatusForbidden {
		t.Errorf("zip of config/ = %d, want 403", status)
	}
	_ = items

	// The whole base dir (the admin's Drive root): everything but config/.
	items, _, _, roots, status, _ = srv.zipSources("admin", "jefe", []string{"."})
	closeRoots(roots)
	if status != 0 {
		t.Fatalf("zip of the base dir = %d", status)
	}
	sawNote := false
	for _, it := range items {
		if strings.Contains(it.name, "ssh-totp.json") || strings.Contains(it.name, "server.json") {
			t.Errorf("the base dir's zip holds %s", it.name)
		}
		sawNote = sawNote || strings.HasSuffix(it.name, "/nota.txt")
	}
	if !sawNote {
		t.Error("the base dir's zip lost the admin's own file")
	}
}

// G2: an OLD watch alert is never live: whoever got it neither follows her
// now nor ends her current alarm.
func TestGoReviewOldWatchAlertNotLive(t *testing.T) {
	srv, ts, ana := newTestServer(t)
	signIn(t, ana, ts.URL, "ana", "abc")
	beto := noFollow()
	signIn(t, beto, ts.URL, "beto", "xyz")
	jsonCall(t, ana, "PUT", ts.URL+"/api/sos", `{"contacts":["beto"]}`, 200, nil)

	jsonCall(t, ana, "POST", ts.URL+"/api/sos/watch", `{}`, 200, nil)
	w1 := srv.sosWatchFire("ana", 0, nil)
	if w1 == nil {
		t.Fatal("no first watch alert")
	}
	jsonCall(t, ana, "POST", ts.URL+"/api/sos/watch/stop", `{}`, 200, nil)
	jsonCall(t, ana, "POST", ts.URL+"/api/sos/watch", `{}`, 200, nil)
	w2 := srv.sosWatchFire("ana", 0, nil)
	if w2 == nil {
		t.Fatal("no second watch alert")
	}

	var got struct{ Live bool }
	jsonCall(t, beto, "GET", ts.URL+"/api/sos/alert/"+w1.ID, "", 200, &got)
	if got.Live {
		t.Error("the old alert is live")
	}
	jsonCall(t, beto, "POST", ts.URL+"/api/sos/alert/"+w1.ID+"/end", `{}`, 409, nil)
	if srv.sos.Get("ana").WatchAlert != w2.ID {
		t.Fatal("the old alert ended the current one")
	}
	jsonCall(t, beto, "GET", ts.URL+"/api/sos/alert/"+w2.ID, "", 200, &got)
	if !got.Live {
		t.Error("the current alert is not live")
	}
	jsonCall(t, beto, "POST", ts.URL+"/api/sos/alert/"+w2.ID+"/end", `{}`, 200, nil)
	if srv.sos.Get("ana").WatchAlert != "" {
		t.Error("the current alert did not end")
	}
}

// G4: "I'm safe" from the build before the PIN posts no body at all.
// G18: while a watch counts, contacts are never removed.
func TestGoReviewWatchStopNoBodyAndContactsKept(t *testing.T) {
	_, ts, ana := newTestServer(t)
	signIn(t, ana, ts.URL, "ana", "abc")
	jsonCall(t, ana, "PUT", ts.URL+"/api/sos", `{"contacts":["beto"]}`, 200, nil)
	jsonCall(t, ana, "POST", ts.URL+"/api/sos/watch", `{}`, 200, nil)

	jsonCall(t, ana, "PUT", ts.URL+"/api/sos", `{"contacts":[]}`, 409, nil)
	jsonCall(t, ana, "PUT", ts.URL+"/api/sos", `{"contacts":["beto"],"idle":2}`, 200, nil)

	resp := do(t, ana, "POST", ts.URL+"/api/sos/watch/stop", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stop with no body = %d, want 200", resp.StatusCode)
	}
	jsonCall(t, ana, "PUT", ts.URL+"/api/sos", `{"contacts":[]}`, 200, nil)
}

// G5: one user's alerts never push out another's open watch alert.
// G16: alerts follow a rename and go with a deleted sender.
func TestGoReviewSosAlertsPerSender(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}})
	srv.sos.addAlert(sosAlert{ID: "open1", From: "ana", Kind: "watch", At: time.Now().Unix(), To: []sosSent{{User: "beto"}}})
	srv.sos.mu.Lock()
	srv.sos.rowLocked("ana", false).WatchAlert = "open1"
	srv.sos.mu.Unlock()
	for i := 0; i < sosAlertsKept+10; i++ {
		srv.sos.addAlert(sosAlert{ID: "b" + itoa(i), From: "beto", Kind: "test", At: time.Now().Unix()})
	}
	if srv.sos.alertByID("ana", "open1") == nil {
		t.Fatal("beto's sends pushed out ana's open alert")
	}
	n := 0
	for _, a := range srv.sos.data.Alerts {
		if a.From == "beto" {
			n++
		}
	}
	if n != sosAlertsKept {
		t.Errorf("beto keeps %d alerts, want %d", n, sosAlertsKept)
	}

	srv.sos.RenameUser("beto", "bruno")
	if a := srv.sos.alertFor("open1", "bruno"); a == nil {
		t.Error("the renamed contact lost the alert")
	}
	srv.sos.DropUser("ana")
	if srv.sos.alertByID("ana", "open1") != nil {
		t.Error("a deleted sender's alert stays")
	}
}

// G7: a share removal that could not be written is not answered as done, and
// the grant stays - in memory as on disk.
func TestGoReviewShareRevokeRollsBack(t *testing.T) {
	dir := t.TempDir()
	homes := filepath.Join(dir, "homes")
	os.MkdirAll(filepath.Join(homes, "ana", "files", "x"), 0o755)
	os.MkdirAll(filepath.Join(dir, "config"), 0o755)
	s := NewShares(filepath.Join(dir, "config"), homes, quietLog())
	g := s.Create("ana", "beto", "files/x", "folder", "x", "ro")
	if g == nil {
		t.Fatal("no grant")
	}
	good := s.path
	blocker := filepath.Join(dir, "not-a-folder")
	os.WriteFile(blocker, []byte("x"), 0o644)
	s.mu.Lock()
	s.path = filepath.Join(blocker, "shares.json")
	s.mu.Unlock()

	if ok, err := s.RevokeChecked(g.ID, "ana"); ok || err == nil {
		t.Fatalf("revoke on a broken disk = %v, %v", ok, err)
	}
	if len(s.ForUser("beto")) != 1 {
		t.Fatal("the grant went from memory although it is still on disk")
	}
	if g2, err := s.CreateChecked("ana", "carol", "files/x", "folder", "x", "ro"); g2 != nil || err == nil {
		t.Fatalf("create on a broken disk = %v, %v", g2, err)
	}
	if len(s.ByOwner("ana")) != 1 {
		t.Fatal("a grant that was not written stays in memory")
	}
	s.mu.Lock()
	s.path = good
	s.mu.Unlock()
	if ok, err := s.RevokeChecked(g.ID, "ana"); !ok || err != nil {
		t.Fatalf("revoke = %v, %v", ok, err)
	}
}

// G11: a grant of an item binned before Park existed is parked at load.
func TestGoReviewParkBinnedAtLoad(t *testing.T) {
	dir := t.TempDir()
	homes := filepath.Join(dir, "homes")
	config := filepath.Join(dir, "config")
	os.MkdirAll(filepath.Join(homes, "ana", ".trash"), 0o755)
	os.MkdirAll(filepath.Join(homes, "ana", "data", "trips"), 0o755)
	os.MkdirAll(config, 0o755)
	os.WriteFile(filepath.Join(config, "shares.json"), []byte(`{"shares":[
		{"id":"s1","owner":"ana","to":"beto","slug":"lisboa","root":"data/trips/lisboa","app":"trips","mode":"ro","title":"lisboa","created":1600000000},
		{"id":"s2","owner":"ana","to":"","slug":"link-s2","root":"data/trips/lisboa","app":"trips","mode":"ro","title":"lisboa","created":1600000000,"token":"tok"},
		{"id":"s3","owner":"ana","to":"beto","slug":"porto","root":"data/trips/porto","app":"trips","mode":"ro","title":"porto","created":1800000000}]}`), 0o644)
	os.WriteFile(filepath.Join(homes, "ana", ".trash", "index.json"), []byte(`{
		"1700000000-0000000a": {"orig":"data/trips/lisboa","name":"lisboa","deleted":1700000000,"dir":true,"size":null},
		"1700000500-0000000b": {"orig":"data/trips/lisboa","name":"lisboa","deleted":1700000500,"dir":true,"size":null},
		"1700000600-0000000c": {"orig":"data/trips/porto","name":"porto","deleted":1700000600,"dir":true,"size":null}}`), 0o644)
	// lisboa is gone: parked. porto is there (its grant newer than its bin
	// entry): left as it is - an item at the path is never parked at load.
	os.MkdirAll(filepath.Join(homes, "ana", "data", "trips", "porto"), 0o755)

	s := NewShares(config, homes, quietLog())
	for _, g := range s.ByOwner("ana") {
		want := ".trash/1700000500-0000000b"
		if g.ID == "s3" {
			want = "data/trips/porto"
		}
		if g.Root != want {
			t.Errorf("grant %s root = %q, want %q", g.ID, g.Root, want)
		}
	}
	// A new lisboa made after the load: never lent by the old grants.
	os.MkdirAll(filepath.Join(homes, "ana", "data", "trips", "lisboa"), 0o755)
	if n := len(s.RootNodes("beto")); n != 1 {
		t.Errorf("beto sees %d shares, want 1 (porto only)", n)
	}
}

// G12: "Extract here" never makes the Chat server's own folder.
func TestGoReviewExtractNoServerFolder(t *testing.T) {
	srv, ts, ana := newTestServer(t)
	signIn(t, ana, ts.URL, "ana", "abc")
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	f, _ := zw.Create("chat/state.json")
	f.Write([]byte("{}"))
	zw.Close()
	data := filepath.Join(srv.cfg.HomesDir, "ana", "data")
	os.RemoveAll(filepath.Join(data, "chat"))
	os.WriteFile(filepath.Join(data, "chat.zip"), buf.Bytes(), 0o644)

	code, raw := callJSON(t, ana, "POST", ts.URL+"/api/zip?file=data/chat.zip", "")
	if code != http.StatusForbidden {
		t.Errorf("extract = %d, want 403: %s", code, raw)
	}
	if _, err := os.Stat(filepath.Join(data, "chat")); err == nil {
		t.Error("data/chat was made")
	}
}

// G22: only a failure that may pass asks a phone to send again.
func TestGoReviewMayPass(t *testing.T) {
	if !mayPass(&os.PathError{Op: "write", Path: "x", Err: syscall.ENOSPC}) {
		t.Error("disk full is worth a retry")
	}
	if mayPass(&os.PathError{Op: "open", Path: "x", Err: syscall.EACCES}) {
		t.Error("no permission is never worth a retry")
	}
	if p, ok := newestValid([]tripPosition{{Lat: 0, Lon: 0, At: time.Now().Unix()},
		{Lat: 40, Lon: -3, At: time.Now().Add(time.Hour * 24 * 30).Unix()},
		{Lat: 41, Lon: -3, At: time.Now().Unix() - 60}}); !ok || p.Lat != 41 {
		t.Errorf("newestValid = %+v %v, want the 41,-3 point (G17)", p, ok)
	}
}

// G6: a signal is read - and dropped - only by its page AND its person; a
// page id in a live call is never another person's to use.
func TestGoReviewCallSignalsByPerson(t *testing.T) {
	o := &chatOwner{}
	cs := o.cs()
	c := &chatCall{ID: "k1", From: "o", To: "luis", FromDev: "owner-page-1", ToDev: "luis-page-1", State: "active"}
	cs.byID[c.ID] = c
	cs.sigs = append(cs.sigs, &chatSig{Seq: 1, Call: c.ID, to: "luis-page-1", who: c.sigTo("luis-page-1")})

	if len(cs.sigsFor("luis-page-1", "carmen", 0)) != 0 || cs.pending("luis-page-1", "carmen", 0) {
		t.Fatal("another person reads a signal by its page id")
	}
	cs.ack("luis-page-1", "carmen", 999)
	if len(cs.sigsFor("luis-page-1", "luis", 0)) != 1 {
		t.Fatal("another person dropped the signal")
	}
	if !cs.devTaken("owner-page-1", "carmen") || cs.devTaken("owner-page-1", "o") {
		t.Fatal("devTaken is wrong about the owner's page")
	}
	c.State = "ended"
	if cs.devTaken("owner-page-1", "carmen") {
		t.Fatal("a page of a call that is over stays taken")
	}
}

// G8: a phone revoke that could not be written is not answered as done; the
// phone stays - in memory as on disk.
func TestGoReviewDeviceRevokeRollsBack(t *testing.T) {
	dir := t.TempDir()
	d := NewDevices(dir, dir, quietLog())
	id, err := d.Enrol("ana", phoneToken, "Pixel", "", 3)
	if err != nil {
		t.Fatalf("enrol: %v", err)
	}
	good := d.path
	blocker := filepath.Join(dir, "not-a-folder")
	os.WriteFile(blocker, []byte("x"), 0o644)
	d.mu.Lock()
	d.path = filepath.Join(blocker, "devices.json")
	d.mu.Unlock()
	if err := d.Revoke("ana", id); err == nil {
		t.Fatal("a revoke that was not written answered done")
	}
	if d.ByToken(phoneToken) == nil {
		t.Fatal("the phone went from memory although it is still on disk")
	}
	on := true
	if err := d.SetMedia("ana", id, &on, nil); err == nil || d.List("ana")[0].Media != 0 {
		t.Fatal("a media switch that was not written stays on")
	}
	d.mu.Lock()
	d.path = good
	d.mu.Unlock()
	if err := d.Revoke("ana", id); err != nil || d.ByToken(phoneToken) != nil {
		t.Fatalf("revoke = %v", err)
	}
}

// D4: a note for an app phone is "sent" only once it is on disk - a restart
// keeps it; one that could not be written is a 503 and nothing is kept.
// D5: a full queue never drops an SOS note.
func TestGoReviewAppNotesSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	d := NewDevices(dir, dir, quietLog())
	id, err := d.Enrol("ana", phoneToken, "Pixel", "", appNotesMin)
	if err != nil {
		t.Fatalf("enrol: %v", err)
	}
	if st := d.queueNote(id, []byte(`{"title":"SOS","sos":true,"tag":"sos-1"}`), 3600); st != http.StatusCreated {
		t.Fatalf("queue = %d", st)
	}
	for i := 0; i < appNotesMax+5; i++ {
		d.queueNote(id, []byte(`{"title":"chat `+itoa(i)+`"}`), 3600)
	}
	ns := d.notesFor(id)
	if len(ns) != appNotesMax || !ns[0].Sos {
		t.Fatalf("full queue = %d notes, first %+v; want %d with the SOS kept", len(ns), ns[0], appNotesMax)
	}

	again := NewDevices(dir, dir, quietLog()) // a restart
	if got := again.notesFor(id); len(got) != appNotesMax || !got[0].Sos || got[0].ID != ns[0].ID {
		t.Fatalf("after a restart: %d notes", len(got))
	}
	again.ackNotes(id, ns[len(ns)-1].ID)
	if got := NewDevices(dir, dir, quietLog()).notesFor(id); len(got) != 0 {
		t.Fatalf("acked notes came back after a restart: %d", len(got))
	}

	blocker := filepath.Join(dir, "not-a-folder")
	os.WriteFile(blocker, []byte("x"), 0o644)
	again.mu.Lock()
	again.path = filepath.Join(blocker, "devices.json") // device-notes.json beside it: unwritable
	again.mu.Unlock()
	if st := again.queueNote(id, []byte(`{"title":"lost?"}`), 3600); st != http.StatusServiceUnavailable {
		t.Fatalf("an unwritten note = %d, want 503", st)
	}
	if len(again.notesFor(id)) != 0 {
		t.Fatal("an unwritten note stays queued")
	}
}
