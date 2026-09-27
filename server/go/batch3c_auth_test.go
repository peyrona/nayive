package main

import (
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"
)

// TestAddrKey: an IPv6 client is one address per /64 - the block it can pick
// any address from - and an IPv4 one is its address.
func TestAddrKey(t *testing.T) {
	for in, want := range map[string]string{
		"203.0.113.5":             "203.0.113.5",
		"2001:db8:1:2:aaaa::1":    "2001:db8:1:2::/64",
		"2001:db8:1:2:bbbb::9":    "2001:db8:1:2::/64",
		"::ffff:203.0.113.5":      "203.0.113.5",
		"fe80::1%eth0":            "fe80::/64",
		"not an ip":               "not an ip",
		"2001:db8:1:3:aaaa::1234": "2001:db8:1:3::/64",
	} {
		if got := addrKey(in); got != want {
			t.Errorf("addrKey(%q) = %q, want %q", in, got, want)
		}
	}
}

// noFollow is a client that shows a redirect instead of following it.
func noFollow() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, Transport: &http.Transport{DisableCompression: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// TestLoginFormRedirects: the login page's <form> without JavaScript. A good
// sign-in goes on to the launcher (the admin to its panel) with the cookie; a
// bad one back to the login page, with none. JSON callers are unchanged.
func TestLoginFormRedirects(t *testing.T) {
	_, ts, _ := newTestServer(t)
	form := map[string]string{"Content-Type": "application/x-www-form-urlencoded"}
	post := func(c *http.Client, body string) *http.Response {
		resp := do(t, c, "POST", ts.URL+"/api/login", strings.NewReader(body), form)
		resp.Body.Close()
		return resp
	}

	for _, c := range []struct{ user, pw, where string }{
		{"ana", "abc", URLPrefix + "/"},
		{"jefe", "secreto", URLPrefix + "/admin.html"},
	} {
		client := noFollow()
		resp := post(client, "user="+url.QueryEscape(c.user)+"&password="+url.QueryEscape(c.pw)+"&remember=on")
		if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != c.where {
			t.Errorf("form login as %s = %d to %q, want 303 to %q",
				c.user, resp.StatusCode, resp.Header.Get("Location"), c.where)
		}
		if u, _ := whoami(t, client, ts.URL); u != c.user {
			t.Errorf("after the form login the session is %q, want %s", u, c.user)
		}
	}

	client := noFollow()
	resp := post(client, "user=ana&password=mal")
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != URLPrefix+"/login.html" {
		t.Errorf("bad form login = %d to %q, want 303 to the login page",
			resp.StatusCode, resp.Header.Get("Location"))
	}
	if resp.Header.Get("Set-Cookie") != "" {
		t.Errorf("a failed login set a cookie: %q", resp.Header.Get("Set-Cookie"))
	}

	// JSON: 200 with a body, 401 on a bad password, no redirect.
	resp = do(t, noFollow(), "POST", ts.URL+"/api/login",
		strings.NewReader(`{"user":"ana","password":"abc"}`), map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("JSON login = %d, want 200", resp.StatusCode)
	}
	resp = do(t, noFollow(), "POST", ts.URL+"/api/login",
		strings.NewReader(`{"user":"ana","password":"mal"}`), map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("bad JSON login = %d, want 401", resp.StatusCode)
	}
}
