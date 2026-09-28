package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// TestShareNotesLent (apps-2 #75): a shared album shows the owner's notes,
// read-only. beto gets ana's notes on the photos directly in the album he
// asks for, keyed by his own shared/... paths - and nothing of hers outside
// what the grant lends.
func TestShareNotesLent(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	home := filepath.Join(srv.cfg.HomesDir, "ana")
	album(t, srv.cfg)
	os.MkdirAll(filepath.Join(home, "files", "album", "sub"), 0o755)
	os.MkdirAll(filepath.Join(home, "files", "albumes"), 0o755)
	for _, f := range []string{"album/sub/otra.jpg", "albumes/x.jpg", "album/raro.jpg"} {
		os.WriteFile(filepath.Join(home, "files", f), []byte("jpg"), 0o644)
	}
	os.MkdirAll(filepath.Join(home, "data", "photos"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "photos", "comments.json"), []byte(`{
		"files/album/foto.jpg": "la playa",
		"files/album/sub/otra.jpg": "en la sub",
		"files/albumes/x.jpg": "vecina",
		"files/privado/y.jpg": "secreto",
		"files/album/raro.jpg": 42,
		"files/album/se-fue.jpg": "movida a otra parte"
	}`), 0o644)

	// carla: signed in, but nothing is shared with her.
	carla := filepath.Join(srv.cfg.HomesDir, "carla")
	os.MkdirAll(filepath.Join(carla, "data"), 0o755)
	os.MkdirAll(filepath.Join(carla, "files"), 0o755)
	os.WriteFile(filepath.Join(carla, "data", "config.json"), []byte(`{"password":"qwe"}`), 0o644)

	g := lendTo(t, srv.shares, "files/album", "photos", "ro")
	beto := signedInClient(t, ts.URL, "beto", "xyz")

	get := func(c *http.Client, dir string) (int, map[string]string) {
		t.Helper()
		resp := do(t, c, "GET", ts.URL+"/api/shares?notes="+url.QueryEscape(dir), nil, nil)
		defer resp.Body.Close()
		var body struct {
			Notes map[string]string `json:"notes"`
		}
		json.NewDecoder(resp.Body).Decode(&body)
		return resp.StatusCode, body.Notes
	}

	base := "shared/" + g.Slug
	code, notes := get(beto, base)
	if code != http.StatusOK || len(notes) != 1 || notes[base+"/foto.jpg"] != "la playa" {
		t.Fatalf("beto's album notes = %d %v, want only %s/foto.jpg", code, notes, base)
	}

	code, notes = get(beto, base+"/sub")
	if code != http.StatusOK || len(notes) != 1 || notes[base+"/sub/otra.jpg"] != "en la sub" {
		t.Errorf("the sub-folder's notes = %d %v", code, notes)
	}

	// Walking up out of the grant: refused, never her other folders' notes.
	if code, notes = get(beto, base+"/../albumes"); code == http.StatusOK && len(notes) > 0 {
		t.Errorf("a .. leaked %v", notes)
	}

	// Not shared with carla: 404, nothing.
	carlaC := signedInClient(t, ts.URL, "carla", "qwe")
	if code, notes = get(carlaC, base); code != http.StatusNotFound || len(notes) > 0 {
		t.Errorf("carla got %d %v, want 404", code, notes)
	}

	// Not a shared path at all.
	if code, _ = get(beto, "files/album"); code != http.StatusBadRequest {
		t.Errorf("a path of his own = %d, want 400", code)
	}

	// The album gone: no notes (the grant points nowhere).
	os.RemoveAll(filepath.Join(home, "files", "album"))
	if code, notes = get(beto, base); code != http.StatusOK || len(notes) != 0 {
		t.Errorf("a gone album still lends %d %v", code, notes)
	}
}

// TestShareNotesTripPhotos: a shared trip lends its photo folder as
// shared/<slug>/~/files/...; the notes there come too - and only there.
func TestShareNotesTripPhotos(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	home := filepath.Join(srv.cfg.HomesDir, "ana")
	trip := filepath.Join(home, "data", "trips", "lisboa")
	os.MkdirAll(trip, 0o755)
	os.MkdirAll(filepath.Join(home, "files", "fotos", "lisboa"), 0o755)
	os.MkdirAll(filepath.Join(home, "files", "fotos", "otras"), 0o755)
	os.WriteFile(filepath.Join(home, "files", "fotos", "lisboa", "a.jpg"), []byte("jpg"), 0o644)
	os.WriteFile(filepath.Join(home, "files", "fotos", "otras", "b.jpg"), []byte("jpg"), 0o644)
	os.WriteFile(filepath.Join(trip, "trip.json"), []byte(`{"photosDir": "files/fotos/lisboa"}`), 0o644)
	os.MkdirAll(filepath.Join(home, "data", "photos"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "photos", "comments.json"), []byte(`{
		"files/fotos/lisboa/a.jpg": "tranvía",
		"files/fotos/otras/b.jpg": "no es del viaje"
	}`), 0o644)

	g := lendTo(t, srv.shares, "data/trips/lisboa", "trips", "ro")
	beto := signedInClient(t, ts.URL, "beto", "xyz")

	ask := func(dir string) map[string]string {
		t.Helper()
		resp := do(t, beto, "GET", ts.URL+"/api/shares?notes="+url.QueryEscape(dir), nil, nil)
		defer resp.Body.Close()
		var body struct {
			Notes map[string]string `json:"notes"`
		}
		json.NewDecoder(resp.Body).Decode(&body)
		return body.Notes
	}

	dir := "shared/" + g.Slug + "/~/files/fotos/lisboa"
	if got := ask(dir); len(got) != 1 || got[dir+"/a.jpg"] != "tranvía" {
		t.Errorf("the trip's photo notes = %v", got)
	}
	if got := ask("shared/" + g.Slug + "/~/files/fotos/otras"); len(got) != 0 {
		t.Errorf("a folder the trip does not lend gave %v", got)
	}
}
