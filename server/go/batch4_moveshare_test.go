package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// TestMoveKeepsShares (S2-#7): renaming or moving what was lent takes the grant
// along - beto still opens the album, now from its new place - and a sibling
// whose name merely starts the same is left alone. The admin's move inside
// one home does the same.
func TestMoveKeepsShares(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	album(t, srv.cfg)
	os.MkdirAll(filepath.Join(srv.cfg.HomesDir, "ana", "files", "albumes"), 0o755)

	g := lendTo(t, srv.shares, "files/album", "photos", "ro")
	near := lendTo(t, srv.shares, "files/albumes", "folder", "ro")

	move := func(c *http.Client, from, to string) {
		t.Helper()
		resp := do(t, c, "POST", ts.URL+"/api/files?old="+from+"&new="+to, nil, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("move %s -> %s = %d", from, to, resp.StatusCode)
		}
	}
	root := func(id string) string {
		for _, x := range srv.shares.ByOwner("ana") {
			if x.ID == id {
				return x.Root
			}
		}
		return ""
	}

	move(client, "files/album", "files/viajes/album2")
	if got := root(g.ID); got != "files/viajes/album2" {
		t.Errorf("the grant's root = %q after the move, want files/viajes/album2", got)
	}
	if got := root(near.ID); got != "files/albumes" {
		t.Errorf("a sibling's grant moved too: %q", got)
	}

	beto := signedInClient(t, ts.URL, "beto", "xyz")
	resp := do(t, beto, "GET", ts.URL+"/api/files?file=shared/"+g.Slug+"/foto.jpg", nil, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "jpg" {
		t.Errorf("beto reads the moved album: %d %q", resp.StatusCode, body)
	}

	// The admin moves the folder that HOLDS it: the grant follows, inside.
	admin := signedInClient(t, ts.URL, "jefe", "secreto")
	move(admin, "homes/ana/files/viajes", "homes/ana/files/viajes2026")
	if got := root(g.ID); got != "files/viajes2026/album2" {
		t.Errorf("after the admin's move the root = %q, want files/viajes2026/album2", got)
	}
}
