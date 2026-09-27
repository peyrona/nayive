package main

// =============================================================================
// /api/download - Drive's "Download" (api_download.go).
// =============================================================================

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// dlPost starts a download of `paths` and answers the status and the answer.
func dlPost(t *testing.T, client *http.Client, base string, paths ...string) (int, map[string]any) {
	t.Helper()
	q := url.Values{}
	for _, p := range paths {
		q.Add("paths", p)
	}
	return callZip(t, client, "POST", base+"/api/download?"+q.Encode())
}

// dlGet fetches a job's bytes, as the browser's downloader would.
func dlGet(t *testing.T, client *http.Client, base, id string) (*http.Response, []byte) {
	t.Helper()
	resp := do(t, client, "GET", base+"/api/download?id="+url.QueryEscape(id), nil, nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}

func dlProgress(t *testing.T, client *http.Client, base, id string) (int, map[string]any) {
	t.Helper()
	return callZip(t, client, "GET", base+"/api/download?progress=1&id="+url.QueryEscape(id))
}

// TestDownload - one file goes out as it is, anything else as one zip made on
// the fly, and the progress says how far it got.
func TestDownload(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	fotos := filepath.Join(files, "Fotos")
	os.MkdirAll(filepath.Join(fotos, "viaje"), 0o755)
	os.WriteFile(filepath.Join(fotos, "x.jpg"), []byte("jpeg"), 0o644)
	os.WriteFile(filepath.Join(fotos, "viaje", "y.txt"), []byte(strings.Repeat("y", 1000)), 0o644)
	os.WriteFile(filepath.Join(fotos, ".upload-abcdefgh"), []byte("a medias"), 0o600)
	os.WriteFile(filepath.Join(files, "nota ñ.txt"), []byte("nota"), 0o644)

	// ONE FILE: as it is, as an attachment, and resumable.
	code, job := dlPost(t, client, ts.URL, "files/nota ñ.txt")
	if code != http.StatusOK || job["name"] != "nota ñ.txt" || job["total"] != 4.0 || job["files"] != 1.0 {
		t.Fatalf("POST one file = %d %v", code, job)
	}
	id := job["id"].(string)
	if code, p := dlProgress(t, client, ts.URL, id); code != http.StatusOK || p["state"] != dlWaiting {
		t.Errorf("progress before the GET = %d %v", code, p)
	}
	resp, body := dlGet(t, client, ts.URL, id)
	if resp.StatusCode != http.StatusOK || string(body) != "nota" {
		t.Fatalf("GET one file = %d %q", resp.StatusCode, body)
	}
	if cd := resp.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment;") ||
		!strings.Contains(cd, "UTF-8''nota%20%C3%B1.txt") {
		t.Errorf("Content-Disposition = %q", cd)
	}
	if _, p := dlProgress(t, client, ts.URL, id); p["state"] != dlDone || p["sent"] != 4.0 || p["done"] != 1.0 {
		t.Errorf("progress after the GET = %v", p)
	}
	if resp, _ := dlGet(t, client, ts.URL, id); resp.StatusCode != http.StatusOK {
		t.Errorf("a file fetched again (a resume) = %d", resp.StatusCode)
	}

	// A FOLDER: one zip, the shape Compress gives; the temp is left out.
	code, job = dlPost(t, client, ts.URL, "files/Fotos")
	if code != http.StatusOK || job["name"] != "Fotos.zip" || job["files"] != 2.0 || job["total"] != 1004.0 {
		t.Fatalf("POST a folder = %d %v", code, job)
	}
	id = job["id"].(string)
	resp, body = dlGet(t, client, ts.URL, id)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/zip" {
		t.Fatalf("GET a folder = %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	got := unzipAll(t, body)
	want := map[string]string{"Fotos/": "", "Fotos/viaje/": "",
		"Fotos/x.jpg": "jpeg", "Fotos/viaje/y.txt": strings.Repeat("y", 1000)}
	if len(got) != len(want) {
		t.Errorf("zip holds %v, want %v", got, want)
	}
	for k, v := range want {
		if b, ok := got[k]; !ok || b != v {
			t.Errorf("%s = %q (in zip: %v)", k, b, ok)
		}
	}
	if _, p := dlProgress(t, client, ts.URL, id); p["state"] != dlDone || p["sent"] != 1004.0 || p["done"] != 2.0 {
		t.Errorf("progress after the zip = %v", p)
	}
	if resp, _ := dlGet(t, client, ts.URL, id); resp.StatusCode != http.StatusConflict {
		t.Errorf("a zip fetched twice = %d, want 409", resp.StatusCode)
	}

	// SEVERAL ITEMS: named after the folder they are in; "Drive" at the top.
	if _, job := dlPost(t, client, ts.URL, "files/Fotos/x.jpg", "files/Fotos/viaje"); job["name"] != "Fotos.zip" {
		t.Errorf("several in Fotos = %v", job)
	}
	_, job = dlPost(t, client, ts.URL, "files/nota ñ.txt", "files/Fotos")
	if job["name"] != "Drive.zip" || job["files"] != 3.0 {
		t.Errorf("several at the top = %v", job)
	}
	resp, body = dlGet(t, client, ts.URL, job["id"].(string))
	if got := unzipAll(t, body); resp.StatusCode != http.StatusOK || got["nota ñ.txt"] != "nota" || got["Fotos/x.jpg"] != "jpeg" {
		t.Errorf("several at the top: %d %v", resp.StatusCode, got)
	}

	// A STOP before the browser fetched it.
	_, job = dlPost(t, client, ts.URL, "files/Fotos")
	id = job["id"].(string)
	if code, _ := callZip(t, client, "DELETE", ts.URL+"/api/download?id="+id); code != http.StatusOK {
		t.Errorf("DELETE = %d", code)
	}
	if _, p := dlProgress(t, client, ts.URL, id); p["state"] != dlStopped {
		t.Errorf("progress after a stop = %v", p)
	}
	if resp, _ := dlGet(t, client, ts.URL, id); resp.StatusCode != http.StatusConflict {
		t.Errorf("a stopped zip fetched = %d, want 409", resp.StatusCode)
	}
}

// TestDownloadRefusals - bad paths answer JSON at the POST; a job is its
// user's alone.
func TestDownloadRefusals(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	for _, c := range []struct {
		paths []string
		want  int
	}{
		{[]string{""}, http.StatusBadRequest},
		{[]string{"files/nada"}, http.StatusNotFound},
		{[]string{"../../etc/passwd"}, http.StatusForbidden},
		{[]string{"../beto/files/suyo.txt"}, http.StatusForbidden},
	} {
		if code, a := dlPost(t, client, ts.URL, c.paths...); code != c.want {
			t.Errorf("POST %v = %d %v, want %d", c.paths, code, a, c.want)
		}
	}
	if code, _ := dlProgress(t, client, ts.URL, "nada"); code != http.StatusNotFound {
		t.Errorf("an unknown id = %d, want 404", code)
	}

	// Ana's job, asked for by Beto.
	_, job := dlPost(t, client, ts.URL, "files")
	id, _ := job["id"].(string)
	if id == "" {
		t.Fatalf("POST files = %v", job)
	}
	other := signedInClient(t, ts.URL, "beto", "xyz")
	if code, _ := dlProgress(t, other, ts.URL, id); code != http.StatusNotFound {
		t.Errorf("another user's progress = %d, want 404", code)
	}
	if resp, _ := dlGet(t, other, ts.URL, id); resp.StatusCode != http.StatusNotFound {
		t.Errorf("another user's bytes = %d, want 404", resp.StatusCode)
	}
	if code, _ := callZip(t, other, "DELETE", ts.URL+"/api/download?id="+id); code != http.StatusNotFound {
		t.Errorf("another user's stop = %d, want 404", code)
	}
}

// TestDownloadStop - a stop half way BREAKS the download: the browser must
// never be handed half a zip that looks whole.
func TestDownloadStop(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(files, "big"), 0o755)
	// Stored (.jpg) and far past the socket buffers, so the GET is still
	// writing when the stop comes.
	os.WriteFile(filepath.Join(files, "big", "a.jpg"), bytes.Repeat([]byte{7}, 64<<20), 0o644)

	for _, path := range []string{"files/big", "files/big/a.jpg"} {
		_, job := dlPost(t, client, ts.URL, path)
		id := job["id"].(string)

		resp := do(t, client, "GET", ts.URL+"/api/download?id="+id, nil, nil)
		head := make([]byte, 1<<20)
		if _, err := io.ReadFull(resp.Body, head); err != nil {
			t.Fatalf("%s: first MB: %v", path, err)
		}
		if _, p := dlProgress(t, client, ts.URL, id); p["state"] != dlRunning {
			t.Errorf("%s: progress while it runs = %v", path, p)
		}
		callZip(t, client, "DELETE", ts.URL+"/api/download?id="+id)
		_, err := io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if err == nil {
			t.Errorf("%s: a stopped download ended cleanly - the browser would keep it", path)
		}

		var p map[string]any
		for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
			if _, p = dlProgress(t, client, ts.URL, id); p["state"] != dlRunning {
				break
			}
		}
		if p["state"] != dlStopped {
			t.Errorf("%s: after the stop = %v", path, p)
		}
	}
}

func unzipAll(t *testing.T, data []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("%s: %v", f.Name, err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(b)
	}
	return out
}
