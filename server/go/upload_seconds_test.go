package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestPutSecondsAlwaysGrow: two saves of one file inside the same second must
// carry different Last-Modified times, or a third save based on the first
// would pass If-Unmodified-Since and undo the second (apps-2 #51 merge).
func TestPutSecondsAlwaysGrow(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	url := ts.URL + "/api/files?file=files/lista.json"
	path := filepath.Join(srv.cfg.HomesDir, "ana", "files", "lista.json")

	put := func(body, since string) *http.Response {
		t.Helper()
		h := map[string]string{}
		if since != "" {
			h["If-Unmodified-Since"] = since
		}
		resp := do(t, client, "PUT", url, strings.NewReader(body), h)
		resp.Body.Close()
		return resp
	}

	r1 := put(`["a"]`, "")
	lm1 := r1.Header.Get("Last-Modified")
	r2 := put(`["a","b"]`, lm1) // the second device, from the same second
	lm2 := r2.Header.Get("Last-Modified")
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("second PUT = %d", r2.StatusCode)
	}
	if lm1 == lm2 {
		t.Fatalf("two saves share Last-Modified %q", lm1)
	}
	if r3 := put(`["a","c"]`, lm1); r3.StatusCode != http.StatusPreconditionFailed {
		t.Errorf("a save based on the first = %d, want 412", r3.StatusCode)
	}
	if b, _ := os.ReadFile(path); string(b) != `["a","b"]` {
		t.Errorf("file = %s, want the second save", b)
	}

	// A quiet save later is back on the clock (not pushed ever further ahead).
	past := time.Now().Add(-time.Hour)
	os.Chtimes(path, past, past)
	put(`["x"]`, "")
	if info, _ := os.Stat(path); time.Since(info.ModTime()) > 5*time.Second || info.ModTime().After(time.Now().Add(2*time.Second)) {
		t.Errorf("a quiet save's time = %v, want now", info.ModTime())
	}
}
