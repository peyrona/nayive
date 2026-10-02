package main

// Data-safety seal (cleanup Phase 3, batch S8): a purge (an app's real
// delete of its thumbnails, DELETE ?purge=1) that could not delete is never
// answered "purged" - the app would count the thumbnail gone and its space
// freed, and never try again.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// TestDS_L2_PurgeFailureReported: the thumbnail's folder refuses the delete
// (EACCES: a folder made read-only): 500, the path named in "failed", the
// file still there. The one beside it in a writable folder goes, counted.
func TestDS_L2_PurgeFailureReported(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root deletes from a read-only folder anyway")
	}
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	home := filepath.Join(srv.cfg.HomesDir, "ana")
	stuck := filepath.Join(home, "data", "photos", "thumbs", "ro", "10_20.jpg")
	free := filepath.Join(home, "data", "photos", "thumbs", "30_40.jpg")
	os.MkdirAll(filepath.Dir(stuck), 0o755)
	os.WriteFile(stuck, []byte("jpg"), 0o644)
	os.WriteFile(free, []byte("jpg"), 0o644)
	os.Chmod(filepath.Dir(stuck), 0o555)
	t.Cleanup(func() { os.Chmod(filepath.Dir(stuck), 0o755) }) // TempDir must remove it

	resp := do(t, client, "DELETE", ts.URL+"/api/files?paths=data/photos/thumbs/ro/10_20.jpg"+
		"&paths=data/photos/thumbs/30_40.jpg&purge=1", nil, nil)
	raw := readBody(t, resp)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("a purge that could not delete = %d %s, want 500", resp.StatusCode, raw)
	}
	var out struct {
		Count  int      `json:"count"`
		Failed []string `json:"failed"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("bad JSON: %s", raw)
	}
	if len(out.Failed) != 1 || out.Failed[0] != "data/photos/thumbs/ro/10_20.jpg" || out.Count != 1 {
		t.Errorf("the answer = %s, want the stuck one failed and the other counted", raw)
	}
	if _, err := os.Stat(stuck); err != nil {
		t.Errorf("the thumbnail that could not be deleted is gone: %v", err)
	}
	if _, err := os.Stat(free); err == nil {
		t.Errorf("the deletable thumbnail is still there")
	}
}
