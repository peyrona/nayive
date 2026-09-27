package main

// =============================================================================
// A user's HTML/SVG, and a static site, must not run script as Nayive
// (audits #11, #12).
// =============================================================================

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestUserFilesAreSandboxed: a page-like file out of the file API goes out
// under "CSP: sandbox" - opened in a tab, its script cannot run as whoever
// opened it. Everything else, and the apps themselves, go out without it.
func TestUserFilesAreSandboxed(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	for name, body := range map[string]string{
		"files/p.html": "<script>alert(1)</script>",
		"files/p.htm":  "<script>alert(1)</script>",
		"files/p.svg":  `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
		"files/p.xml":  `<x/>`,
		"files/p.txt":  "plain",
		"files/p.pdf":  "%PDF-1.4",
		"files/p.png":  "png",
	} {
		resp := do(t, client, "PUT", ts.URL+"/api/files?file="+name,
			strings.NewReader(body), nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("PUT %s = %d", name, resp.StatusCode)
		}
	}

	for name, sandboxed := range map[string]bool{
		"files/p.html": true, "files/p.htm": true, "files/p.svg": true, "files/p.xml": true,
		"files/p.txt": false, "files/p.pdf": false, "files/p.png": false,
	} {
		for _, method := range []string{"GET", "HEAD"} {
			resp := do(t, client, method, ts.URL+"/api/files?file="+name, nil, nil)
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			csp := resp.Header.Get("Content-Security-Policy")
			if sandboxed && csp != "sandbox" {
				t.Errorf("%s %s: CSP %q, want \"sandbox\"", method, name, csp)
			}
			if !sandboxed && csp != "" {
				t.Errorf("%s %s: CSP %q, want none", method, name, csp)
			}
		}
	}

	// The apps are HTML too, and must keep running.
	for _, page := range []string{"/nayive/index.html", "/nayive/login.html"} {
		resp := do(t, client, "GET", ts.URL+page, nil, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s = %d", page, resp.StatusCode)
		}
		if csp := resp.Header.Get("Content-Security-Policy"); csp != "" {
			t.Errorf("app page %s carries CSP %q", page, csp)
		}
	}
}

// TestSitesAreSandboxed: a static site's pages run their script in an opaque
// origin - never Nayive's, so they cannot call /api/* with the visitor's
// session - and its files carry Access-Control-Allow-Origin so that page can
// still load its own fonts and data.
func TestSitesAreSandboxed(t *testing.T) {
	_, base, client := newSitesServer(t)

	for _, c := range []struct {
		path      string
		sandboxed bool
	}{
		{"/cv/", true},
		{"/cv/index.html", true},
		{"/cv/style.css", false},
		{"/cv/sub/nota.txt", false},
	} {
		resp := do(t, client, "GET", base+c.path, nil, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s = %d", c.path, resp.StatusCode)
		}
		csp := resp.Header.Get("Content-Security-Policy")
		if c.sandboxed {
			if !strings.HasPrefix(csp, "sandbox ") || !strings.Contains(csp, "allow-scripts") ||
				strings.Contains(csp, "allow-same-origin") {
				t.Errorf("%s: CSP %q, want a sandbox with scripts and no same-origin", c.path, csp)
			}
		} else if csp != "" {
			t.Errorf("%s: CSP %q, want none", c.path, csp)
		}
		if acao := resp.Header.Get("Access-Control-Allow-Origin"); acao != "*" {
			t.Errorf("%s: Access-Control-Allow-Origin %q, want *", c.path, acao)
		}
	}
}
