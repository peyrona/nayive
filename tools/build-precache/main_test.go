package main

import (
	"path/filepath"
	"slices"
	"testing"

	"nayive/tools/internal/repo"
)

// Every name on the shared list is a real file, and the ones pages load by a
// plain <script> outside an offline app (the launcher's desk-rule.js) are in
// the precache - else the offline redirect to the desktop breaks.
func TestSharedListIsInPrecache(t *testing.T) {
	apps := filepath.Join(repo.MustRoot("build-precache"), "client", "apps")
	rels := collect(apps)
	for _, name := range shared {
		if !isFile(filepath.Join(apps, name)) {
			t.Errorf("%s is on the shared list but is not a file", name)
		}
		if !slices.Contains(rels, name) {
			t.Errorf("%s is on the shared list but not in the precache", name)
		}
	}
	if !slices.Contains(shared, "shared/desk-rule.js") {
		t.Error("shared/desk-rule.js left the shared list")
	}
}
