package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestFileNameWithPercentRoundTrips (S2-#5): "?file=" is decoded once, by the
// query parser. A name holding "%20" (a chat keep, an office twin, an SFTP
// upload) is reachable, and an upload named "a%2Fb.txt" stays one file in
// files/ instead of landing in a folder a/.
func TestFileNameWithPercentRoundTrips(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	for _, name := range []string{"a%20b.txt", "a%2Fb.txt"} {
		// What the client sends: encodeURIComponent once, so "%" -> "%25".
		url := ts.URL + "/api/files?file=files/" + strings.ReplaceAll(name, "%", "%25")
		resp := do(t, client, "PUT", url, strings.NewReader("hola"), nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("PUT %s = %d, want 200", name, resp.StatusCode)
		}
		if raw, err := os.ReadFile(filepath.Join(files, name)); err != nil || string(raw) != "hola" {
			t.Errorf("%s is not on disk under its own name: %q %v", name, raw, err)
		}
		resp = do(t, client, "GET", url, nil, nil)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || string(body) != "hola" {
			t.Errorf("GET %s = %d %q, want 200 \"hola\"", name, resp.StatusCode, body)
		}
	}
	if _, err := os.Stat(filepath.Join(files, "a")); !os.IsNotExist(err) {
		t.Errorf("a%%2Fb.txt made a folder a/ (err %v)", err)
	}
}
