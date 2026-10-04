package main

// =============================================================================
// AB1 (bugs-2): Drive's Ctrl+A in a big folder, then Download or Compress.
// Every path rode in the address: ~1,300 long names passed the 64 KiB header
// cap and the server answered 431, every time. The list may now come in a
// JSON body {"paths": [...]}; the old ?paths= form still works.
// =============================================================================

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// bigPick writes n files with long photo-like names into files/Fotos and
// answers their API paths.
func bigPick(t *testing.T, srv *Server, n int) []string {
	t.Helper()
	dir := filepath.Join(srv.cfg.HomesDir, "ana", "files", "Fotos")
	os.MkdirAll(dir, 0o755)
	out := make([]string, n)
	for i := range out {
		name := fmt.Sprintf("IMG_20250812_%06d_vacaciones_en_la_playa.jpg", i)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("jpeg"), 0o644); err != nil {
			t.Fatal(err)
		}
		out[i] = "files/Fotos/" + name
	}
	return out
}

// postPaths sends `paths` in a JSON body and answers the status and the answer.
func postPaths(t *testing.T, client *http.Client, url string, paths []string, headers map[string]string) (int, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"paths": paths})
	h := map[string]string{"Content-Type": "application/json"}
	for k, v := range headers {
		h[k] = v
	}
	resp := do(t, client, "POST", url, strings.NewReader(string(body)), h)
	defer resp.Body.Close()
	var answer map[string]any
	json.NewDecoder(resp.Body).Decode(&answer)
	return resp.StatusCode, answer
}

func TestBug_AB1_CompressBodyPaths(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	paths := bigPick(t, srv, 1300)

	// The old address form: what Drive sent, refused as too long.
	if code, _ := compress(t, client, ts.URL, paths...); code == http.StatusOK {
		t.Logf("note: the address form of 1,300 paths passed (%d)", code)
	}

	code, got := postPaths(t, client, ts.URL+"/api/zip", paths, nil)
	if code != http.StatusOK || got["files"] != 1300.0 {
		t.Fatalf("compress of 1,300 paths in the body = %d %v, want 200 and 1300 files", code, got)
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana", got["path"].(string))); err != nil {
		t.Errorf("the zip is not there: %v", err)
	}

	// A short pick still goes in the address, as an old page sends it.
	if code, got := compress(t, client, ts.URL, paths[0]); code != http.StatusOK {
		t.Errorf("compress by ?paths= = %d %v", code, got)
	}
	// An empty body list is refused, as an empty ?paths= is.
	if code, _ := postPaths(t, client, ts.URL+"/api/zip", nil, nil); code != http.StatusBadRequest {
		t.Errorf("compress of no paths = %d, want 400", code)
	}
}

func TestBug_AB1_CompressBodyOwnerCheck(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	paths := bigPick(t, srv, 3)

	// A page of another account (L5): refused, whichever form the list takes.
	code, _ := postPaths(t, client, ts.URL+"/api/zip", paths,
		map[string]string{whoHeader: whoValue("user", "beto")})
	if code != http.StatusLocked {
		t.Errorf("compress (body) from beto's page under ana's session = %d, want 423", code)
	}
	code, _ = postPaths(t, client, ts.URL+"/api/zip", paths,
		map[string]string{whoHeader: whoValue("user", "ana")})
	if code != http.StatusOK {
		t.Errorf("compress (body) from ana's own page = %d, want 200", code)
	}
}

// An "Extract here" (?file=) that says it carries JSON is still an extract,
// not a Compress of an empty list.
func TestBug_AB1_ExtractWithJSONType(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	os.WriteFile(filepath.Join(srv.cfg.HomesDir, "ana", "files", "caja.zip"), makeZip(t, file("dentro.txt", "hola")), 0o644)

	resp := do(t, client, "POST", ts.URL+"/api/zip?file=files/caja.zip", strings.NewReader("{}"),
		map[string]string{"Content-Type": "application/json"})
	var got map[string]any
	json.NewDecoder(resp.Body).Decode(&got)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || got["path"] != "files/caja" {
		t.Errorf("extract with a JSON content type = %d %v, want 200 and files/caja", resp.StatusCode, got)
	}
}

func TestBug_AB1_DownloadBodyPaths(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	paths := bigPick(t, srv, 1300)

	code, job := postPaths(t, client, ts.URL+"/api/download", paths, nil)
	if code != http.StatusOK || job["files"] != 1300.0 {
		t.Fatalf("download of 1,300 paths in the body = %d %v, want 200 and 1300 files", code, job)
	}
	resp, body := dlGet(t, client, ts.URL, job["id"].(string))
	if resp.StatusCode != http.StatusOK || len(unzipAll(t, body)) != 1300 {
		t.Errorf("the zip = %d, %d entries, want 1300", resp.StatusCode, len(unzipAll(t, body)))
	}

	// The address form still works.
	if code, got := dlPost(t, client, ts.URL, paths[0]); code != http.StatusOK || got["files"] != 1.0 {
		t.Errorf("download by ?paths= = %d %v", code, got)
	}
	// A body that is not JSON: 400, nothing started.
	resp = do(t, client, "POST", ts.URL+"/api/download", strings.NewReader("{paths"),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("a broken body = %d, want 400", resp.StatusCode)
	}
}
