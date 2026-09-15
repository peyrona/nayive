package main

// =============================================================================
// End-to-end tests over a real HTTP server, in-process.
// =============================================================================
//
// httptest.NewServer stands a real server up on a random port inside the test
// binary. These cover the wiring the parity harness cannot reach without a
// second machine's worth of setup - and the two rules that are easy to break
// silently: the static sandbox, and the gzip tiers.

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestServer(t *testing.T) (*Server, *httptest.Server, *http.Client) {
	t.Helper()

	_, cfg, root := newTestUsers(t)

	// A static asset big enough to cross the gzip threshold, with a sidecar,
	// and one without.
	big := strings.Repeat("console.log('hola mundo');\n", 200)
	os.WriteFile(filepath.Join(root, "apps", "grande.js"), []byte(big), 0o644)
	writeGzipFile(t, filepath.Join(root, "apps", "grande.js.gz"), big)
	os.WriteFile(filepath.Join(root, "apps", "sinsidecar.js"), []byte(big), 0o644)
	os.WriteFile(filepath.Join(root, "apps", "login.html"), []byte("<h1>entra</h1>"), 0o644)

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv, err := NewServer(cfg, log)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	t.Cleanup(func() { srv.Close() })

	ts := httptest.NewServer(srv.routes())
	t.Cleanup(ts.Close)

	// A cookie jar, so a signed-in client stays signed in. DisableCompression
	// keeps the transport from silently asking for gzip and unwrapping it,
	// which would hide the very header these tests check.
	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Jar:       jar,
		Transport: &http.Transport{DisableCompression: true},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse // inspect the redirect, do not follow it
		},
	}
	return srv, ts, client
}

func writeGzipFile(t *testing.T, path, content string) {
	t.Helper()
	packed, err := gzipBytes([]byte(content))
	if err != nil {
		t.Fatalf("gzip: %v", err)
	}
	os.WriteFile(path, packed, 0o644)
}

func do(t *testing.T, client *http.Client, method, url string, body io.Reader,
	headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	return resp
}

func signIn(t *testing.T, client *http.Client, base, user, password string) {
	t.Helper()
	resp := do(t, client, "POST", base+"/api/login",
		strings.NewReader(`{"user":"`+user+`","password":"`+password+`"}`),
		map[string]string{"Content-Type": "application/json"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sign-in as %s failed: %d", user, resp.StatusCode)
	}
}

// TestSessionLifecycle: sign in, be recognised, sign out, be forgotten.
func TestSessionLifecycle(t *testing.T) {
	_, ts, client := newTestServer(t)

	resp := do(t, client, "GET", ts.URL+"/api/whoami", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("whoami without a cookie = %d, want 401", resp.StatusCode)
	}

	signIn(t, client, ts.URL, "ana", "abc")

	resp = do(t, client, "GET", ts.URL+"/api/whoami", nil, nil)
	var me map[string]any
	json.NewDecoder(resp.Body).Decode(&me)
	resp.Body.Close()
	if me["user"] != "ana" || me["role"] != "user" {
		t.Errorf("whoami = %v", me)
	}

	resp = do(t, client, "GET", ts.URL+"/api/logout", nil, nil)
	resp.Body.Close()

	resp = do(t, client, "GET", ts.URL+"/api/whoami", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("whoami after logout = %d, want 401", resp.StatusCode)
	}
}

// TestCookieAttributes - HttpOnly and SameSite are what keep the session out of
// reach of a script and of a cross-site form post.
func TestCookieAttributes(t *testing.T) {
	_, ts, client := newTestServer(t)

	resp := do(t, client, "POST", ts.URL+"/api/login",
		strings.NewReader(`{"user":"ana","password":"abc"}`),
		map[string]string{"Content-Type": "application/json"})
	defer resp.Body.Close()

	raw := resp.Header.Get("Set-Cookie")
	for _, want := range []string{CookieName + "=", "HttpOnly", "SameSite=Lax", "Path=/"} {
		if !strings.Contains(raw, want) {
			t.Errorf("Set-Cookie %q is missing %q", raw, want)
		}
	}
	// No Max-Age without "remember me": the cookie must die with the browser.
	if strings.Contains(raw, "Max-Age") {
		t.Errorf("a plain sign-in set a persistent cookie: %q", raw)
	}
	// Not on a plain HTTP connection, which httptest is.
	if strings.Contains(raw, "Secure") {
		t.Errorf("Secure was set over plain HTTP: %q", raw)
	}
}

// TestStaticSandbox is the os.Root test: a symlink planted in apps/ pointing
// out of the tree must not be followed.
func TestStaticSandbox(t *testing.T) {
	_, cfg, _ := newTestUsers(t)
	os.Symlink("/etc", filepath.Join(cfg.AppsDir, "fuera"))

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv, err := NewServer(cfg, log)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	defer srv.Close()
	ts := httptest.NewServer(srv.routes())
	defer ts.Close()

	// SIGNED IN on purpose: an anonymous request is refused by the session gate
	// before the sandbox is ever consulted, which would make this test pass for
	// the wrong reason.
	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Jar: jar,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	signIn(t, client, ts.URL, "ana", "abc")
	for _, path := range []string{
		"/nayive/fuera/passwd", // a real symlink out of the tree
		"/nayive/../config/server.json",
		"/nayive/%2e%2e/config/server.json",
	} {
		resp := do(t, client, "GET", ts.URL+path, nil, nil)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s = %d (%s), want 403 or 404",
				path, resp.StatusCode, strings.TrimSpace(string(body)))
		}
		if strings.Contains(string(body), "root:") || strings.Contains(string(body), "password") {
			t.Errorf("GET %s LEAKED content", path)
		}
	}
}

// TestPublicStatic - the login page and the service worker must be reachable
// with NO session, and everything else must not.
func TestPublicStatic(t *testing.T) {
	_, ts, client := newTestServer(t)

	resp := do(t, client, "GET", ts.URL+"/nayive/login.html", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("login.html without a session = %d, want 200", resp.StatusCode)
	}

	resp = do(t, client, "GET", ts.URL+"/nayive/index.html", nil,
		map[string]string{"Accept": "text/html"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("index.html without a session = %d, want a 302", resp.StatusCode)
	}
	loc := resp.Header.Get("Location")
	if !strings.Contains(loc, "/login.html?return=/nayive/index.html") {
		t.Errorf("Location = %q - the ?return= path must keep its slashes", loc)
	}

	// The same URL asked for by fetch(), which wants JSON and not a login page.
	resp = do(t, client, "GET", ts.URL+"/nayive/index.html", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("index.html to a non-browser = %d, want 401", resp.StatusCode)
	}
}

// TestGzipSidecar - the pre-built .gz goes out instead of the source, and the
// Content-Type is still JavaScript rather than the sniffed gzip magic.
func TestGzipSidecar(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	resp := do(t, client, "GET", ts.URL+"/nayive/grande.js", nil,
		map[string]string{"Accept-Encoding": "gzip"})
	defer resp.Body.Close()

	if enc := resp.Header.Get("Content-Encoding"); enc != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", enc)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Errorf("Content-Type = %q - it was sniffed from the gzip magic", ct)
	}
	if resp.Header.Get("Content-Length") == "" {
		t.Error("no Content-Length: the answer fell back to chunked")
	}
	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatalf("body is not gzip: %v", err)
	}
	body, _ := io.ReadAll(zr)
	if !strings.HasPrefix(string(body), "console.log") {
		t.Errorf("unzipped body starts %q", string(body[:20]))
	}
}

// TestGzipSecondTier - a text asset with NO sidecar is still compressed at
// request time, and a Range request is not.
func TestGzipSecondTier(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	resp := do(t, client, "GET", ts.URL+"/nayive/sinsidecar.js", nil,
		map[string]string{"Accept-Encoding": "gzip"})
	resp.Body.Close()
	if enc := resp.Header.Get("Content-Encoding"); enc != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip from the second tier", enc)
	}

	resp = do(t, client, "GET", ts.URL+"/nayive/sinsidecar.js", nil,
		map[string]string{"Accept-Encoding": "gzip", "Range": "bytes=0-9"})
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		t.Errorf("a Range request = %d, want 206", resp.StatusCode)
	}
	if resp.Header.Get("Content-Encoding") != "" {
		t.Error("a Range request was gzipped - there is no seeking in a gzip stream")
	}
	if len(body) != 10 {
		t.Errorf("Range gave %d bytes, want 10", len(body))
	}
}

// TestFileRoundTrip - write a file, read it back, move it, trash it.
func TestFileRoundTrip(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	resp := do(t, client, "PUT", ts.URL+"/api/files?file=files/nuevo.txt",
		strings.NewReader("hola\n"), map[string]string{"Content-Type": "text/plain"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT = %d, want 200", resp.StatusCode)
	}

	resp = do(t, client, "GET", ts.URL+"/api/files?file=files/nuevo.txt", nil, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "hola\n" {
		t.Errorf("read back %q", body)
	}

	resp = do(t, client, "POST",
		ts.URL+"/api/files?old=files/nuevo.txt&new=files/movido.txt", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("move = %d, want 200", resp.StatusCode)
	}

	resp = do(t, client, "DELETE", ts.URL+"/api/files?paths=files/movido.txt", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("delete = %d, want 200", resp.StatusCode)
	}

	resp = do(t, client, "GET", ts.URL+"/api/files?trash=list", nil, nil)
	var listing struct{ Items []TrashItem }
	json.NewDecoder(resp.Body).Decode(&listing)
	resp.Body.Close()
	if len(listing.Items) != 1 || listing.Items[0].Name != "movido.txt" {
		t.Errorf("trash listing = %+v", listing.Items)
	}
}

// TestPutIfUnmodifiedSince - the office editors' "changed on another device"
// guard. A PUT carrying an older If-Unmodified-Since is refused with 412 and
// leaves the file alone; the file's own Last-Modified (which every PUT now
// answers with) passes; no header, or a garbled one, is no check at all.
func TestPutIfUnmodifiedSince(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	url := ts.URL + "/api/files?file=files/carta.txt"

	put := func(body string, headers map[string]string) *http.Response {
		t.Helper()
		resp := do(t, client, "PUT", url, strings.NewReader(body), headers)
		resp.Body.Close()
		return resp
	}

	resp := put("v1", nil)
	lm := resp.Header.Get("Last-Modified")
	if resp.StatusCode != http.StatusOK || lm == "" {
		t.Fatalf("first PUT = %d, Last-Modified %q", resp.StatusCode, lm)
	}

	// Saved elsewhere since "we" read it: an hour-old base must be refused.
	old := time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat)
	if resp = put("stale", map[string]string{"If-Unmodified-Since": old}); resp.StatusCode != http.StatusPreconditionFailed {
		t.Errorf("stale PUT = %d, want 412", resp.StatusCode)
	}
	resp = do(t, client, "GET", url, nil, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "v1" {
		t.Errorf("a refused PUT changed the file: %q", body)
	}

	// Our own last save's time passes.
	if resp = put("v2", map[string]string{"If-Unmodified-Since": lm}); resp.StatusCode != http.StatusOK {
		t.Errorf("PUT with the current Last-Modified = %d, want 200", resp.StatusCode)
	}
	if resp = put("v3", map[string]string{"If-Unmodified-Since": "no es una fecha"}); resp.StatusCode != http.StatusOK {
		t.Errorf("PUT with a garbled header = %d, want 200 (no check)", resp.StatusCode)
	}
	if resp = put("v4", nil); resp.StatusCode != http.StatusOK {
		t.Errorf("PUT with no header = %d, want 200", resp.StatusCode)
	}
}

// TestPutWithoutContentLength is the 0-byte-file bug the Python grew a 411 for:
// a client that sends no body and no length must NOT wipe the target.
func TestPutWithoutContentLength(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	// java: an io.Reader body of unknown length makes net/http use chunked
	// encoding, so ContentLength arrives as -1 - the same shape as "absent".
	req, _ := http.NewRequest("PUT", ts.URL+"/api/files?file=files/mio.txt",
		io.NopCloser(strings.NewReader("")))
	req.ContentLength = -1
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("PUT: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusLengthRequired {
		t.Errorf("PUT with no length = %d, want 411", resp.StatusCode)
	}

	resp = do(t, client, "GET", ts.URL+"/api/files?file=files/mio.txt", nil, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "mío\n" {
		t.Errorf("the existing file was damaged: %q", body)
	}
}

// TestUnknownAPIRouteIsJSON - the browser apps parse every /api/ answer as JSON,
// so a 404 there must never be an HTML page.
func TestUnknownAPIRouteIsJSON(t *testing.T) {
	_, ts, client := newTestServer(t)

	resp := do(t, client, "GET", ts.URL+"/api/nada", nil, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want JSON", ct)
	}
}

// TestSecurityHeaders - cheap defence in depth, and it must be on EVERY answer
// including a refusal.
func TestSecurityHeaders(t *testing.T) {
	_, ts, client := newTestServer(t)

	for _, path := range []string{"/api/whoami", "/nayive/login.html", "/nayive/../x", "/"} {
		resp := do(t, client, "GET", ts.URL+path, nil, nil)
		resp.Body.Close()
		for header, want := range map[string]string{
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options":        "SAMEORIGIN",
			"Referrer-Policy":        "strict-origin-when-cross-origin",
		} {
			if got := resp.Header.Get(header); got != want {
				t.Errorf("GET %s: %s = %q, want %q", path, header, got, want)
			}
		}
	}
}

// TestAdminPanelOpensOnAFreshInstall, and locks once an admin exists.
func TestAdminPanelGate(t *testing.T) {
	_, ts, client := newTestServer(t)

	// The fixture already has an admin, so an anonymous GET must be refused.
	resp := do(t, client, "GET", ts.URL+"/api/admin", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("anonymous /api/admin = %d, want 401", resp.StatusCode)
	}

	// A REGULAR user is refused too, and with a different code: they are signed
	// in, just not allowed.
	signIn(t, client, ts.URL, "ana", "abc")
	resp = do(t, client, "GET", ts.URL+"/api/admin", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("a regular user's /api/admin = %d, want 403", resp.StatusCode)
	}

	signIn(t, client, ts.URL, "jefe", "secreto")
	resp = do(t, client, "GET", ts.URL+"/api/admin", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("the admin's /api/admin = %d, want 200", resp.StatusCode)
	}
}

// TestChunkedBodyIsRefused - handler.py tests Transfer-Encoding at the top of
// _dispatch, before it looks at the path, and answers 411 on EVERY route.
//
// This test exists because refuseChunked was written and then never wired into
// the chain in routes(), so for a while the Go server quietly accepted a
// chunked POST that the Python refused - and nothing noticed, because no test
// and none of the parity harness's 214 requests sends one.
func TestChunkedBodyIsRefused(t *testing.T) {
	_, ts, client := newTestServer(t)

	// A body of unknown length makes net/http send it chunked.
	chunked := func(method, url, body string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(method, url, io.NopCloser(strings.NewReader(body)))
		req.ContentLength = -1
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, url, err)
		}
		return resp
	}

	// No GET case: net/http's CLIENT drops the body of a GET rather than
	// chunking it, so a test cannot produce one. The server does refuse it -
	// checked by hand with a raw socket, 411 on both servers - it just cannot
	// be driven from here.
	for _, tc := range []struct{ method, url, body string }{
		{"POST", ts.URL + "/api/login", `{"user":"ana","password":"abc"}`},
		{"POST", ts.URL + "/api/admin", `{"action":"create-user"}`},
		{"PUT", ts.URL + "/api/files?file=files/mio.txt", "x"},
	} {
		resp := chunked(tc.method, tc.url, tc.body)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode != http.StatusLengthRequired {
			t.Errorf("%s %s chunked = %d, want 411", tc.method, tc.url, resp.StatusCode)
		}
		if !strings.Contains(string(body), "no chunked") {
			t.Errorf("%s %s chunked body = %q, want the Python's wording",
				tc.method, tc.url, body)
		}
		// The refusal is a response like any other: it carries the headers.
		if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s %s chunked went out without the security headers",
				tc.method, tc.url)
		}
	}
}

// TestOversizedBodyIs413 - handler.py sizes every API body from Content-Length
// and answers 413 "petición demasiado grande" over 1 MiB. Folding that into the
// generic 400 "bad JSON" loses a message the admin panel shows to a person.
//
// The FORM case is the one that bit: /api/login has two body shapes and only
// the JSON one went through readJSON, so a 1 MB form body signed the user in.
func TestOversizedBodyIs413(t *testing.T) {
	_, ts, client := newTestServer(t)

	pad := strings.Repeat("A", maxBody+1000)
	jsonBody := `{"user":"ana","password":"abc","pad":"` + pad + `"}`

	// The routes behind a session are checked SIGNED IN on purpose. handler.py
	// reads the body before it looks at the cookie, so it answers 413 to a
	// stranger too; this port checks the session first and answers 401. That
	// ordering is left as it is - see docs/go-port-review.md, A2 - so the size
	// check is asserted where both servers can reach it.
	signIn(t, client, ts.URL, "ana", "abc")

	for _, tc := range []struct{ name, url, ctype, body string }{
		{"login-json", "/api/login", "application/json", jsonBody},
		{"login-form", "/api/login", "application/x-www-form-urlencoded",
			"user=ana&password=abc&pad=" + pad},
		{"password", "/api/password", "application/json", jsonBody},
		{"push", "/api/push", "application/json", jsonBody},
		{"shares", "/api/shares", "application/json", jsonBody},
	} {
		resp := do(t, client, "POST", ts.URL+tc.url, strings.NewReader(tc.body),
			map[string]string{"Content-Type": tc.ctype})
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode != http.StatusRequestEntityTooLarge {
			t.Errorf("%s: oversized body = %d, want 413 (body %q)",
				tc.name, resp.StatusCode, body)
		}
		if !strings.Contains(string(body), "demasiado grande") {
			t.Errorf("%s: body = %q, want the Python's wording", tc.name, body)
		}
	}

	// The admin panel needs the admin's own session.
	adminJar, _ := cookiejar.New(nil)
	adminClient := &http.Client{Jar: adminJar,
		Transport: &http.Transport{DisableCompression: true}}
	signIn(t, adminClient, ts.URL, "jefe", "secreto")

	resp := do(t, adminClient, "POST", ts.URL+"/api/admin",
		strings.NewReader(`{"action":"create-user","pad":"`+pad+`"}`),
		map[string]string{"Content-Type": "application/json"})
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("admin: oversized body = %d, want 413 (body %q)", resp.StatusCode, body)
	}

	// And the guard must NOT fire on a body that fits.
	resp = do(t, client, "GET", ts.URL+"/api/whoami", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("a normal request after the guard = %d, want 200", resp.StatusCode)
	}
}

// TestOddPathShapesAreNotRedirects - http.ServeMux answers its own 307 to the
// path.Clean()'d URL whenever the request path is not already clean, which
// turns a page the Python SERVES into a redirect. collapsePath rewrites the
// path before the mux sees it, so the two servers answer the same thing.
//
// "/api" is the same bug from the other side: without an exact pattern the mux
// redirects it to the "/api/" subtree, where handler.py just 404s.
func TestOddPathShapesAreNotRedirects(t *testing.T) {
	_, ts, client := newTestServer(t)
	// Signed in, so a missing app file is a 404 rather than the 401 the static
	// tree answers to a stranger - it is the 404 this test is about.
	signIn(t, client, ts.URL, "ana", "abc")

	for _, tc := range []struct {
		path string
		want int
	}{
		{"/nayive//login.html", http.StatusOK},  // interior "//"
		{"/nayive/./login.html", http.StatusOK}, // a "." segment
		{"//nayive/login.html", http.StatusOK},  // leading "//", as parse_request collapses it
		{"/api", http.StatusNotFound},           // not the mux's 307 to "/api/"
		{"/api/nope", http.StatusNotFound},      // the JSON 404 still works
		{"/nayive/nope.html", http.StatusNotFound},
	} {
		resp := do(t, client, "GET", ts.URL+tc.path, nil, nil)
		resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Errorf("GET %s = %d, want %d (Location %q)",
				tc.path, resp.StatusCode, tc.want, resp.Header.Get("Location"))
		}
	}

	// And collapsing must NOT open the traversal guard: it runs on the raw path,
	// outside collapsePath, so a ".." hidden behind a double slash is still 403.
	for _, path := range []string{
		"/nayive/../config/server.json",
		"/nayive/..//config/server.json",
		"/nayive/%2e%2e/config/server.json",
	} {
		resp := do(t, client, "GET", ts.URL+path, nil, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("GET %s = %d, want 403", path, resp.StatusCode)
		}
	}
}
