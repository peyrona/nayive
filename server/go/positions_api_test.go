package main

// Photos and the OwnTracks app, placing the owner of a linked trip.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// waitLatest polls a trip's positions until `ok` holds, or fails after 3 s: the
// photo is read on its own goroutine, after the upload has been answered.
func waitLatest(t *testing.T, tripDir string, ok func(*tripPosition) bool) *tripPosition {
	t.Helper()
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
		if l := readPositionsDoc(tripDir).Latest; l != nil && ok(l) {
			return l
		}
	}
	t.Fatalf("no such position arrived; file holds %+v", readPositionsDoc(tripDir))
	return nil
}

func TestPhotoUploadPlacesOwner(t *testing.T) {
	srv, base, client, _ := makeLink(t)
	tripDir := filepath.Join(srv.cfg.HomesDir, "ana", publicTripDir)
	positions := filepath.Join(tripDir, tripPositionsFile)

	put := func(path string, data []byte) {
		t.Helper()
		resp := do(t, client, "PUT", base+"/api/files?file="+url.QueryEscape(path), bytes.NewReader(data), nil)
		body := readBody(t, resp)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("PUT %s: %d %s", path, resp.StatusCode, body)
		}
	}
	photo := func(fix time.Time) []byte {
		return exifJPEG(t, nil, gpsEntries(41.157944, -8.629105, fix, 12))
	}
	fix := time.Now().Add(-time.Hour).Truncate(time.Second)

	put("files/otras/fuera.jpg", photo(fix))                                 // not the trip's photo folder
	put("files/fotos/porto/vieja.jpg", photo(time.Now().AddDate(0, 0, -10))) // before the trip
	put("files/fotos/porto/sin-gps.jpg", exifJPEG(t, []ifdEntry{asciiEntry(0x9003, "2026:09:14 10:00:00")}, nil))
	time.Sleep(400 * time.Millisecond)
	if _, err := os.Stat(positions); !os.IsNotExist(err) {
		t.Fatalf("a photo that should place nobody wrote positions: %+v", readPositionsDoc(tripDir))
	}

	put("files/fotos/porto/nueva.jpg", photo(fix))
	got := waitLatest(t, tripDir, func(l *tripPosition) bool { return l.Source == "photo" })
	if got.Lat != 41.158 || got.Lon != -8.629 || got.Acc != 12 || got.At != fix.Unix() {
		t.Errorf("stored %+v, want 41.158,-8.629 acc 12 at the fix time", got)
	}
}

func TestOwnTracks(t *testing.T) {
	srv, base, client, _ := makeLink(t)
	tripDir := filepath.Join(srv.cfg.HomesDir, "ana", publicTripDir)

	var k struct {
		URL     string `json:"url"`
		Created int64  `json:"created"`
	}
	resp := do(t, client, "POST", base+"/api/owntracks", nil, nil)
	json.Unmarshal(readBody(t, resp), &k)
	if resp.StatusCode != http.StatusCreated || !strings.HasPrefix(k.URL, "/api/owntracks/") || len(k.URL) < 50 {
		t.Fatalf("create: %d %+v", resp.StatusCode, k)
	}
	resp = do(t, client, "POST", base+"/api/owntracks", nil, nil)
	var again struct{ URL string }
	json.Unmarshal(readBody(t, resp), &again)
	if resp.StatusCode != http.StatusOK || again.URL != k.URL {
		t.Errorf("second create: %d %q, want 200 and the same URL", resp.StatusCode, again.URL)
	}

	app := anonymous()
	report := func(target, body string) (int, string) {
		t.Helper()
		resp := do(t, app, "POST", base+target, strings.NewReader(body),
			map[string]string{"Content-Type": "application/json"})
		return resp.StatusCode, string(readBody(t, resp))
	}

	when := time.Now().Add(-time.Minute).Unix()
	code, body := report(k.URL, `{"_type":"location","lat":41.157944,"lon":-8.629105,"acc":8,"tst":`+
		itoa64(when)+`,"tid":"an","batt":80}`)
	if code != http.StatusOK || body != "[]" {
		t.Fatalf("location: %d %q, want 200 []", code, body)
	}
	got := waitLatest(t, tripDir, func(l *tripPosition) bool { return l.Source == "owntracks" })
	if got.Lat != 41.158 || got.Lon != -8.629 || got.Acc != 8 || got.At != when {
		t.Errorf("stored %+v", got)
	}

	// Anything but a location is accepted and ignored - and so is junk.
	for _, msg := range []string{`{"_type":"transition","event":"enter"}`, `{"_type":"encrypted","data":"x"}`, `not json`} {
		if code, body := report(k.URL, msg); code != http.StatusOK || body != "[]" {
			t.Errorf("%s: %d %q", msg, code, body)
		}
	}

	if code, _ := report("/api/owntracks/"+strings.Repeat("A", 43), `{"_type":"location","lat":1,"lon":1}`); code != http.StatusUnauthorized {
		t.Errorf("wrong key: %d, want 401", code)
	}
	resp = do(t, app, "GET", base+k.URL, nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET on the app's URL: %d, want 405", resp.StatusCode)
	}

	// Turned off, the URL stops working.
	resp = do(t, client, "DELETE", base+"/api/owntracks", nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("turn off: %d", resp.StatusCode)
	}
	if code, _ := report(k.URL, `{"_type":"location","lat":41.1,"lon":-8.6}`); code != http.StatusUnauthorized {
		t.Errorf("after turning off: %d, want 401", code)
	}

	for name, c := range map[string]*http.Client{
		"anonymous": anonymous(),
		"admin":     signedInClient(t, base, "jefe", "secreto"),
	} {
		resp := do(t, c, "GET", base+"/api/owntracks", nil, nil)
		readBody(t, resp)
		if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s: %d", name, resp.StatusCode)
		}
	}

	// A deleted or renamed user takes the key along.
	key, _ := srv.trackers.Create("ana")
	srv.trackers.RenameUser("ana", "anabel")
	if srv.trackers.OwnerOf(key.Key) != "anabel" {
		t.Error("the key did not follow the rename")
	}
	srv.trackers.DropUser("anabel")
	if srv.trackers.OwnerOf(key.Key) != "" {
		t.Error("the key outlived its user")
	}
}
