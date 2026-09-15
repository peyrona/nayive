package main

// =============================================================================
// Public trip links: what a stranger with the link gets, and what they never do.
// =============================================================================

import (
	"bytes"
	"encoding/json"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const publicTripDir = "data/trips/portugal-2026"

// publicFixture is ana's trip: two stages already started, one still to come,
// one switched off, private fields that must never leave, and a photo folder
// with a GPS-tagged JPEG, a PNG, things that are not photos, and a sub-folder.
func publicFixture(t *testing.T, srv *Server) {
	t.Helper()
	home := filepath.Join(srv.cfg.HomesDir, "ana")
	writeJSON := func(rel string, v any) {
		path := filepath.Join(home, rel)
		os.MkdirAll(filepath.Dir(path), 0o755)
		raw, _ := json.Marshal(v)
		if err := os.WriteFile(path, raw, 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	writeFile := func(rel string, data []byte) {
		path := filepath.Join(home, rel)
		os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}

	writeTripDates(t, srv, -2, 2)

	photo, _ := gpsJPEG(t)
	writeFile("files/fotos/porto/a.jpg", photo)
	writeFile("files/fotos/porto/b.png", []byte("png"))
	writeFile("files/fotos/porto/notas.txt", []byte("not a photo"))
	writeFile("files/fotos/porto/dibujo.svg", []byte("<svg onload='alert(1)'/>"))
	writeFile("files/fotos/porto/sub/c.jpg", plainJPEG(t))
	writeFile("files/secreto.jpg", plainJPEG(t))
	os.Symlink(filepath.Join(home, "files", "secreto.jpg"),
		filepath.Join(home, "files", "fotos", "porto", "enlace.jpg"))

	info, err := os.Stat(filepath.Join(home, "files/fotos/porto/a.jpg"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	size, mtime := info.Size(), info.ModTime().Unix()
	writeJSON("data/photos/scan-cache.json", map[string]any{
		"files/fotos/porto/a.jpg": map[string]any{"size": size, "mtime": mtime, "ts": 1757000000000,
			"lat": 41.157944, "lon": -8.629105},
		"files/fotos/porto/b.png": map[string]any{"size": 999, "mtime": 1, "lat": 10.5, "lon": 10.5}, // stale
	})
	writeJSON("data/photos/comments.json", map[string]any{"files/fotos/porto/a.jpg": "Hola desde Porto"})
	writeFile("data/photos/thumbs/"+thumbName(size, mtime), []byte("THUMB"))
}

// writeTripDates (re)writes the trip so it runs from today+from to today+to.
func writeTripDates(t *testing.T, srv *Server, from, to int) {
	t.Helper()
	day := func(d int) string { return time.Now().AddDate(0, 0, d).Format("2006-01-02") }
	trip := map[string]any{
		"id": "t1", "destination": "Portugal", "startDate": day(from), "endDate": day(to),
		"photosDir": "files/fotos/porto",
		"notes":     "SECRETO-NOTA",
		"documents": []any{map[string]any{"kind": "link", "path": "files/mio.txt", "name": "SECRETO-BILLETE"}},
		"stages": []any{
			map[string]any{"id": "s1", "location": "Porto", "startDate": day(from), "endDate": day(from + 1),
				"lat": 41.157944, "lon": -8.629105, "accommodation": "SECRETO-HOTEL"},
			map[string]any{"id": "s2", "location": "Lisboa", "startDate": day(from + 2), "endDate": day(from + 3),
				"startTime": "10:00", "lat": 38.722252, "lon": -9.139337},
			map[string]any{"id": "s3", "location": "SECRETO-FUTURO", "startDate": day(from + 3), "endDate": day(to),
				"lat": 37.0194, "lon": -7.9304},
			map[string]any{"id": "s4", "location": "SECRETO-APAGADO", "startDate": day(from), "endDate": day(from),
				"lat": 40.0, "lon": -8.0, "enabled": false},
		},
	}
	dir := filepath.Join(srv.cfg.HomesDir, "ana", publicTripDir)
	os.MkdirAll(dir, 0o755)
	raw, _ := json.Marshal(trip)
	if err := os.WriteFile(filepath.Join(dir, "trip.json"), raw, 0o644); err != nil {
		t.Fatalf("write trip: %v", err)
	}
}

// anonymous is a browser with no session at all.
func anonymous() *http.Client {
	return &http.Client{
		Transport:     &http.Transport{DisableCompression: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// readBody drains and closes a response.
func readBody(t *testing.T, resp *http.Response) []byte {
	t.Helper()
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return raw
}

// makeLink signs ana in and asks for the trip's link.
func makeLink(t *testing.T) (*Server, string, *http.Client, shareOut) {
	t.Helper()
	srv, ts, client := newTestServer(t)
	publicFixture(t, srv)
	signIn(t, client, ts.URL, "ana", "abc")

	resp := do(t, client, "POST", ts.URL+"/api/shares",
		strings.NewReader(`{"link":true,"root":"`+publicTripDir+`","title":"Portugal"}`),
		map[string]string{"Content-Type": "application/json"})
	raw := readBody(t, resp)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create link: %d %s", resp.StatusCode, raw)
	}
	var link shareOut
	json.Unmarshal(raw, &link)
	if len(link.Token) < 40 || link.URL != "/s/"+link.Token {
		t.Fatalf("bad link answer: %s", raw)
	}
	return srv, ts.URL, client, link
}

func getTrip(t *testing.T, base, token string) (publicTrip, string) {
	t.Helper()
	resp := do(t, anonymous(), "GET", base+"/api/public/"+token, nil, nil)
	raw := readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("manifest: %d %s", resp.StatusCode, raw)
	}
	var trip publicTrip
	if err := json.Unmarshal(raw, &trip); err != nil {
		t.Fatalf("manifest JSON: %v", err)
	}
	return trip, string(raw)
}

// -----------------------------------------------------------------------------
// making a link
// -----------------------------------------------------------------------------

func TestPublicLinkCreate(t *testing.T) {
	srv, base, client, link := makeLink(t)

	// One link per trip: asking again hands back the same one.
	resp := do(t, client, "POST", base+"/api/shares",
		strings.NewReader(`{"link":true,"root":"`+publicTripDir+`/"}`),
		map[string]string{"Content-Type": "application/json"})
	raw := readBody(t, resp)
	var again shareOut
	json.Unmarshal(raw, &again)
	if resp.StatusCode != http.StatusOK || again.Token != link.Token {
		t.Errorf("second request: %d, token %q, want 200 and the same token", resp.StatusCode, again.Token)
	}

	for root, want := range map[string]int{
		"files/fotos/porto":         http.StatusBadRequest, // not a trip
		"data/trips":                http.StatusBadRequest,
		"data/trips/nada":           http.StatusNotFound,
		"data/trips/../../beto/x":   http.StatusBadRequest,
		"shared/algo/trip":          http.StatusBadRequest,
		"data/trips/portugal-2026x": http.StatusNotFound,
	} {
		resp := do(t, client, "POST", base+"/api/shares",
			strings.NewReader(`{"link":true,"root":"`+root+`"}`),
			map[string]string{"Content-Type": "application/json"})
		readBody(t, resp)
		if resp.StatusCode != want {
			t.Errorf("link for %q: %d, want %d", root, resp.StatusCode, want)
		}
	}

	// The link is not a share with anybody: it never resolves as shared/<slug>.
	for _, g := range srv.shares.LinksByOwner("ana") {
		for _, who := range []string{"", "ana", "beto"} {
			if got, _ := srv.users.ResolvePath("user", who, "shared/"+g.Slug); got != "" {
				t.Errorf("the link resolved as a share for %q: %s", who, got)
			}
		}
	}
	if len(srv.shares.ForUser("")) != 0 {
		t.Error("a link shows up as shared with the empty user")
	}

	// The admin has no trips to link.
	admin := signedInClient(t, base, "jefe", "secreto")
	resp = do(t, admin, "POST", base+"/api/shares",
		strings.NewReader(`{"link":true,"root":"`+publicTripDir+`"}`),
		map[string]string{"Content-Type": "application/json"})
	readBody(t, resp)
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("admin link: %d, want 403", resp.StatusCode)
	}
}

// -----------------------------------------------------------------------------
// what the page gets
// -----------------------------------------------------------------------------

func TestPublicTripManifest(t *testing.T) {
	srv, base, _, link := makeLink(t)

	resp := do(t, anonymous(), "GET", base+"/api/public/"+link.Token, nil, nil)
	readBody(t, resp)
	if got := resp.Header.Get("X-Robots-Tag"); !strings.Contains(got, "noindex") {
		t.Errorf("X-Robots-Tag = %q", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache", got)
	}

	trip, raw := getTrip(t, base, link.Token)
	for _, secret := range []string{"SECRETO", `"ana"`, "files/", "mio.txt", "notas.txt", "dibujo.svg", "c.jpg", "enlace.jpg"} {
		if strings.Contains(raw, secret) {
			t.Errorf("the manifest gives away %q: %s", secret, raw)
		}
	}
	if trip.Title != "Portugal" {
		t.Errorf("title %q", trip.Title)
	}
	if len(trip.Stages) != 2 || trip.Stages[0].Location != "Porto" || trip.Stages[1].Location != "Lisboa" {
		t.Fatalf("stages %+v, want Porto and Lisboa only", trip.Stages)
	}
	if *trip.Stages[0].Lat != 41.158 || *trip.Stages[0].Lon != -8.629 {
		t.Errorf("Porto at %v,%v - not rounded to 3 decimals", *trip.Stages[0].Lat, *trip.Stages[0].Lon)
	}
	if len(trip.Route) != 2 || trip.Route[0].Place != "Porto" {
		t.Errorf("route %+v", trip.Route)
	}
	if trip.Now == nil || trip.Now.Source != "plan" || trip.Now.Place != "Lisboa" {
		t.Errorf("now = %+v, want the plan's Lisboa", trip.Now)
	}

	if len(trip.Photos) != 2 {
		t.Fatalf("photos %+v, want a.jpg and b.png", trip.Photos)
	}
	a, b := trip.Photos[0], trip.Photos[1]
	if a.Name != "a.jpg" || a.Comment != "Hola desde Porto" || !a.Thumb || a.TS != 1757000000000 {
		t.Errorf("a.jpg = %+v", a)
	}
	if a.Lat == nil || *a.Lat != 41.158 || *a.Lon != -8.629 {
		t.Errorf("a.jpg spot not rounded: %+v", a)
	}
	if b.Name != "b.png" || b.Thumb || b.Lat != nil {
		t.Errorf("b.png = %+v (its cache entry is stale, it has no thumbnail)", b)
	}

	// A fresh phone position is "now"; a stale one hands back to the plan.
	positions := filepath.Join(srv.cfg.HomesDir, "ana", publicTripDir, tripPositionsFile)
	writePositions := func(age time.Duration) {
		doc := positionsDoc{Positions: []tripPosition{
			{Lat: 41.14, Lon: -8.61, Place: "Oporto", At: time.Now().Add(-age).Unix()},
		}}
		raw, _ := json.Marshal(doc)
		os.WriteFile(positions, raw, 0o644)
	}
	writePositions(time.Hour)
	trip, _ = getTrip(t, base, link.Token)
	if trip.Now == nil || trip.Now.Source != "phone" || trip.Now.Place != "Oporto" {
		t.Errorf("now = %+v, want the phone's Oporto", trip.Now)
	}
	if len(trip.Route) != 3 || trip.Route[2].Kind != "phone" {
		t.Errorf("route %+v, want the two stages then the phone", trip.Route)
	}
	writePositions(13 * time.Hour)
	trip, _ = getTrip(t, base, link.Token)
	if trip.Now == nil || trip.Now.Source != "plan" {
		t.Errorf("now = %+v, want the plan once the phone is 13 h old", trip.Now)
	}

	// Once the trip is over there is no "now"; the route and photos stay.
	writeTripDates(t, srv, -10, -5)
	trip, _ = getTrip(t, base, link.Token)
	if trip.Now != nil {
		t.Errorf("now = %+v after the trip ended", trip.Now)
	}
	if len(trip.Photos) != 2 || len(trip.Stages) != 3 {
		t.Errorf("after the trip: %d photos, %d stages", len(trip.Photos), len(trip.Stages))
	}
}

func TestPublicPhotos(t *testing.T) {
	_, base, _, link := makeLink(t)
	anon := anonymous()
	url := base + "/api/public/" + link.Token

	resp := do(t, anon, "GET", url+"/photo/a.jpg", nil, nil)
	body := readBody(t, resp)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("a.jpg: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if _, err := jpeg.Decode(bytes.NewReader(body)); err != nil {
		t.Errorf("a.jpg does not decode: %v", err)
	}
	if n := binary16(exifTIFF(t, body)[testGPSIFD:]); n != 0 {
		t.Errorf("a.jpg still carries %d GPS entries", n)
	}
	if bytes.Contains(body, []byte("MOTIONPHOTO")) || bytes.Contains(body, []byte("GPSLatitude")) {
		t.Error("a.jpg carries its position after the image or in XMP")
	}

	resp = do(t, anon, "GET", url+"/photo/a.jpg", nil, map[string]string{"Range": "bytes=0-3"})
	part := readBody(t, resp)
	if resp.StatusCode != http.StatusPartialContent || !bytes.Equal(part, body[:4]) {
		t.Errorf("Range: %d %x", resp.StatusCode, part)
	}

	resp = do(t, anon, "GET", url+"/thumb/a.jpg", nil, nil)
	if got := readBody(t, resp); resp.StatusCode != http.StatusOK || string(got) != "THUMB" {
		t.Errorf("thumb/a.jpg: %d %q", resp.StatusCode, got)
	}
	resp = do(t, anon, "GET", url+"/photo/b.png", nil, nil)
	if got := readBody(t, resp); resp.StatusCode != http.StatusOK || string(got) != "png" {
		t.Errorf("photo/b.png: %d %q", resp.StatusCode, got)
	}

	for _, tail := range []string{
		"/thumb/b.png",            // no thumbnail
		"/photo/notas.txt",        // not a photo
		"/photo/dibujo.svg",       // an SVG runs script
		"/photo/sub%2Fc.jpg",      // not directly in the folder
		"/photo/c.jpg",            // ...nor by its bare name
		"/photo/secreto.jpg",      // elsewhere in files/
		"/photo/enlace.jpg",       // a symlink out of the folder
		"/photo/..%2Fsecreto.jpg", // walking up
		"/video/a.jpg",            // no such kind
		"/photo/.a.jpg",
	} {
		resp := do(t, anon, "GET", url+tail, nil, nil)
		readBody(t, resp)
		if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s: %d, want 404", tail, resp.StatusCode)
		}
	}

	for _, method := range []string{"POST", "PUT", "DELETE"} {
		for _, target := range []string{url, url + "/photo/a.jpg"} {
			resp := do(t, anon, method, target, strings.NewReader("x"), nil)
			readBody(t, resp)
			if resp.StatusCode != http.StatusMethodNotAllowed {
				t.Errorf("%s %s: %d, want 405", method, target, resp.StatusCode)
			}
		}
	}
}

func binary16(b []byte) uint16 { return uint16(b[0]) | uint16(b[1])<<8 }

func TestPublicPageAndBadTokens(t *testing.T) {
	srv, base, _, link := makeLink(t)
	page := filepath.Join(srv.cfg.AppsDir, "trips", "public.html")
	os.MkdirAll(filepath.Dir(page), 0o755)
	os.WriteFile(page, []byte("<title>viaje</title>"), 0o644)
	anon := anonymous()

	resp := do(t, anon, "GET", base+"/s/"+link.Token, nil, nil)
	if got := readBody(t, resp); resp.StatusCode != http.StatusOK || !strings.Contains(string(got), "viaje") {
		t.Errorf("/s/<token>: %d %q", resp.StatusCode, got)
	}
	if resp.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("Referrer-Policy = %q: the token would leak to the map tiles", resp.Header.Get("Referrer-Policy"))
	}

	bad := strings.Repeat("A", len(link.Token))
	resp = do(t, anon, "GET", base+"/s/"+bad, nil, nil)
	if got := readBody(t, resp); resp.StatusCode != http.StatusNotFound || !strings.Contains(string(got), "viaje") {
		t.Errorf("/s/<bad>: %d %q, want the page with a 404", resp.StatusCode, got)
	}
	for _, token := range []string{bad, "x", link.Token[:20]} {
		resp := do(t, anon, "GET", base+"/api/public/"+token, nil, nil)
		readBody(t, resp)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("token %q: %d, want 404", token, resp.StatusCode)
		}
	}

	// The page and its map load without a session; the rest of Trips does not.
	for path, want := range map[string]int{
		"/nayive/trips/public.html": http.StatusOK,
		"/nayive/trips/index.html":  http.StatusUnauthorized,
	} {
		resp := do(t, anon, "GET", base+path, nil, nil)
		readBody(t, resp)
		if resp.StatusCode != want {
			t.Errorf("%s: %d, want %d", path, resp.StatusCode, want)
		}
	}
}

func TestPublicLinkStop(t *testing.T) {
	srv, base, client, link := makeLink(t)
	positions := filepath.Join(srv.cfg.HomesDir, "ana", publicTripDir, tripPositionsFile)
	os.WriteFile(positions, []byte(`{"positions":[{"lat":41.1,"lon":-8.6,"at":1}]}`), 0o644)

	resp := do(t, client, "DELETE", base+"/api/shares?id="+link.ID, nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stop: %d", resp.StatusCode)
	}
	resp = do(t, anonymous(), "GET", base+"/api/public/"+link.Token, nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("stopped link: %d, want 404", resp.StatusCode)
	}
	if _, err := os.Stat(positions); !os.IsNotExist(err) {
		t.Error("the phone positions survived stopping the link")
	}
}

// -----------------------------------------------------------------------------
// the phone's side
// -----------------------------------------------------------------------------

func TestLocationAPI(t *testing.T) {
	srv, base, client, _ := makeLink(t)
	positions := filepath.Join(srv.cfg.HomesDir, "ana", publicTripDir, tripPositionsFile)

	due := func() bool {
		t.Helper()
		resp := do(t, client, "GET", base+"/api/location", nil, nil)
		raw := readBody(t, resp)
		var j struct{ Due bool }
		json.Unmarshal(raw, &j)
		return j.Due
	}
	post := func(body string) int {
		t.Helper()
		resp := do(t, client, "POST", base+"/api/location", strings.NewReader(body),
			map[string]string{"Content-Type": "application/json"})
		readBody(t, resp)
		return resp.StatusCode
	}

	if !due() {
		t.Fatal("a linked trip that is on, with no position yet, is not due")
	}
	if got := post(`{"lat":200,"lon":0}`); got != http.StatusBadRequest {
		t.Errorf("lat 200: %d, want 400", got)
	}
	if got := post(`{"lat":41.157944,"lon":-8.629105,"place":"  Oporto\n"}`); got != http.StatusOK {
		t.Fatalf("post: %d", got)
	}
	var doc positionsDoc
	if !loadJSONFile(positions, &doc) || len(doc.Positions) != 1 {
		t.Fatalf("positions.json not written")
	}
	if p := doc.Positions[0]; p.Lat != 41.158 || p.Lon != -8.629 || p.Place != "Oporto" || p.Source != "phone" {
		t.Errorf("stored %+v, want 41.158,-8.629 Oporto from the phone", p)
	}
	if due() {
		t.Error("still due right after a position")
	}
	if got := post(`{"lat":41.1,"lon":-8.6}`); got != http.StatusConflict {
		t.Errorf("second post: %d, want 409", got)
	}

	// A rough "now" is asked for again sooner than an accurate one.
	rough := positionsDoc{Latest: &tripPosition{Lat: 41.1, Lon: -8.6, Acc: 500,
		At: time.Now().Add(-20 * time.Minute).Unix()}}
	raw, _ := json.Marshal(rough)
	os.WriteFile(positions, raw, 0o644)
	if !due() {
		t.Error("a rough position 20 minutes old is not due")
	}
	rough.Latest.Acc = 20
	raw, _ = json.Marshal(rough)
	os.WriteFile(positions, raw, 0o644)
	if due() {
		t.Error("an accurate position 20 minutes old is due")
	}

	// A trip that is over wants nothing.
	os.Remove(positions)
	writeTripDates(t, srv, -10, -5)
	if due() {
		t.Error("a finished trip is due")
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
}
