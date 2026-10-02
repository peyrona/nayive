package main

// Data-safety seal (cleanup Phase 3, batch S1): a bin index that cannot be
// read or parsed is never taken as "empty" and written back (F2).

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// dsBin bins the named files of ana's and answers the can's folder.
func dsBin(t *testing.T, srv *Server, client *http.Client, base string, names ...string) string {
	t.Helper()
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	for _, n := range names {
		os.WriteFile(filepath.Join(files, n), []byte(n), 0o644)
		jsonCall(t, client, "DELETE", base+"/api/files?paths=files/"+n, "", 200, nil)
	}
	return filepath.Join(srv.cfg.HomesDir, "ana", ".trash")
}

// TestDS_F2_UnreadableIndexRefused: with index.json unreadable (EIO, EMFILE on
// a busy server - here a 000 file), deleting answers an error and the file
// stays put; once readable again, every earlier item is still listed.
func TestDS_F2_UnreadableIndexRefused(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a 000 file")
	}
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	can := dsBin(t, srv, client, ts.URL, "a.txt", "b.txt", "c.txt")
	idx := filepath.Join(can, "index.json")
	before, _ := os.ReadFile(idx)

	d := filepath.Join(srv.cfg.HomesDir, "ana", "files", "d.txt")
	os.WriteFile(d, []byte("d"), 0o644)
	os.Chmod(idx, 0o000)
	code, body := callJSON(t, client, "DELETE", ts.URL+"/api/files?paths=files/d.txt", "")
	os.Chmod(idx, 0o644)
	if code == http.StatusOK {
		t.Errorf("a delete with an unreadable bin index answered 200 %s", body)
	}
	if !pathExists(d) {
		t.Error("d.txt left its folder although the bin could not take it")
	}
	if after, _ := os.ReadFile(idx); string(after) != string(before) {
		t.Errorf("index.json changed:\n%s", after)
	}
	var l struct{ Items []TrashItem }
	jsonCall(t, client, "GET", ts.URL+"/api/files?trash=list", "", 200, &l)
	if len(l.Items) != 3 {
		t.Errorf("bin list = %d items, want the 3 binned before", len(l.Items))
	}
}

// TestDS_F2_CorruptIndexKept: an index.json that does not parse (a cut file)
// is kept as it is: delete, list, restore, purge and empty are refused, and
// the daily sweep takes nothing from that can - not even its "orphans", which
// is what every listed item looks like with the index unread.
func TestDS_F2_CorruptIndexKept(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	can := dsBin(t, srv, client, ts.URL, "a.txt", "b.txt")
	// One more item binned 40 days ago (its id is its bin time).
	old := strconv.FormatInt(time.Now().AddDate(0, 0, -40).Unix(), 10) + "-deadbeef"
	os.WriteFile(filepath.Join(can, old), []byte("old"), 0o644)
	idx := filepath.Join(can, "index.json")
	raw, _ := os.ReadFile(idx)
	raw = []byte(strings.Replace(string(raw), "}", `},"`+old+`":{"orig":"files/old.txt","name":"old.txt","deleted":1,"dir":false,"size":3}`, 1))
	cut := raw[:len(raw)-3]
	os.WriteFile(idx, cut, 0o644)
	entries, _ := os.ReadDir(can)

	c := filepath.Join(srv.cfg.HomesDir, "ana", "files", "c.txt")
	os.WriteFile(c, []byte("c"), 0o644)
	for _, call := range []struct{ method, url string }{
		{"DELETE", "/api/files?paths=files/c.txt"},
		{"GET", "/api/files?trash=list"},
		{"POST", "/api/files?trash=restore&ids=" + old},
		{"DELETE", "/api/files?trash=purge&ids=" + old},
		{"POST", "/api/files?trash=empty"},
	} {
		if code, body := callJSON(t, client, call.method, ts.URL+call.url, ""); code == http.StatusOK {
			t.Errorf("%s %s with a cut index = 200 %s", call.method, call.url, body)
		}
	}
	srv.trash.SweepExpired(30)

	if after, _ := os.ReadFile(idx); string(after) != string(cut) {
		t.Errorf("index.json changed:\n%s", after)
	}
	if now, _ := os.ReadDir(can); len(now) != len(entries) {
		t.Errorf("the can held %d entries, now %d", len(entries), len(now))
	}
	if !pathExists(c) {
		t.Error("c.txt left its folder although the bin could not take it")
	}
}
