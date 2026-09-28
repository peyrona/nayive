package main

// =============================================================================
// Batch 4 part 3 (cross #17): a signed-out visit keeps ONLY a one-shot target
// for after the sign-in - a chat notice (?c=), a link shared to Chat (?text=),
// a "¿Dónde estás?" answer (?here=). Anything else gets no ?return= at all.
// =============================================================================

import (
	"net/http"
	"net/url"
	"testing"
)

func TestB4LoginReturn(t *testing.T) {
	_, ts, client := newTestServer(t)
	for _, c := range []struct{ in, want string }{
		{"/nayive/index.html", "/nayive/login.html"},
		{"/nayive/?here=f123", "/nayive/login.html?return=/nayive/%3Fhere%3Df123"},
		{"/nayive/?here=f1&x=2", "/nayive/login.html?return=/nayive/%3Fhere%3Df1"},
		{"/nayive/?x=2", "/nayive/login.html"},
		{"/nayive/chat/?c=abc&evil=1", "/nayive/login.html?return=/nayive/chat/%3Fc%3Dabc"},
		{"/nayive/chat/?text=" + url.QueryEscape("https://a.b/?q=1&r=2"),
			"/nayive/login.html?return=/nayive/chat/%3Ftext%3Dhttps%253A%252F%252Fa.b%252F%253Fq%253D1%2526r%253D2"},
		{"/nayive/chat/", "/nayive/login.html"},
		{"/nayive/drive/index.html?c=1", "/nayive/login.html"},
		{"/nayive/share-target/", "/nayive/login.html"},
	} {
		resp := do(t, client, "GET", ts.URL+c.in, nil, map[string]string{"Accept": "text/html"})
		resp.Body.Close()
		if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != c.want {
			t.Errorf("%s -> %d %q, want %q", c.in, resp.StatusCode, resp.Header.Get("Location"), c.want)
		}
		// What login.html reads back is the same one-shot URL.
		if u, _ := url.Parse(resp.Header.Get("Location")); u != nil && u.Query().Get("return") != "" {
			back, _ := url.Parse(u.Query().Get("return"))
			if back == nil || back.Path == "" || back.Host != "" {
				t.Errorf("%s: return %q does not parse back", c.in, u.Query().Get("return"))
			}
		}
	}
}
