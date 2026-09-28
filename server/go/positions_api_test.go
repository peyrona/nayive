package main

// Photos and the location apps, placing the owner on their trips.

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
	evs := traceEvents(t, srv)

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
	for i := 0; i < 3; i++ { // all three read to the end
		waitEv(t, evs, "photo")
	}
	if _, err := os.Stat(positions); !os.IsNotExist(err) {
		t.Fatalf("a photo that should place nobody wrote positions: %+v", readPositionsDoc(tripDir))
	}

	put("files/fotos/porto/nueva.jpg", photo(fix))
	got := waitLatest(t, tripDir, func(l *tripPosition) bool { return l.Source == "photo" })
	if got.Lat != 41.158 || got.Lon != -8.629 || got.Acc != 12 || got.At != fix.Unix() {
		t.Errorf("stored %+v, want 41.158,-8.629 acc 12 at the fix time", got)
	}
}

func TestLocationApps(t *testing.T) {
	srv, base, client, link := makeLink(t)
	tripDir := filepath.Join(srv.cfg.HomesDir, "ana", publicTripDir)

	var k struct {
		URL     string `json:"url"`
		Created int64  `json:"created"`
	}
	resp := do(t, client, "POST", base+"/api/location", nil, nil)
	json.Unmarshal(readBody(t, resp), &k)
	if resp.StatusCode != http.StatusCreated || !strings.HasPrefix(k.URL, "/api/location/") || len(k.URL) < 50 {
		t.Fatalf("create: %d %+v", resp.StatusCode, k)
	}
	resp = do(t, client, "POST", base+"/api/location", nil, nil)
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

	// GPSLogger sends exactly the body its .properties file asks for.
	when := time.Now().Add(-time.Minute).Unix()
	code, body := report(k.URL+"/gpslogger", `{"lat":41.157944,"lon":-8.629105,"acc":8,"tst":`+itoa64(when)+`}`)
	if code != http.StatusOK || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("gpslogger: %d %q", code, body)
	}
	got := waitLatest(t, tripDir, func(l *tripPosition) bool { return l.Source == "gpslogger" })
	if got.Lat != 41.158 || got.Lon != -8.629 || got.Acc != 8 || got.At != when {
		t.Errorf("stored %+v", got)
	}

	// Overland sends a BATCH, its coordinates are [lon, lat], its times are ISO
	// 8601 written two ways, and it only drops its copy for {"result":"ok"}.
	// The older point is far enough back to keep its own place in the route; the
	// newer one has to be better than the GPSLogger position above to replace it,
	// which is the accuracy rule, not this endpoint (see positions.go).
	old := time.Now().Add(-20 * time.Minute)
	recent := time.Now().Add(-20 * time.Second)
	batch := `{"locations":[` +
		`{"type":"Feature","geometry":{"type":"Point","coordinates":[-122.030581,37.331800]},` +
		`"properties":{"timestamp":"` + old.UTC().Format(time.RFC3339) + `","horizontal_accuracy":-1}},` +
		`{"type":"Feature","geometry":{"type":"Point","coordinates":[-122.4,37.79]},` +
		`"properties":{"timestamp":"` + recent.Format("2006-01-02T15:04:05-0700") + `","horizontal_accuracy":5}}]}`
	if code, body = report(k.URL+"/overland", batch); code != http.StatusOK || body != `{"result":"ok"}` {
		t.Fatalf("overland: %d %q, want 200 and {\"result\":\"ok\"}", code, body)
	}
	got = waitLatest(t, tripDir, func(l *tripPosition) bool { return l.Source == "overland" })
	if got.Lat != 37.79 || got.Lon != -122.4 || got.Acc != 5 || got.At != recent.Unix() {
		t.Errorf("overland latest %+v", got) // lat/lon swapped, or the "-0700" time layout unread
	}
	inRoute, accLess := 0, false
	for _, p := range readPositionsDoc(tripDir).Positions {
		if p.Source != "overland" {
			continue
		}
		inRoute++
		if p.At == old.Unix() && p.Acc == accApp {
			accLess = true // a point with no accuracy of its own counts as an app's
		}
	}
	if inRoute != 2 || !accLess {
		t.Errorf("the batch left %d overland points in the route (want 2), accuracy-less one read back: %v", inRoute, accLess)
	}

	// The GPSLogger profile: its own setting names, and the URL it must send to.
	resp = do(t, app, "GET", base+k.URL+"/gpslogger.properties", nil, nil)
	profile := string(readBody(t, resp))
	if resp.StatusCode != http.StatusOK || !strings.Contains(resp.Header.Get("Content-Type"), "text/plain") {
		t.Fatalf("profile: %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	for _, want := range []string{"log_customurl_enabled=true", `log_customurl_body={"lat":%LAT`, k.URL + "/gpslogger\n"} {
		if !strings.Contains(profile, want) {
			t.Errorf("the profile has no %q:\n%s", want, profile)
		}
	}

	// A link is not what keeps positions: with it stopped, the trip still takes them...
	resp = do(t, client, "DELETE", base+"/api/shares?id="+link.ID, nil, nil)
	readBody(t, resp)
	later := time.Now().Unix()
	report(k.URL+"/gpslogger", `{"lat":41.15,"lon":-8.62,"acc":3,"tst":`+itoa64(later)+`}`)
	if l := readPositionsDoc(tripDir).Latest; l == nil || l.At != later {
		t.Errorf("a trip without a link did not take the position: %+v", l)
	}

	// ...and a trip switched off in Trips takes nothing.
	tripJSON := filepath.Join(tripDir, "trip.json")
	var doc map[string]any
	raw, _ := os.ReadFile(tripJSON)
	json.Unmarshal(raw, &doc)
	doc["track"] = false
	raw, _ = json.Marshal(doc)
	os.WriteFile(tripJSON, raw, 0o644)
	report(k.URL+"/gpslogger", `{"lat":41.15,"lon":-8.62,"acc":3,"tst":`+itoa64(later+20)+`}`)
	if l := readPositionsDoc(tripDir).Latest; l == nil || l.At != later {
		t.Errorf("a trip switched off took a position: %+v", l)
	}

	// Junk is accepted and ignored: refusing it would only be retried forever.
	for _, msg := range []string{`{"lat":null,"lon":null}`, `not json`} {
		if code, body := report(k.URL+"/gpslogger", msg); code != http.StatusOK || !strings.Contains(body, `"ok":true`) {
			t.Errorf("%s: %d %q", msg, code, body)
		}
	}
	if code, body := report(k.URL+"/overland", `not json`); code != http.StatusOK || body != `{"result":"ok"}` {
		t.Errorf("overland junk: %d %q", code, body)
	}

	if code, _ := report("/api/location/"+strings.Repeat("A", 43)+"/gpslogger", `{"lat":1,"lon":1}`); code != http.StatusUnauthorized {
		t.Errorf("wrong key: %d, want 401", code)
	}
	if code, _ := report(k.URL+"/nosuchapp", `{"lat":1,"lon":1}`); code != http.StatusNotFound {
		t.Errorf("unknown app: %d, want 404", code)
	}
	resp = do(t, app, "GET", base+k.URL+"/gpslogger", nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET on the app's URL: %d, want 405", resp.StatusCode)
	}

	// Turned off, every ending of the URL stops working.
	resp = do(t, client, "DELETE", base+"/api/location", nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("turn off: %d", resp.StatusCode)
	}
	for _, target := range []string{k.URL + "/gpslogger", k.URL + "/overland"} {
		if code, _ := report(target, `{"lat":41.1,"lon":-8.6}`); code != http.StatusUnauthorized {
			t.Errorf("%s after turning off: %d, want 401", target, code)
		}
	}

	for name, c := range map[string]*http.Client{
		"anonymous": anonymous(),
		"admin":     signedInClient(t, base, "jefe", "secreto"),
	} {
		resp := do(t, c, "GET", base+"/api/location", nil, nil)
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
