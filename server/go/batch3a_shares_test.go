package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestSharedTripExtrasStayInFiles: a shared trip lends what its trip.json
// points at - but only inside files/. A trip.json that names the owner's
// account file, her chats, or all of data/ lends none of it.
func TestSharedTripExtrasStayInFiles(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	home := filepath.Join(cfg.HomesDir, "ana")
	trip := filepath.Join(home, "data", "trips", "lisboa")
	os.MkdirAll(trip, 0o755)
	os.MkdirAll(filepath.Join(home, "files", "viajes"), 0o755)
	os.WriteFile(filepath.Join(home, "files", "viajes", "billete.pdf"), []byte("pdf"), 0o644)
	os.MkdirAll(filepath.Join(home, "data", "chat"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "chat", "x.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(trip, "trip.json"), []byte(`{
		"documents": [
			{"kind": "link", "path": "files/viajes/billete.pdf"},
			{"kind": "link", "path": "data/config.json"},
			{"kind": "link", "path": "files"}
		],
		"photosDir": "data"
	}`), 0o644)

	g := lendTo(t, users.shares, "data/trips/lisboa", "trips", "ro")
	slug := "shared/" + g.Slug + "/~/"

	// What it must still lend: a linked document in files/.
	got, _ := users.ResolvePath("user", "beto", slug+"files/viajes/billete.pdf")
	if !sharePointsAt(got, filepath.Join(home, "files", "viajes", "billete.pdf")) {
		t.Fatalf("the trip's linked document was refused: %q", got)
	}
	for _, path := range []string{
		slug + "data/config.json", // named as a document: her password
		slug + "data/chat/x.json", // under photosDir "data"
		slug + "files",            // files/ itself
	} {
		if got, _ := users.ResolvePath("user", "beto", path); got != "" {
			t.Errorf("ResolvePath(%q) lent %q, outside files/", path, got)
		}
	}
}
