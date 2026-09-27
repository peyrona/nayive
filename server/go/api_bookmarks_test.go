package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var bmPNG = []byte("\x89PNG\r\n\x1a\n0000IHDR-a-tiny-fake-png")

// bmSite is a fake web site on 127.0.0.1 that counts what it is asked for.
// The guarded dialer is opened to loopback and any port while it runs.
func bmSite(t *testing.T, h http.HandlerFunc) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		h(w, r)
	}))
	t.Cleanup(site.Close)

	oldLocal, oldPort := bmAllowLocal, bmAllowPort
	bmAllowLocal, bmAllowPort = true, func(string) bool { return true }
	t.Cleanup(func() { bmAllowLocal, bmAllowPort = oldLocal, oldPort })
	return site, &hits
}

func bmGet(t *testing.T, client *http.Client, u string) (int, []byte) {
	t.Helper()
	resp := do(t, client, "GET", u, nil, nil)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// bmGetHead is bmGet for the answer's headers.
func bmGetHead(t *testing.T, client *http.Client, u string) (int, http.Header) {
	t.Helper()
	resp := do(t, client, "GET", u, nil, nil)
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, resp.Header
}

// bmHoldSlots takes every outbound slot, as six slow lookups elsewhere would;
// the returned func gives them back (and the test's end does, if it did not).
func bmHoldSlots(t *testing.T) func() {
	t.Helper()
	for i := 0; i < bmParallel; i++ {
		bmSlots <- struct{}{}
	}
	var once sync.Once
	free := func() {
		once.Do(func() {
			for i := 0; i < bmParallel; i++ {
				<-bmSlots
			}
		})
	}
	t.Cleanup(free)
	return free
}

// bmSetFor sets a package variable for one test.
func bmSetFor[T any](t *testing.T, v *T, to T) {
	old := *v
	*v = to
	t.Cleanup(func() { *v = old })
}

// TestBookmarksNeedSession: nobody signed in gets nothing fetched.
func TestBookmarksNeedSession(t *testing.T) {
	_, ts, client := newTestServer(t)
	code, _ := bmGet(t, client, ts.URL+"/api/bookmarks/title?url=https://example.com/")
	if code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", code)
	}
}

// TestBookmarkPublicIP: only the public internet is dialled.
func TestBookmarkPublicIP(t *testing.T) {
	for ip, want := range map[string]bool{
		"8.8.8.8": true, "2606:4700::1111": true, "93.184.216.34": true,
		"127.0.0.1": false, "10.1.2.3": false, "192.168.1.1": false, "172.16.0.9": false,
		"169.254.169.254": false, "100.64.0.1": false, "0.0.0.0": false, "::1": false,
		"fe80::1": false, "fd00::1": false, "224.0.0.1": false, "::ffff:127.0.0.1": false,
		"::ffff:192.168.0.1": false,
	} {
		if got := bmPublicIP(net.ParseIP(ip)); got != want {
			t.Errorf("%s: public = %v, want %v", ip, got, want)
		}
	}
}

// TestBookmarkRefusesLAN: a URL on this machine is never fetched, and nor is
// a redirect that leads into the private network.
func TestBookmarkRefusesLAN(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	var hits int32
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Write([]byte("<title>secret</title>"))
	}))
	defer site.Close()

	code, _ := bmGet(t, client, ts.URL+"/api/bookmarks/title?url="+url.QueryEscape(site.URL+"/"))
	if code != http.StatusBadGateway || hits != 0 {
		t.Fatalf("loopback: code %d, hits %d - want 502 and no request", code, hits)
	}

	// Loopback opened for the test site; a redirect from it into 10.x still fails.
	redir, _ := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://10.0.0.1/", http.StatusFound)
	})
	code, _ = bmGet(t, client, ts.URL+"/api/bookmarks/title?url="+url.QueryEscape(redir.URL+"/"))
	if code != http.StatusBadGateway {
		t.Fatalf("redirect into 10/8: want 502, got %d", code)
	}

	for _, bad := range []string{"file:///etc/passwd", "javascript:alert(1)", "ftp://x/", "nohost"} {
		code, _ = bmGet(t, client, ts.URL+"/api/bookmarks/title?url="+url.QueryEscape(bad))
		if code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", bad, code)
		}
	}
}

// TestBookmarkTitle: the page's <title>, from its own charset, entities
// resolved and white space collapsed.
func TestBookmarkTitle(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	site, _ := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latin":
			w.Header().Set("Content-Type", "text/html; charset=windows-1252")
			w.Write([]byte("<html><head><TITLE>\n  Caf\xe9 &amp; ma\xf1ana\n</TITLE></head></html>"))
		case "/meta":
			w.Write([]byte(`<meta charset="iso-8859-1"><title>Espa` + "\xf1" + `a</title>`))
		case "/utf8":
			w.Write([]byte("<title lang=es>Añadir &#8211; página</title>"))
		default:
			w.Write([]byte("<p>no title here</p>"))
		}
	})

	for path, want := range map[string]string{
		"/latin": "Café & mañana", "/meta": "España", "/utf8": "Añadir – página", "/none": "",
	} {
		code, body := bmGet(t, client, ts.URL+"/api/bookmarks/title?url="+url.QueryEscape(site.URL+path))
		var got struct{ Title string }
		json.Unmarshal(body, &got)
		if code != http.StatusOK || got.Title != want {
			t.Errorf("%s: %d %q, want %q", path, code, got.Title, want)
		}
	}
}

// TestBookmarkIcon: the page's own <link rel="icon"> is used, the answer is
// kept, and a second ask never leaves the server. A site with no icon gets a
// 204 and leaves a marker, so it is not asked again either.
func TestBookmarkIcon(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	site, hits := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Write([]byte(`<head><link rel="icon" type="image/svg+xml" href="/i.svg">` +
				`<link rel="shortcut icon" sizes="32x32" href="img/i.png?v=2"></head>`))
		case "/img/i.png":
			w.Write(bmPNG)
		default:
			http.NotFound(w, r)
		}
	})
	host := strings.TrimPrefix(site.URL, "http://")

	code, body := bmGet(t, client, ts.URL+"/api/bookmarks/icon?host="+host)
	if code != http.StatusOK || string(body) != string(bmPNG) {
		t.Fatalf("first ask: %d %q", code, body)
	}
	first := atomic.LoadInt32(hits)
	if first != 2 { // the home page, then the PNG
		t.Fatalf("first ask made %d requests, want 2", first)
	}
	kept := filepath.Join(srv.bmIconDir(), strings.ReplaceAll(host, ":", "_")+".img")
	if _, err := os.Stat(kept); err != nil {
		t.Fatalf("icon not kept: %v", err)
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana", "data", "bookmarks", "icons")); err == nil {
		t.Fatalf("an icon folder was made in the user's home")
	}
	code, _ = bmGet(t, client, ts.URL+"/api/bookmarks/icon?host="+host)
	if code != http.StatusOK || atomic.LoadInt32(hits) != first {
		t.Fatalf("second ask: %d, requests %d -> %d", code, first, atomic.LoadInt32(hits))
	}

	// A site that answers with an HTML page for everything: no icon.
	dead, deadHits := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<html>not an icon</html>"))
	})
	dhost := strings.TrimPrefix(dead.URL, "http://")
	code, hdr := bmGetHead(t, client, ts.URL+"/api/bookmarks/icon?host="+dhost)
	if code != http.StatusNoContent || hdr.Get("Cache-Control") != "private, max-age=3600" {
		t.Fatalf("dead site: want 204 kept an hour, got %d %q", code, hdr.Get("Cache-Control"))
	}
	if _, err := os.Stat(filepath.Join(srv.bmIconDir(), strings.ReplaceAll(dhost, ":", "_")+".none")); err != nil {
		t.Fatalf("no .none marker: %v", err)
	}
	n := atomic.LoadInt32(deadHits)
	code, _ = bmGet(t, client, ts.URL+"/api/bookmarks/icon?host="+dhost)
	if code != http.StatusNoContent || atomic.LoadInt32(deadHits) != n {
		t.Fatalf("dead site asked again: %d requests -> %d", n, atomic.LoadInt32(deadHits))
	}

	for _, bad := range []string{"", "../x", "a/b", "ex ample.com", "a..b"} {
		code, _ = bmGet(t, client, ts.URL+"/api/bookmarks/icon?host="+url.QueryEscape(bad))
		if code != http.StatusBadRequest {
			t.Errorf("host %q: want 400, got %d", bad, code)
		}
	}
}

// TestPickIconLink: a raster icon of about 32-64 px wins; an SVG never does.
func TestPickIconLink(t *testing.T) {
	cases := map[string]string{
		`<link rel="icon" href="/a.svg"><link rel="icon" href="/b.ico">`:                                  "/b.ico",
		`<link rel="apple-touch-icon" href="/t.png"><link rel="icon" sizes="16x16" href="/s.png">`:        "/s.png",
		`<link rel="icon" sizes="16x16" href="/s.png"><LINK REL='Shortcut Icon' sizes=48x48 href=/m.png>`: "/m.png",
		`<link rel="stylesheet" href="/x.css">`:                                                           "",
		`<link rel="icon" href="data:image/png;base64,AAAA">`:                                             "",
		`<link rel="icon" type="image/svg+xml" href="/v">`:                                                "",
	}
	for page, want := range cases {
		if got := pickIconLink([]byte(page)); got != want {
			t.Errorf("%s -> %q, want %q", page, got, want)
		}
	}
}

// TestBookmarkTitleBusy: with every slot taken, a title gives up quickly with
// a 503 and asks nobody.
func TestBookmarkTitleBusy(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	site, hits := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<title>x</title>"))
	})

	bmHoldSlots(t)
	bmSetFor(t, &bmTitleWait, 150*time.Millisecond)
	start := time.Now()
	code, _ := bmGet(t, client, ts.URL+"/api/bookmarks/title?url="+url.QueryEscape(site.URL+"/"))
	if code != http.StatusServiceUnavailable || atomic.LoadInt32(hits) != 0 || time.Since(start) > 3*time.Second {
		t.Fatalf("busy: %d after %v, %d requests - want a quick 503 and no request",
			code, time.Since(start), atomic.LoadInt32(hits))
	}
}

// TestBookmarkIconSlotWait: a lookup that gets no slot in time learns nothing
// and writes nothing; and its own clock starts only once it has a slot.
func TestBookmarkIconSlotWait(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	site, hits := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/favicon.ico" {
			w.Write(bmPNG)
			return
		}
		w.Write([]byte("<html><head></head></html>"))
	})
	host := strings.TrimPrefix(site.URL, "http://")
	base := filepath.Join(srv.bmIconDir(), strings.ReplaceAll(host, ":", "_"))

	free := bmHoldSlots(t)
	bmSetFor(t, &bmSlotWait, 150*time.Millisecond)
	code, hdr := bmGetHead(t, client, ts.URL+"/api/bookmarks/icon?host="+host)
	if code != http.StatusNoContent || hdr.Get("Cache-Control") != "no-store" || atomic.LoadInt32(hits) != 0 {
		t.Fatalf("no slot: %d %q, %d requests - want a 204 the browser does not keep, no request",
			code, hdr.Get("Cache-Control"), atomic.LoadInt32(hits))
	}
	for _, ext := range []string{".none", ".err", ".img"} {
		if _, err := os.Stat(base + ext); err == nil {
			t.Fatalf("no slot, yet %s was written", ext)
		}
	}

	// Slots busy for longer than a whole lookup may take, freed in time: the
	// lookup still gets its full budget and finds the icon.
	bmSetFor(t, &bmSlotWait, 5*time.Second)
	bmSetFor(t, &bmLookupMax, 500*time.Millisecond)
	go func() { time.Sleep(900 * time.Millisecond); free() }()
	code, body := bmGet(t, client, ts.URL+"/api/bookmarks/icon?host="+host)
	if code != http.StatusOK || string(body) != string(bmPNG) {
		t.Fatalf("after the wait: %d %q, want the icon", code, body)
	}
}

// TestBookmarkIconBase: a relative icon link is read against the page the
// redirects led to, or against the page's <base href>.
func TestBookmarkIconBase(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	moved, _ := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			http.Redirect(w, r, "/en/", http.StatusFound)
		case "/en/":
			w.Write([]byte(`<link rel="icon" sizes="32x32" href="img/fav.png">`))
		case "/en/img/fav.png":
			w.Write(bmPNG)
		default:
			http.NotFound(w, r)
		}
	})
	based, _ := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Write([]byte(`<head><base href="/static/"><link rel="icon" href="i.png"></head>`))
		case "/static/i.png":
			w.Write(bmPNG)
		default:
			http.NotFound(w, r)
		}
	})
	for name, site := range map[string]*httptest.Server{"redirect": moved, "base href": based} {
		code, body := bmGet(t, client, ts.URL+"/api/bookmarks/icon?host="+strings.TrimPrefix(site.URL, "http://"))
		if code != http.StatusOK || string(body) != string(bmPNG) {
			t.Errorf("%s: %d %q, want the icon", name, code, body)
		}
	}
}

// TestBookmarkIconMarkers: a site that could not be asked (here a 503) is
// asked again after an hour; one that answered without an icon only after a
// week. Either "no icon" may be kept by the browser for an hour.
func TestBookmarkIconMarkers(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	ask := func(site *httptest.Server) (string, int, http.Header) {
		host := strings.TrimPrefix(site.URL, "http://")
		code, hdr := bmGetHead(t, client, ts.URL+"/api/bookmarks/icon?host="+host)
		return filepath.Join(srv.bmIconDir(), strings.ReplaceAll(host, ":", "_")), code, hdr
	}
	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }
	age := func(p string, d time.Duration) { at := time.Now().Add(-d); os.Chtimes(p, at, at) }

	down, downHits := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "later", http.StatusServiceUnavailable)
	})
	base, code, hdr := ask(down)
	if code != http.StatusNoContent || hdr.Get("Cache-Control") != "private, max-age=3600" {
		t.Fatalf("503 site: %d %q", code, hdr.Get("Cache-Control"))
	}
	if !exists(base+".err") || exists(base+".none") {
		t.Fatalf("503 site: want a .err marker only (err %v, none %v)", exists(base+".err"), exists(base+".none"))
	}
	n := atomic.LoadInt32(downHits)
	ask(down)
	if atomic.LoadInt32(downHits) != n {
		t.Fatalf("503 site asked again within the hour")
	}
	age(base+".err", 2*time.Hour)
	ask(down)
	if atomic.LoadInt32(downHits) == n {
		t.Fatalf("503 site not asked again after an hour")
	}

	plain, plainHits := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<html>no icon here</html>"))
	})
	base, code, _ = ask(plain)
	if code != http.StatusNoContent || !exists(base+".none") || exists(base+".err") {
		t.Fatalf("plain site: %d, want a .none marker only", code)
	}
	n = atomic.LoadInt32(plainHits)
	age(base+".none", 2*time.Hour)
	ask(plain)
	if atomic.LoadInt32(plainHits) != n {
		t.Fatalf("plain site asked again two hours later (a .none lasts a week)")
	}
}

// TestBookmarkIconCache: nothing lands in a home (the old in-home folder is
// removed), an old icon is fetched again, and the folder keeps to its cap.
func TestBookmarkIconCache(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	oldDir := filepath.Join(srv.cfg.HomesDir, "ana", "data", "bookmarks", "icons")
	os.MkdirAll(oldDir, 0o755)
	os.WriteFile(filepath.Join(oldDir, "x.img"), bmPNG, 0o644)

	site, hits := bmSite(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/favicon.ico" {
			w.Write(bmPNG)
			return
		}
		w.Write([]byte("<html></html>"))
	})
	host := strings.TrimPrefix(site.URL, "http://")
	if code, _ := bmGet(t, client, ts.URL+"/api/bookmarks/icon?host="+host); code != http.StatusOK {
		t.Fatalf("first ask: %d", code)
	}
	if _, err := os.Stat(oldDir); err == nil {
		t.Fatalf("the old in-home icon folder is still there")
	}
	if _, err := os.Stat(filepath.Dir(oldDir)); err != nil {
		t.Fatalf("data/bookmarks itself went too: %v", err)
	}

	img := filepath.Join(srv.bmIconDir(), strings.ReplaceAll(host, ":", "_")+".img")
	n := atomic.LoadInt32(hits)
	at := time.Now().Add(-31 * 24 * time.Hour)
	os.Chtimes(img, at, at)
	if code, _ := bmGet(t, client, ts.URL+"/api/bookmarks/icon?host="+host); code != http.StatusOK {
		t.Fatalf("stale ask: %d", code)
	}
	if atomic.LoadInt32(hits) == n {
		t.Fatalf("a 31-day-old icon was not fetched again")
	}
	if fi, err := os.Stat(img); err != nil || time.Since(fi.ModTime()) > time.Minute {
		t.Fatalf("the icon was not renewed: %v", err)
	}

	// The cap: the oldest icons go until the rest fit in nine tenths of it;
	// markers past their time go too.
	dir := t.TempDir()
	bmSetFor(t, &bmCacheMax, int64(100))
	now := time.Now()
	put := func(name string, size int, age time.Duration) {
		p := filepath.Join(dir, name)
		os.WriteFile(p, make([]byte, size), 0o644)
		os.Chtimes(p, now.Add(-age), now.Add(-age))
	}
	put("a.img", 60, 3*time.Hour)
	put("b.img", 60, 2*time.Hour)
	put("c.img", 60, time.Hour)
	put("gone.err", 0, 2*time.Hour)
	put("kept.none", 0, 24*time.Hour)
	bmSweep(dir)
	for name, want := range map[string]bool{"a.img": false, "b.img": false, "c.img": true, "gone.err": false, "kept.none": true} {
		if _, err := os.Stat(filepath.Join(dir, name)); (err == nil) != want {
			t.Errorf("after the sweep %s: present %v, want %v", name, err == nil, want)
		}
	}
}

// TestBookmarkOwnAddress: this machine's own addresses are refused like the
// LAN, even when they are public ones.
func TestBookmarkOwnAddress(t *testing.T) {
	bmSetFor(t, &bmOwnAddrs, func() ([]net.Addr, error) {
		return []net.Addr{&net.IPNet{IP: net.ParseIP("203.0.113.7"), Mask: net.CIDRMask(24, 32)}}, nil
	})
	reset := func() { bmOwnMu.Lock(); bmOwnAt = time.Time{}; bmOwnMu.Unlock() }
	reset()
	t.Cleanup(reset)

	if err := bmControl("tcp4", "203.0.113.7:443", nil); !errors.Is(err, errBmRefused) {
		t.Fatalf("own public address: %v, want refused", err)
	}
	if err := bmControl("tcp4", "203.0.113.8:443", nil); err != nil {
		t.Fatalf("a neighbour's address: %v, want allowed", err)
	}
}

// TestBookmarkShaky: which failures are asked again soon.
func TestBookmarkShaky(t *testing.T) {
	for err, want := range map[error]bool{
		bmStatusError(503): true, bmStatusError(429): true, bmStatusError(404): false,
		bmStatusError(403): false, errors.New("dial tcp: i/o timeout"): true,
		fmt.Errorf("dial: %w", errBmRefused): false, nil: false,
	} {
		if got := bmShaky(err); got != want {
			t.Errorf("%v: shaky %v, want %v", err, got, want)
		}
	}
}
