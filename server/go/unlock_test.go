package main

import (
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
)

// TestUnlock: the screen locker's password check. Right = 200, wrong = 403,
// no session = 401 (the page goes to the login screen), GET = 405.
func TestUnlock(t *testing.T) {
	_, ts, _ := newTestServer(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	json := map[string]string{"Content-Type": "application/json"}
	try := func(pw string) int {
		resp := do(t, client, "POST", ts.URL+"/api/unlock", strings.NewReader(`{"password":"`+pw+`"}`), json)
		resp.Body.Close()
		return resp.StatusCode
	}

	if got := try("abc"); got != http.StatusUnauthorized {
		t.Errorf("no session: %d, want 401", got)
	}
	signIn(t, client, ts.URL, "ana", "abc")
	if got := try("nope"); got != http.StatusForbidden {
		t.Errorf("wrong password: %d, want 403", got)
	}
	if got := try("abc"); got != http.StatusOK {
		t.Errorf("right password: %d, want 200", got)
	}
	resp := do(t, client, "GET", ts.URL+"/api/unlock", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET: %d, want 405", resp.StatusCode)
	}
}
