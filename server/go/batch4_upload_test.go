package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestPutIfUnmodifiedSinceInFlight (S2-#8): two saves from the same base, the
// first still streaming its body when the second lands. Both pass the early
// check; the one that finishes LAST must get 412, not silently win.
func TestPutIfUnmodifiedSinceInFlight(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	path := filepath.Join(srv.cfg.HomesDir, "ana", "files", "carta.txt")
	os.WriteFile(path, []byte("base"), 0o644)
	opened := time.Now().Add(-time.Hour).Truncate(time.Second)
	os.Chtimes(path, opened, opened)
	since := opened.UTC().Format(http.TimeFormat)
	url := ts.URL + "/api/files?file=files/carta.txt"

	// Save A: its body arrives in two halves, with save B in between.
	pr, pw := io.Pipe()
	req, _ := http.NewRequest("PUT", url, pr)
	req.ContentLength = int64(len("from A"))
	req.Header.Set("If-Unmodified-Since", since)
	answered := make(chan int, 1)
	go func() {
		resp, err := client.Do(req)
		if err != nil {
			answered <- 0
			return
		}
		resp.Body.Close()
		answered <- resp.StatusCode
	}()
	pw.Write([]byte("from"))
	time.Sleep(100 * time.Millisecond) // A is past its early check, streaming

	resp := do(t, client, "PUT", url, strings.NewReader("from B"),
		map[string]string{"If-Unmodified-Since": since})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save B = %d, want 200", resp.StatusCode)
	}

	pw.Write([]byte(" A"))
	pw.Close()
	select {
	case code := <-answered:
		if code != http.StatusPreconditionFailed {
			t.Errorf("save A (finished last, same base) = %d, want 412", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("save A never answered")
	}
	if raw, _ := os.ReadFile(path); string(raw) != "from B" {
		t.Errorf("the file holds %q, want B's save", raw)
	}
}
