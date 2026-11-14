package main

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// Park / Unpark move the grants of a binned item (and only those) under its
// bin id and back; a parked grant never resolves (Trips review T10).
func TestSharesParkUnpark(t *testing.T) {
	dir := t.TempDir()
	homes := filepath.Join(dir, "homes")
	os.MkdirAll(filepath.Join(homes, "ana", "data", "trips", "a"), 0o755)
	os.MkdirAll(filepath.Join(homes, "ana", "data", "trips", "ab"), 0o755)
	s := NewShares(filepath.Join(dir, "config"), homes, quietLog())
	os.MkdirAll(filepath.Join(dir, "config"), 0o755)

	g1 := s.Create("ana", "beto", "data/trips/a", "trips", "a", "ro")
	g2 := s.Create("ana", "beto", "data/trips/ab", "trips", "ab", "ro")
	if g1 == nil || g2 == nil {
		t.Fatal("grants not made")
	}
	if n := s.Park("ana", "data/trips/a", "1700000000-0123abcd"); n != 1 {
		t.Fatalf("parked %d, want 1 (not the sibling ab)", n)
	}
	root := func(id string) (string, string) {
		for _, g := range s.ByOwner("ana") {
			if g.ID == id {
				return g.Root, g.Title
			}
		}
		return "", ""
	}
	if r, title := root(g1.ID); r != ".trash/1700000000-0123abcd" || title != "a" {
		t.Errorf("parked grant = %q %q", r, title)
	}
	g := *g1
	g.Root = ".trash/1700000000-0123abcd"
	if s.RootPath(&g) != "" {
		t.Errorf("a parked grant resolves")
	}
	if r, _ := root(g2.ID); r != "data/trips/ab" {
		t.Errorf("sibling moved: %q", r)
	}
	if n := s.Unpark("1700000000-0123abcd", "data/trips/a (restaurado x)"); n != 1 {
		t.Fatalf("unparked %d", n)
	}
	if r, title := root(g1.ID); r != "data/trips/a (restaurado x)" || title != "a" {
		t.Errorf("unparked grant = %q %q", r, title)
	}
	s.Park("ana", "data/trips/ab", "1700000001-0123abcd")
	if n := s.Unpark("1700000001-0123abcd", ""); n != 1 {
		t.Fatalf("dropped %d", n)
	}
	if r, _ := root(g2.ID); r != "" {
		t.Errorf("a purged grant is still kept: %q", r)
	}
}

// Over HTTP: deleting a shared trip parks its share and public link (beto and
// a stranger reach nothing, not even a new trip of the same folder name);
// restoring it brings both back (Trips review T10).
func TestSharesParkOverHTTP(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	root := filepath.Join(srv.cfg.HomesDir, "ana", "data", "trips", "japon-2026")
	os.MkdirAll(root, 0o755)
	os.WriteFile(filepath.Join(root, "trip.json"), []byte(`{"destination":"Japón","startDate":"2026-01-01","endDate":"2026-01-09"}`), 0o644)
	g := srv.shares.Create("ana", "beto", "data/trips/japon-2026", "trips", "Japón", "ro")
	link, _ := srv.shares.CreateLink("ana", "data/trips/japon-2026", "Japón")
	if g == nil || link == nil {
		t.Fatal("grants not made")
	}
	beto := noFollow()
	signIn(t, beto, ts.URL, "beto", "xyz")
	get := func(c *http.Client, url string) int {
		resp := do(t, c, "GET", ts.URL+url, nil, nil)
		readBody(t, resp)
		return resp.StatusCode
	}
	shared := "/api/files?file=shared/" + g.Slug + "/trip.json"
	public := "/api/public/" + link.Token
	if get(beto, shared) != 200 || get(anonymous(), public) != 200 {
		t.Fatalf("before: shared %d, public %d", get(beto, shared), get(anonymous(), public))
	}

	var out struct {
		IDs []string `json:"ids"`
	}
	jsonCall(t, client, "DELETE", ts.URL+"/api/files?paths=data/trips/japon-2026", "", 200, &out)
	os.MkdirAll(root, 0o755) // a new trip of the same name
	os.WriteFile(filepath.Join(root, "trip.json"), []byte(`{"destination":"new","startDate":"2026-01-01","endDate":"2026-01-09"}`), 0o644)
	if c := get(beto, shared); c == 200 {
		t.Errorf("beto reads the NEW trip through the old share")
	}
	if c := get(anonymous(), public); c == 200 {
		t.Errorf("the old public link shows the NEW trip")
	}

	os.RemoveAll(root)
	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=restore&ids="+out.IDs[0], "", 200, nil)
	if c := get(beto, shared); c != 200 {
		t.Errorf("after the restore beto's share = %d", c)
	}
	if c := get(anonymous(), public); c != 200 {
		t.Errorf("after the restore the public link = %d", c)
	}
}
