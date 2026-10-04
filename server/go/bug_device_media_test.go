package main

// =============================================================================
// Bugs audit 2, AN5: a photo edited on the phone after it was queued comes
// again under a new id ("<_ID>-<DATE_ADDED>-<rev>"); the old id's part must not
// stay on the server counting against the quota for a week.
// =============================================================================

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBug_AN5_ChangedFileDropsOldPart(t *testing.T) {
	shortHold(t)
	srv, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	id := enrolPhone(t, client, base)
	jsonCall(t, client, "PUT", base+"/api/device/"+id, `{"media":true}`, 200, nil)
	m := mediaPhone{t, base}
	parts := filepath.Join(srv.cfg.HomesDir, "ana", "data", mediaPartDir)
	now := time.Now()
	data := bytes.Repeat([]byte("0123456789"), 1000)

	// Half of row 500 went up; so did half of another row, 501.
	startPut := func(phoneID string, size int64, n int) string {
		t.Helper()
		code, st := m.start(phoneID, "IMG.jpg", size, now)
		if code != http.StatusOK {
			t.Fatalf("start %s = %d %v", phoneID, code, st)
		}
		up := st["upload"].(string)
		if code, out := m.put(up, 0, data[:n]); code != http.StatusOK {
			t.Fatalf("put %s = %d %v", phoneID, code, out)
		}
		return up
	}
	old := startPut("500-1700000000", int64(len(data)), 4000)
	other := startPut("501-1700000001", int64(len(data)), 3000)
	before := srv.users.UserUsageBytes("ana")

	// Row 500 was edited: it comes again with its rev, a new size.
	fresh := startPut("500-1700000000-1700000500", int64(len(data))+5, 1000)
	if fresh == old {
		t.Fatal("the edited file got the old upload id")
	}
	for _, f := range []string{old + ".part", old + ".json"} {
		if _, err := os.Stat(filepath.Join(parts, f)); !os.IsNotExist(err) {
			t.Errorf("old part %s still there (err %v)", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(parts, other+".part")); err != nil {
		t.Errorf("another row's part went: %v", err)
	}
	if got, want := srv.users.UserUsageBytes("ana"), before-4000+1000; got != want {
		t.Errorf("usage = %d, want %d (old part's bytes given back)", got, want)
	}
}

func TestBug_AN5_MediaRowOf(t *testing.T) {
	for in, want := range map[string]string{
		"500-1700000000": "500-1700000000", "500-1700000000-1700000500": "500-1700000000",
		"img-1": "", "1": "", "5-6-7-8": "", "5--6": "", "-5-6": "", "a5-6": "",
	} {
		if got := mediaRowOf(in); got != want {
			t.Errorf("mediaRowOf(%q) = %q, want %q", in, got, want)
		}
	}
}
