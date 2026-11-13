package main

// =============================================================================
// sites_auth.go: a .password file in a site folder asks for a login.
// =============================================================================

import (
	"encoding/base64"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newLockedSite is newSitesServer with a password on "cv": ana / secreto.
func newLockedSite(t *testing.T) (*Server, string, *http.Client, string) {
	t.Helper()
	srv, base, client := newSitesServer(t)
	sites := srv.cfg.SitesPath()
	file := filepath.Join(sites, "cv", ".password")
	body := "# who may see the cv\n\nana:" + hashPassword("secreto") + "\n"
	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(sites, "open"), 0o755)
	os.WriteFile(filepath.Join(sites, "open", "index.html"), []byte("abierto"), 0o644)
	return srv, base, client, file
}

func basic(name, password string) map[string]string {
	return map[string]string{"Authorization": "Basic " +
		base64.StdEncoding.EncodeToString([]byte(name+":"+password))}
}

// get answers status, body and the response.
func get(t *testing.T, client *http.Client, url string, headers map[string]string) (int, string, *http.Response) {
	t.Helper()
	resp := do(t, client, "GET", url, nil, headers)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp.StatusCode, string(body), resp
}

func TestSitePassword(t *testing.T) {
	_, base, client, _ := newLockedSite(t)
	ana := basic("ana", "secreto")

	// No login: the browser's box is asked for.
	st, _, resp := get(t, client, base+"/cv/", nil)
	if st != 401 || !strings.HasPrefix(resp.Header.Get("WWW-Authenticate"), `Basic realm="cv"`) {
		t.Fatalf("no login = %d %q", st, resp.Header.Get("WWW-Authenticate"))
	}
	// "/cv" is sent to "/cv/" first, with no question: a login asked at
	// "/cv" would be one the browser sends to all of "/".
	st, _, resp = get(t, client, base+"/cv", nil)
	if st != 302 || resp.Header.Get("Location") != "/cv/" || resp.Header.Get("WWW-Authenticate") != "" {
		t.Errorf("GET /cv = %d %q %q", st, resp.Header.Get("Location"), resp.Header.Get("WWW-Authenticate"))
	}

	// The right login opens every file of the site, kept private.
	for path, want := range map[string]string{
		"/cv/":             "<h1>cv</h1>",
		"/cv/style.css":    "h1{color:red}",
		"/cv/sub/nota.txt": "sin index",
	} {
		st, body, resp := get(t, client, base+path, ana)
		if st != 200 || body != want {
			t.Errorf("GET %s with login = %d %q", path, st, body)
		}
		if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "private") {
			t.Errorf("GET %s Cache-Control = %q, want private", path, cc)
		}
	}
	// Other folders that stay 404 / redirect after the login.
	if st, _, _ := get(t, client, base+"/cv/sub", ana); st != 302 {
		t.Errorf("GET /cv/sub with login = %d, want 302", st)
	}
	// The file itself is never served, login or not.
	for _, h := range []map[string]string{nil, ana} {
		if st, body, _ := get(t, client, base+"/cv/.password", h); st != 404 || strings.Contains(body, "pbkdf2") {
			t.Errorf("GET /cv/.password = %d %q", st, body)
		}
	}

	// Wrong password, unknown name: asked again.
	for _, h := range []map[string]string{basic("ana", "nope"), basic("luis", "secreto"), basic("", "")} {
		if st, body, _ := get(t, client, base+"/cv/", h); st != 401 || strings.Contains(body, "cv") {
			t.Errorf("wrong login %v = %d %q", h, st, body)
		}
	}

	// A site with no .password stays public.
	if st, body, _ := get(t, client, base+"/open/", nil); st != 200 || body != "abierto" {
		t.Errorf("public site = %d %q", st, body)
	}
}

// TestSitePasswordFileChange - a change works at once: removed people are out,
// a removed file makes the site public again.
func TestSitePasswordFileChange(t *testing.T) {
	_, base, client, file := newLockedSite(t)
	ana := basic("ana", "secreto")
	if st, _, _ := get(t, client, base+"/cv/", ana); st != 200 {
		t.Fatalf("login = %d", st)
	}
	os.WriteFile(file, []byte("luis:"+hashPassword("otro")+"\n"), 0o644)
	if st, _, _ := get(t, client, base+"/cv/", ana); st != 401 {
		t.Errorf("removed person = %d, want 401", st)
	}
	if st, _, _ := get(t, client, base+"/cv/", basic("luis", "otro")); st != 200 {
		t.Errorf("added person = %d, want 200", st)
	}
	os.Remove(file)
	if st, _, _ := get(t, client, base+"/cv/", nil); st != 200 {
		t.Errorf("file removed = %d, want 200", st)
	}
}

// TestSitePasswordFailsClosed - only "no file" means public.
func TestSitePasswordFailsClosed(t *testing.T) {
	_, base, client, file := newLockedSite(t)

	// Plain text is never accepted, even typed right.
	os.WriteFile(file, []byte("ana:secreto\n"), 0o644)
	if st, _, _ := get(t, client, base+"/cv/", basic("ana", "secreto")); st != 401 {
		t.Errorf("plain-text line = %d, want 401", st)
	}
	// Empty.
	os.WriteFile(file, nil, 0o644)
	if st, _, _ := get(t, client, base+"/cv/", nil); st != 401 {
		t.Errorf("empty file = %d, want 401", st)
	}
	// Not a file.
	os.Remove(file)
	os.Mkdir(file, 0o755)
	if st, _, _ := get(t, client, base+"/cv/", nil); st != 401 {
		t.Errorf(".password folder = %d, want 401", st)
	}
	os.Remove(file)
	// Too big.
	os.WriteFile(file, make([]byte, sitePasswordMax+1), 0o644)
	if st, _, _ := get(t, client, base+"/cv/", nil); st != 401 {
		t.Errorf("huge file = %d, want 401", st)
	}
	// Unreadable (root reads anything; skip there).
	if os.Geteuid() != 0 {
		os.Remove(file)
		os.WriteFile(file, []byte("ana:"+hashPassword("secreto")+"\n"), 0o000)
		if st, _, _ := get(t, client, base+"/cv/", basic("ana", "secreto")); st != 401 {
			t.Errorf("unreadable file = %d, want 401", st)
		}
	}
}

// TestSitePasswordGuessing - siteFailMax different wrong passwords lock the
// address out, even for the right one; the same wrong one again is free; a
// visit with no password never counts.
func TestSitePasswordGuessing(t *testing.T) {
	_, base, client, _ := newLockedSite(t)

	for i := 0; i < 20; i++ {
		get(t, client, base+"/cv/", nil)
		get(t, client, base+"/cv/", basic("ana", "old")) // a browser holding an old password
	}
	if st, _, _ := get(t, client, base+"/cv/", basic("ana", "secreto")); st != 200 {
		t.Fatalf("after no-login visits and one repeated wrong password = %d, want 200", st)
	}

	for i := 0; i < siteFailMax; i++ {
		if st, _, _ := get(t, client, base+"/cv/", basic("ana", "guess"+string(rune('a'+i)))); st != 401 {
			t.Fatalf("guess %d = %d, want 401", i, st)
		}
	}
	st, _, resp := get(t, client, base+"/cv/", basic("ana", "secreto"))
	if st != 429 || resp.Header.Get("Retry-After") == "" {
		t.Errorf("after %d guesses = %d (Retry-After %q), want 429", siteFailMax, st, resp.Header.Get("Retry-After"))
	}
}

// TestSiteGuardLockGrows - each lock-out doubles, up to siteLockMax.
func TestSiteGuardLockGrows(t *testing.T) {
	var g siteGuard
	now := timeNowForTest()
	for round, want := range []int{1, 2, 4, 8, 16, 32, 60, 60} {
		var locked bool
		for i := 0; i < siteFailMax; i++ {
			locked = g.wrongGuess([32]byte{byte(round), byte(i)}, "1.2.3.4", now)
		}
		if !locked {
			t.Fatalf("round %d: not locked", round)
		}
		if got := g.lockedFor("1.2.3.4", now); got.Minutes() != float64(want) {
			t.Errorf("round %d: locked %v, want %d min", round, got, want)
		}
		now = now.Add(siteLockMax)
	}
	if g.lockedFor("5.6.7.8", now) != 0 {
		t.Error("another address is locked out too")
	}
}

// TestSitePasswordLine - the CLI's line opens the site, and nothing else.
func TestSitePasswordLine(t *testing.T) {
	in, _ := os.CreateTemp(t.TempDir(), "in")
	in.WriteString("mi clave\n")
	in.Seek(0, 0)
	var out, msg strings.Builder
	if err := printSitePasswordLine("ana", in, &out, &msg); err != nil {
		t.Fatal(err)
	}
	people := parseSitePasswords([]byte(out.String()))
	if ok, _ := checkPassword("mi clave", people["ana"]); !ok {
		t.Errorf("line %q does not open with the password", out.String())
	}
	if strings.Contains(out.String(), "mi clave") {
		t.Error("the plain password is in the line")
	}
	for _, bad := range []string{"a:b", " ana", "a\nb"} {
		if err := printSitePasswordLine(bad, in, &out, &msg); err == nil {
			t.Errorf("name %q accepted", bad)
		}
	}
	empty, _ := os.CreateTemp(t.TempDir(), "in")
	if err := printSitePasswordLine("ana", empty, &out, &msg); err == nil {
		t.Error("no password accepted")
	}
}

func timeNowForTest() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
