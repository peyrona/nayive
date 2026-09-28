package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// whoCookie is the "nayive_who" cookie the answer set, or "".
func whoCookie(resp *http.Response) string {
	for _, c := range resp.Cookies() {
		if c.Name == WhoCookieName {
			return c.Value
		}
	}
	return ""
}

// TestWhoCookieFollowsTheSession: sign-in and whoami name the account in the
// readable cookie; sign-out clears it. store.js reads it once per page.
func TestWhoCookieFollowsTheSession(t *testing.T) {
	_, ts, client := newTestServer(t)

	resp := do(t, client, "POST", ts.URL+"/api/login",
		strings.NewReader(`{"user":"ana","password":"abc"}`),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if got := whoCookie(resp); got != "user:ana" {
		t.Fatalf("login: nayive_who = %q, want user:ana", got)
	}
	for _, raw := range resp.Header.Values("Set-Cookie") {
		if strings.HasPrefix(raw, WhoCookieName+"=") && strings.Contains(raw, "HttpOnly") {
			t.Errorf("nayive_who must be readable by the page: %q", raw)
		}
	}

	resp = do(t, client, "GET", ts.URL+"/api/whoami", nil, nil)
	resp.Body.Close()
	if got := whoCookie(resp); got != "user:ana" {
		t.Errorf("whoami: nayive_who = %q, want user:ana", got)
	}

	resp = do(t, client, "POST", ts.URL+"/api/logout", nil, nil)
	resp.Body.Close()
	cleared := false
	for _, raw := range resp.Header.Values("Set-Cookie") {
		if strings.HasPrefix(raw, WhoCookieName+"=;") && strings.Contains(raw, "Max-Age=0") {
			cleared = true
		}
	}
	if !cleared {
		t.Errorf("logout did not clear nayive_who: %q", resp.Header.Values("Set-Cookie"))
	}
}

// TestSaveQueuedByAnotherAccount: a save queued while ana was signed in, sent
// once beto is, is refused with 423 and lands nowhere. Beto's own save, and a
// save with no name at all (a page from before), go through as always.
func TestSaveQueuedByAnotherAccount(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "beto", "xyz")
	url := ts.URL + "/api/files?file=data/notes.txt"
	beto := filepath.Join(srv.cfg.HomesDir, "beto", "data", "notes.txt")

	resp := do(t, client, "PUT", url, strings.NewReader("de ana"),
		map[string]string{whoHeader: whoValue("user", "ana")})
	resp.Body.Close()
	if resp.StatusCode != http.StatusLocked {
		t.Fatalf("ana's save under beto's session = %d, want 423", resp.StatusCode)
	}
	if _, err := os.Stat(beto); err == nil {
		t.Fatalf("ana's save reached beto's home")
	}

	// The same name as a user, but the admin's: a different account.
	resp = do(t, client, "PUT", url, strings.NewReader("del jefe"),
		map[string]string{whoHeader: whoValue("admin", "beto")})
	resp.Body.Close()
	if resp.StatusCode != http.StatusLocked {
		t.Errorf("admin:beto under user beto = %d, want 423", resp.StatusCode)
	}

	resp = do(t, client, "PUT", url, strings.NewReader("de beto"),
		map[string]string{whoHeader: whoValue("user", "beto")})
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		t.Fatalf("beto's own save = %d", resp.StatusCode)
	}
	if b, _ := os.ReadFile(beto); string(b) != "de beto" {
		t.Errorf("beto's file = %q", b)
	}

	resp = do(t, client, "PUT", url, strings.NewReader("sin nombre"), nil)
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		t.Errorf("a save with no name (an old page) = %d, want it taken", resp.StatusCode)
	}
}

// TestWhoValueEscapes: a name with a space or an accent is one cookie token,
// and the page sends back exactly what the cookie holds.
func TestWhoValueEscapes(t *testing.T) {
	v := whoValue("user", "José Luis;x,y")
	if strings.ContainsAny(v, " ;,\"") {
		t.Errorf("whoValue = %q: not one cookie token", v)
	}
}
