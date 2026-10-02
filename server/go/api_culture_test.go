package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// cuFake swaps the internet for a function; it counts the calls.
func cuFake(t *testing.T, f func(u string) (string, []byte, error)) *int32 {
	t.Helper()
	var n int32
	bmSetFor(t, &cuFetch, func(_ context.Context, u string) (string, []byte, error) {
		atomic.AddInt32(&n, 1)
		return f(u)
	})
	return &n
}

func cuURL(base, u string, ttl int) string {
	return base + "/api/culture/fetch?u=" + url.QueryEscape(u) + "&ttl=" + strconv.Itoa(ttl)
}

// Only https to the listed Wikimedia hosts, and only with a session.
func TestCultureRefuses(t *testing.T) {
	_, ts, client := newTestServer(t)
	hits := cuFake(t, func(string) (string, []byte, error) { return "json", []byte(`{}`), nil })

	if code, _ := bmGet(t, client, cuURL(ts.URL, "https://es.wikipedia.org/x", 600)); code != http.StatusUnauthorized {
		t.Fatalf("no session: %d, want 401", code)
	}
	signIn(t, client, ts.URL, "ana", "abc")
	for _, u := range []string{
		"http://es.wikipedia.org/x",           // not https
		"https://example.com/x",               // not listed
		"https://es.wikipedia.org.evil.com/x", // look-alike
		"https://it.wikipedia.org/x",          // a language Nayive does not speak
		"https://es.wikipedia.org:8443/x",     // a port
		"https://u:p@es.wikipedia.org/x",      // a user
		"https://nasa.gov/x",                  // only the exact name (www.nasa.gov)
		"file:///etc/passwd",
		"",
	} {
		if code, _ := bmGet(t, client, cuURL(ts.URL, u, 600)); code != http.StatusBadRequest {
			t.Errorf("%q: %d, want 400", u, code)
		}
	}
	if *hits != 0 {
		t.Fatalf("%d fetches for refused addresses", *hits)
	}
	for _, u := range []string{
		"https://query.wikidata.org/sparql?query=x",
		"https://theconversation.com/es/ciencia/articles.atom", // Science's news
		"https://www.nasa.gov/feeds/iotd-feed/",
		"https://www.eso.org/public/images/potw/feed/", // Science's pictures
		"https://esahubble.org/news/feed/",
		"https://esawebb.org/images/potm/feed/",
	} {
		if code, _ := bmGet(t, client, cuURL(ts.URL, u, 600)); code != http.StatusOK {
			t.Fatalf("%s: %d, want 200", u, code)
		}
	}
}

// A kept copy is served until its ttl runs out; then it is fetched again.
func TestCultureCache(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	body := `{"n":1}`
	hits := cuFake(t, func(string) (string, []byte, error) { return "json", []byte(body), nil })
	u := "https://en.wiktionary.org/w/api.php?action=parse&page=A"

	for i := 0; i < 3; i++ {
		resp := do(t, client, "GET", cuURL(ts.URL, u, 3600), nil, nil)
		b := readBody(t, resp)
		if resp.StatusCode != 200 || string(b) != `{"n":1}` {
			t.Fatalf("got %d %s", resp.StatusCode, b)
		}
		if ct := resp.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Fatalf("content type %q", ct)
		}
		if resp.Header.Get("Content-Security-Policy") == "" {
			t.Fatal("no CSP")
		}
	}
	if *hits != 1 {
		t.Fatalf("%d fetches, want 1", *hits)
	}

	// Age the copy past its ttl: fetched again.
	entries, _ := os.ReadDir(srv.cuDir())
	if len(entries) != 1 {
		t.Fatalf("%d files in the cache", len(entries))
	}
	old := time.Now().Add(-2 * time.Hour)
	os.Chtimes(srv.cuDir()+"/"+entries[0].Name(), old, old)
	body = `{"n":2}`
	if _, b := bmGet(t, client, cuURL(ts.URL, u, 3600)); string(b) != `{"n":2}` || *hits != 2 {
		t.Fatalf("after the ttl: %s, %d fetches", b, *hits)
	}
}

// A failed fetch serves the last copy, marked stale; with no copy, 502.
func TestCultureStale(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	fail := false
	cuFake(t, func(string) (string, []byte, error) {
		if fail {
			return "", nil, errors.New("status 429")
		}
		return "text", []byte("<rss>hola</rss>"), nil
	})
	u := "https://pt.wiktionary.org/w/index.php?title=X"
	bmGet(t, client, cuURL(ts.URL, u, 600))

	fail = true
	entries, _ := os.ReadDir(srv.cuDir())
	old := time.Now().Add(-time.Hour)
	os.Chtimes(srv.cuDir()+"/"+entries[0].Name(), old, old)
	resp := do(t, client, "GET", cuURL(ts.URL, u, 600), nil, nil)
	b := readBody(t, resp)
	if resp.StatusCode != 200 || string(b) != "<rss>hola</rss>" || resp.Header.Get("X-Nayive-Stale") != "1" {
		t.Fatalf("stale: %d %q stale=%q", resp.StatusCode, b, resp.Header.Get("X-Nayive-Stale"))
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Fatalf("a non-JSON answer must go back as plain text, got %q", ct)
	}
	if code, _ := bmGet(t, client, cuURL(ts.URL, u+"&never", 600)); code != http.StatusBadGateway {
		t.Fatalf("no copy: %d, want 502", code)
	}
}

// Ten desktops asking at once cause one fetch.
func TestCultureShared(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	gate := make(chan struct{})
	hits := cuFake(t, func(string) (string, []byte, error) { <-gate; return "json", []byte(`[]`), nil })
	u := "https://de.wikiquote.org/w/api.php?x=1"

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); bmGet(t, client, cuURL(ts.URL, u, 600)) }()
	}
	time.Sleep(200 * time.Millisecond)
	close(gate)
	wg.Wait()
	if *hits != 1 {
		t.Fatalf("%d fetches, want 1", *hits)
	}
}

// A redirect off the list is not followed.
func TestCultureRedirect(t *testing.T) {
	req, _ := http.NewRequest("GET", "https://evil.example/", nil)
	if err := cuClient.CheckRedirect(req, nil); err == nil {
		t.Fatal("a redirect to another host was allowed")
	}
	req, _ = http.NewRequest("GET", "https://en.wikipedia.org/wiki/B", nil)
	if err := cuClient.CheckRedirect(req, nil); err != nil {
		t.Fatalf("a redirect inside the list was refused: %v", err)
	}
}
