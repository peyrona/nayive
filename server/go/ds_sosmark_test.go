package main

// Data-safety seal: sosMark (sos.go) takes back a mark it could not save.
//
// The mark ("already asked", "already alerted on") is what stops a second
// ask or alert. Kept in memory after a failed save, it stopped the FIRST one
// too: the tick skipped the alert, and every later tick saw it done. Taken
// back, the next tick tries again - and the alert goes out once the disk
// takes the mark.

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDS_Sos_MarkRollsBackOnFailedSave(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}, Idle: 2})
	now := time.Now()
	srv.sos.started = now.Add(-time.Hour)
	srv.sos.mu.Lock()
	srv.sos.rowLocked("ana", false).Alive = now.Add(-3 * time.Hour).Unix()
	good := srv.sos.path
	// A file where the folder should be: every save fails.
	blocker := filepath.Join(t.TempDir(), "not-a-folder")
	os.WriteFile(blocker, []byte("x"), 0o644)
	srv.sos.path = filepath.Join(blocker, "sos.json")
	srv.sos.mu.Unlock()

	srv.sosCheck(now)
	if u := srv.sos.Get("ana"); u.Asked != 0 {
		t.Fatalf("a mark that was not saved stayed in memory: asked %d", u.Asked)
	}

	srv.sos.mu.Lock()
	srv.sos.path = good
	srv.sos.mu.Unlock()
	srv.sosCheck(now.Add(time.Minute))
	if u := srv.sos.Get("ana"); u.Asked == 0 {
		t.Fatal("no ask once the disk took it again")
	}
	srv.sos.mu.Lock()
	var disk sosFile
	ok, _ := loadTable(good, &disk, quietLog(), "")
	srv.sos.mu.Unlock()
	if !ok || len(disk.Users) != 1 || disk.Users[0].Asked == 0 {
		t.Fatalf("the ask is not on disk: %+v", disk.Users)
	}
}
