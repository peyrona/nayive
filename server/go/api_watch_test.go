package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// watchOnce asks /api/watch and answers the status and the tag.
func watchOnce(t *testing.T, ctx context.Context, client *http.Client, url string) (int, string, error) {
	t.Helper()
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	var got struct {
		Etag string `json:"etag"`
	}
	json.NewDecoder(resp.Body).Decode(&got)
	return resp.StatusCode, got.Etag, nil
}

// TestWatchFile: no tag answers at once; the current tag holds; a save
// releases the hold with the new tag; a page that goes away frees its slot.
func TestWatchFile(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	base := ts.URL + "/api/watch?file=data/calendar.ics"
	bg := context.Background()

	// No file yet: "-", at once.
	code, tag, err := watchOnce(t, bg, client, base)
	if err != nil || code != http.StatusOK || tag != "-" {
		t.Fatalf("first watch = %d %q %v, want 200 \"-\"", code, tag, err)
	}

	// A wait on "-" is released by the save, with the file's new tag.
	type answer struct {
		code int
		tag  string
		err  error
		took time.Duration
	}
	done := make(chan answer, 1)
	go func() {
		start := time.Now()
		c, g, e := watchOnce(t, bg, client, base+"&etag=-")
		done <- answer{c, g, e, time.Since(start)}
	}()
	time.Sleep(300 * time.Millisecond)
	select {
	case a := <-done:
		t.Fatalf("the wait answered before any change: %+v", a)
	default:
	}
	resp := do(t, client, "PUT", ts.URL+"/api/files?file=data/calendar.ics",
		strings.NewReader("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"), map[string]string{"Content-Type": "text/calendar"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT = %d", resp.StatusCode)
	}
	saved := resp.Header.Get("ETag")
	a := <-done
	if a.err != nil || a.code != http.StatusOK || a.tag == "-" || a.tag == "" {
		t.Fatalf("released wait = %+v, want 200 with a tag", a)
	}
	if saved != "" && a.tag != saved {
		t.Errorf("wait tag %q, PUT ETag %q: want the same", a.tag, saved)
	}
	if a.took > 3*time.Second {
		t.Errorf("the wait took %v to see the save", a.took)
	}

	// The current tag holds; the page going away ends the wait and frees its slot.
	req, _ := http.NewRequest("GET", ts.URL, nil)
	for _, c := range client.Jar.Cookies(req.URL) {
		req.AddCookie(c)
	}
	key := "watch:" + tokenKey(tokenFrom(req))
	ctx, cancel := context.WithTimeout(bg, 1500*time.Millisecond)
	defer cancel()
	if _, _, err := watchOnce(t, ctx, client, base+"&etag="+a.tag); err == nil {
		t.Fatalf("a wait on the current tag answered within 1.5 s")
	}
	for i := 0; watchWaits.count(key) != 0; i++ {
		if i > 50 {
			t.Fatalf("the gone page still holds %d wait(s)", watchWaits.count(key))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestWatchGates: the same gates as reading the file.
func TestWatchGates(t *testing.T) {
	_, ts, client := newTestServer(t)
	bg := context.Background()

	if code, _, _ := watchOnce(t, bg, client, ts.URL+"/api/watch?file=data/calendar.ics"); code != http.StatusUnauthorized {
		t.Errorf("signed out = %d, want 401", code)
	}
	signIn(t, client, ts.URL, "jefe", "secreto")
	if code, _, _ := watchOnce(t, bg, client, ts.URL+"/api/watch?file=config/server.json"); code != http.StatusForbidden {
		t.Errorf("config/ = %d, want 403", code)
	}
	if code, _, _ := watchOnce(t, bg, client, ts.URL+"/api/watch"); code != http.StatusBadRequest {
		t.Errorf("no file = %d, want 400", code)
	}
	if code, _, _ := watchOnce(t, bg, client, ts.URL+"/api/watch?file=../x"); code != http.StatusForbidden {
		t.Errorf("../x = %d, want 403", code)
	}
}
