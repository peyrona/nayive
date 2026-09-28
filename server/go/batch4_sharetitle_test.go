package main

// =============================================================================
// Batch 4 part 3: a share of a renamed or moved item shows its new name when
// its title was just the old name; a title the app chose stays.
// =============================================================================

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestMoveRenamesShareTitle(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	album(t, srv.cfg)
	os.MkdirAll(filepath.Join(srv.cfg.HomesDir, "ana", "files", "viaje"), 0o755)
	os.MkdirAll(filepath.Join(srv.cfg.HomesDir, "ana", "files", "padre", "hijo"), 0o755)

	byName := srv.shares.Create("ana", "beto", "files/album", "folder", "album", "ro") // Drive: the name
	chosen := srv.shares.Create("ana", "beto", "files/viaje", "trips", "Lisboa", "ro") // Trips: the destination
	inner := srv.shares.Create("ana", "beto", "files/padre/hijo", "folder", "hijo", "ro")
	if byName == nil || chosen == nil || inner == nil {
		t.Fatal("a share was refused")
	}

	move := func(from, to string) {
		t.Helper()
		resp := do(t, client, "POST", ts.URL+"/api/files?old="+url.QueryEscape(from)+"&new="+url.QueryEscape(to), nil, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("move %s -> %s = %d", from, to, resp.StatusCode)
		}
	}
	grant := func(id string) Grant {
		for _, g := range srv.shares.ByOwner("ana") {
			if g.ID == id {
				return g
			}
		}
		t.Fatalf("grant %s is gone", id)
		return Grant{}
	}

	move("files/album", "files/fotos/Verano 2026")
	if g := grant(byName.ID); g.Title != "Verano 2026" || g.Slug != byName.Slug {
		t.Errorf("renamed share: title %q slug %q, want \"Verano 2026\" and the old slug %q", g.Title, g.Slug, byName.Slug)
	}
	move("files/viaje", "files/viaje-2026")
	if g := grant(chosen.ID); g.Title != "Lisboa" || g.Root != "files/viaje-2026" {
		t.Errorf("a chosen title changed: %+v", g)
	}
	move("files/padre", "files/madre") // only a parent: the shared folder keeps its name
	if g := grant(inner.ID); g.Title != "hijo" || g.Root != "files/madre/hijo" {
		t.Errorf("share under a moved parent: %+v", g)
	}

	// The recipient sees the new name.
	found := false
	for _, n := range srv.shares.RootNodes("beto") {
		if n.Shared != nil && n.Shared.Title == "Verano 2026" {
			found = true
		}
	}
	if !found {
		t.Error("beto's shared/ does not show the new name")
	}
}
