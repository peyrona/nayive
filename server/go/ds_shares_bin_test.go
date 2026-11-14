package main

// Data-safety seal (Trips review 2026-11-14, T10): what an owner lent of a
// folder goes into the bin with it and comes out with it. Before, a grant kept
// pointing at the binned folder's empty name, and a NEW folder made under that
// name (a new trip "Japón" 2026 -> data/trips/japon-2026) was lent at once: to
// everyone the old trip was shared with, and to anyone with its old /s/ link.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// dsTripWithGrants makes ana's trip folder `dir` with a share to beto and a
// public link, and answers both grants' ids/tokens.
func dsTripWithGrants(t *testing.T, srv *Server, dir string) (shareID, token string) {
	t.Helper()
	root := filepath.Join(srv.cfg.HomesDir, "ana", "data", "trips", dir)
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "trip.json"), []byte(`{"destination":"old"}`), 0o644)
	g := srv.shares.Create("ana", "beto", "data/trips/"+dir, "trips", "Japón", "ro")
	if g == nil {
		t.Fatal("share not made")
	}
	link, _ := srv.shares.CreateLink("ana", "data/trips/"+dir, "Japón")
	if link == nil {
		t.Fatal("link not made")
	}
	return g.ID, link.Token
}

func dsGrant(srv *Server, id string) *Grant {
	for _, g := range srv.shares.ByOwner("ana") {
		if g.ID == id {
			grant := g
			return &grant
		}
	}
	return nil
}

// TestDS_T10_BinnedTripGrantsNotOnNewTrip: delete the trip, make a new one in
// the same folder name: neither the old share nor the old link reaches it.
// Undo (restore) brings both back to the old trip.
func TestDS_T10_BinnedTripGrantsNotOnNewTrip(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	shareID, token := dsTripWithGrants(t, srv, "japon-2026")

	var out struct {
		IDs []string `json:"ids"`
	}
	jsonCall(t, client, "DELETE", ts.URL+"/api/files?paths=data/trips/japon-2026", "", 200, &out)
	if len(out.IDs) != 1 {
		t.Fatalf("bin ids = %v", out.IDs)
	}

	// A new trip takes the free name.
	fresh := filepath.Join(srv.cfg.HomesDir, "ana", "data", "trips", "japon-2026")
	os.MkdirAll(fresh, 0o755)
	os.WriteFile(filepath.Join(fresh, "trip.json"), []byte(`{"destination":"new"}`), 0o644)

	if g := srv.shares.FindToken(token); g == nil || srv.shares.RootPath(g) != "" {
		t.Errorf("the old /s/ link reaches the NEW trip")
	}
	for _, g := range srv.shares.ForUser("beto") {
		if g.ID == shareID && srv.shares.RootPath(&g) != "" {
			t.Errorf("beto sees the NEW trip through the old share")
		}
	}

	// The new trip moves aside; Undo puts the old one back in its place.
	os.Rename(fresh, fresh+"-new")
	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=restore&ids="+out.IDs[0], "", 200, nil)
	g := srv.shares.FindToken(token)
	if g == nil || srv.shares.RootPath(g) == "" {
		t.Fatalf("the restored trip's link does not work again")
	}
	if raw, _ := os.ReadFile(filepath.Join(srv.shares.RootPath(g), "trip.json")); !strings.Contains(string(raw), "old") {
		t.Errorf("the link reaches %q, want the old trip", raw)
	}
	if s := dsGrant(srv, shareID); s == nil || s.Root != "data/trips/japon-2026" || s.Title != "Japón" {
		t.Errorf("the share after the restore = %+v", s)
	}
}

// TestDS_T10_RestoreBesideNewTripKeepsGrants: deleted, a new trip made under
// the name, then the old one restored: it comes back as "(restaurado …)" and
// its grants go with it, never onto the new trip.
func TestDS_T10_RestoreBesideNewTripKeepsGrants(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	shareID, token := dsTripWithGrants(t, srv, "japon-2026")

	var out struct {
		IDs []string `json:"ids"`
	}
	jsonCall(t, client, "DELETE", ts.URL+"/api/files?paths=data/trips/japon-2026", "", 200, &out)
	fresh := filepath.Join(srv.cfg.HomesDir, "ana", "data", "trips", "japon-2026")
	os.MkdirAll(fresh, 0o755)
	os.WriteFile(filepath.Join(fresh, "trip.json"), []byte(`{"destination":"new"}`), 0o644)

	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=restore&ids="+out.IDs[0], "", 200, nil)

	s := dsGrant(srv, shareID)
	if s == nil || !strings.HasPrefix(s.Root, "data/trips/japon-2026 (restaurado ") {
		t.Fatalf("the share after a restore beside the new trip = %+v", s)
	}
	g := srv.shares.FindToken(token)
	if g == nil {
		t.Fatal("link gone")
	}
	if raw, _ := os.ReadFile(filepath.Join(srv.shares.RootPath(g), "trip.json")); !strings.Contains(string(raw), "old") {
		t.Errorf("the link reaches %q, want the restored old trip", raw)
	}
}

// TestDS_T10_PurgeDropsParkedGrants: emptied from the bin, the trip's grants
// go for good - no grant is left to wake up on anything.
func TestDS_T10_PurgeDropsParkedGrants(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	shareID, token := dsTripWithGrants(t, srv, "japon-2026")

	var out struct {
		IDs []string `json:"ids"`
	}
	jsonCall(t, client, "DELETE", ts.URL+"/api/files?paths=data/trips/japon-2026", "", 200, &out)
	jsonCall(t, client, "DELETE", ts.URL+"/api/files?trash=1&ids="+out.IDs[0], "", 200, nil)

	if dsGrant(srv, shareID) != nil || srv.shares.FindToken(token) != nil {
		t.Errorf("a purged trip's grants are still kept")
	}
}

// TestDS_T10_ParkedGrantNeverReadsTheBin: a parked grant lends nothing, not
// even the binned folder itself.
func TestDS_T10_ParkedGrantNeverReadsTheBin(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	_, token := dsTripWithGrants(t, srv, "japon-2026")
	jsonCall(t, client, "DELETE", ts.URL+"/api/files?paths=data/trips/japon-2026", "", 200, nil)

	g := srv.shares.FindToken(token)
	if g == nil || !strings.HasPrefix(g.Root, ".trash/") {
		t.Fatalf("the link was not parked: %+v", g)
	}
	if p := srv.shares.RootPath(g); p != "" {
		t.Errorf("a parked link resolves to %s", p)
	}
}
