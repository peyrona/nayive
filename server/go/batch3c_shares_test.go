package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestSharedTripExtrasNoSymlinkOut: a symlink INSIDE files/ that points at
// data/ lends nothing, however trip.json names it.
func TestSharedTripExtrasNoSymlinkOut(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	home := filepath.Join(cfg.HomesDir, "ana")
	trip := filepath.Join(home, "data", "trips", "lisboa")
	os.MkdirAll(trip, 0o755)
	os.MkdirAll(filepath.Join(home, "files"), 0o755)
	if err := os.Symlink(filepath.Join(home, "data"), filepath.Join(home, "files", "atajo")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	os.WriteFile(filepath.Join(trip, "trip.json"), []byte(`{"photosDir": "files/atajo"}`), 0o644)

	g := lendTo(t, users.shares, "data/trips/lisboa", "trips", "ro")
	path := "shared/" + g.Slug + "/~/files/atajo/config.json"
	if got, _ := users.ResolvePath("user", "beto", path); got != "" {
		t.Fatalf("ResolvePath(%q) lent %q, through a symlink out of files/", path, got)
	}
}
