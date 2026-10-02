package main

// =============================================================================
// L2 (data-safety audit, server-writes #5): a mail file written for a user
// whose home is gone - an admin delete or rename that overtook the write -
// must never re-create homes/<user>/ (a ghost home a later account with that
// name would inherit). The mail folder below a home that exists is still made,
// 0700 like the files in it.
// =============================================================================

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDS_L2_MailWriteNeverMakesHome(t *testing.T) {
	srv, _, _ := newTestServer(t)
	h := srv.mail

	h.mu.Lock()
	err := h.writeMailFile("nadie", "labels.json", map[string]any{})
	h.mu.Unlock()
	if !errors.Is(err, errRootGone) {
		t.Fatalf("a mail write for a user with no home = %v, want errRootGone", err)
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "nadie")); !os.IsNotExist(err) {
		t.Fatalf("a mail write re-created homes/nadie/ (a ghost home): %v", err)
	}

	// An existing home still gets its data/mail folder, private.
	h.mu.Lock()
	err = h.writeMailFile("ana", "labels.json", map[string]any{})
	h.mu.Unlock()
	if err != nil {
		t.Fatalf("a mail write for ana = %v", err)
	}
	st, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana", "data", "mail"))
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("ana's mail folder: %v, mode %v, want 0700", err, st.Mode().Perm())
	}
}
