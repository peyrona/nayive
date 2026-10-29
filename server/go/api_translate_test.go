package main

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// trFake swaps the internet for a fixed answer and records the URLs asked for.
func trFake(t *testing.T, status int, body string) *[]string {
	t.Helper()
	var asked []string
	bmSetFor(t, &trGet, func(_ context.Context, u string) (*http.Response, error) {
		asked = append(asked, u)
		return &http.Response{StatusCode: status, ContentLength: int64(len(body)),
			Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	})
	return &asked
}

func trURL(base, f string) string { return base + "/api/translate/model?f=" + url.QueryEscape(f) }

const trOK = "main-workspace/translations-models/20261006203645--d9266c59-4798-4467-8e1a-5bbaf1dfd19f.bin"

// Only signed-in GETs for a model file's path reach Mozilla's CDN.
func TestTranslateRefuses(t *testing.T) {
	_, ts, client := newTestServer(t)
	asked := trFake(t, http.StatusOK, "model")

	if code, _ := bmGet(t, client, trURL(ts.URL, trOK)); code != http.StatusUnauthorized {
		t.Fatalf("no session: %d, want 401", code)
	}
	signIn(t, client, ts.URL, "ana", "abc")
	for _, f := range []string{
		"",
		"https://evil.com/x.bin",
		"main-workspace/translations-wasm/abc.wasm",         // not a model
		"main-workspace/translations-models/../../etc.bin",  // a way out
		"main-workspace/translations-models/a/b.bin",        // a sub-folder
		"main-workspace/translations-models/abc.bin?x=1",    // a query
		"main-workspace/translations-models/abc.html",       // another kind
		"/main-workspace/translations-models/abc.bin",       // a leading slash
		"main-workspace/translations-models/abc.bin\n.html", // a new line
	} {
		if code, _ := bmGet(t, client, trURL(ts.URL, f)); code != http.StatusBadRequest {
			t.Errorf("%q: %d, want 400", f, code)
		}
	}
	if code, _ := bmGet(t, client, ts.URL+"/api/translate/other?f="+url.QueryEscape(trOK)); code != http.StatusNotFound {
		t.Errorf("unknown call: %d, want 404", code)
	}
	if len(*asked) != 0 {
		t.Fatalf("%d fetches for refused paths: %v", len(*asked), *asked)
	}
}

// A good path streams the CDN's answer back as bytes; a CDN error is a 502.
func TestTranslateStreams(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	asked := trFake(t, http.StatusOK, "model-bytes")

	resp, err := client.Get(trURL(ts.URL, trOK))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(b) != "model-bytes" {
		t.Fatalf("got %d %q", resp.StatusCode, b)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("Content-Type %q", ct)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox") {
		t.Errorf("CSP %q", csp)
	}
	if len(*asked) != 1 || (*asked)[0] != trHost+trOK {
		t.Fatalf("asked %v", *asked)
	}

	trFake(t, http.StatusNotFound, "gone")
	if code, _ := bmGet(t, client, trURL(ts.URL, trOK)); code != http.StatusBadGateway {
		t.Fatalf("CDN 404: %d, want 502", code)
	}
}

// The Language settings: every account reads them, only the admin writes.
func TestTranslateConfig(t *testing.T) {
	_, ts, client := newTestServer(t)
	cfgURL := ts.URL + "/api/translate/config"
	const body = `{"engines":{"mymemory":{"enabled":false}},"custom":[{"id":"lingva-x","adapter":"lingva"}],"dictionaries":{"tatoeba":{"enabled":false}}}`

	if code, _ := callJSON(t, client, "GET", cfgURL, ""); code != http.StatusUnauthorized {
		t.Fatalf("no session: %d, want 401", code)
	}
	signIn(t, client, ts.URL, "ana", "abc")
	if code, got := callJSON(t, client, "GET", cfgURL, ""); code != http.StatusOK || strings.TrimSpace(string(got)) != "{}" {
		t.Fatalf("nothing saved: %d %s, want 200 {}", code, got)
	}
	if code, _ := callJSON(t, client, "PUT", cfgURL, body); code != http.StatusForbidden {
		t.Fatalf("a user's PUT: %d, want 403", code)
	}

	signIn(t, client, ts.URL, "jefe", "secreto")
	jsonCall(t, client, "PUT", cfgURL, body, http.StatusOK, nil)
	if code, _ := callJSON(t, client, "PUT", cfgURL, `{"engines":[1]}`); code != http.StatusBadRequest {
		t.Errorf("bad shape: %d, want 400", code)
	}

	signIn(t, client, ts.URL, "ana", "abc")
	var got struct {
		Engines      map[string]map[string]any `json:"engines"`
		Custom       []map[string]any          `json:"custom"`
		Dictionaries map[string]map[string]any `json:"dictionaries"`
	}
	jsonCall(t, client, "GET", cfgURL, "", http.StatusOK, &got)
	if got.Engines["mymemory"]["enabled"] != false || len(got.Custom) != 1 || got.Dictionaries["tatoeba"]["enabled"] != false {
		t.Fatalf("read back: %+v", got)
	}
}
