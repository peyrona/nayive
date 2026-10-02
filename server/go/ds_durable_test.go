package main

// Data-safety seal (cleanup Phase 3, batch S1): every save that renames (or
// links) a file into place syncs that folder before it answers (K1). A sync
// leaves no trace on disk, so the tests watch syncDir through dirSyncs.

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// dsWatchSyncs records every folder synced from now to the test's end, and
// answers a check: was this folder synced?
func dsWatchSyncs(t *testing.T) func(dir string) bool {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	fn := func(dir string) {
		mu.Lock()
		seen = append(seen, filepath.Clean(dir))
		mu.Unlock()
	}
	dirSyncs.Store(&fn)
	t.Cleanup(func() { dirSyncs.Store(nil) })
	return func(dir string) bool {
		want := filepath.Clean(dir)
		if real, err := filepath.EvalSymlinks(want); err == nil {
			want = real
		}
		mu.Lock()
		defer mu.Unlock()
		for _, d := range seen {
			if real, err := filepath.EvalSymlinks(d); err == nil {
				d = real
			}
			if d == want {
				return true
			}
		}
		return false
	}
}

// TestDS_K1_SavesSyncTheirFolder: the server's JSON files, a Drive save, a
// copy, a phone's photo, the Contacts picture, the eMail files, a chat message
// and its photo, and an account rename all sync their folder.
func TestDS_K1_SavesSyncTheirFolder(t *testing.T) {
	f := newChatFixture(t)
	synced := dsWatchSyncs(t)
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")

	// atomicWriteJSON (config/, data/*.json, the bin index, chat, positions)
	jsonDir := filepath.Join(home, "data", "algo")
	os.MkdirAll(jsonDir, 0o755)
	if err := atomicWriteJSON(filepath.Join(jsonDir, "x.json"), map[string]int{"a": 1}, 2); err != nil {
		t.Fatal(err)
	}
	if !synced(jsonDir) {
		t.Error("atomicWriteJSON did not sync its folder")
	}

	// a Drive save (upload.go) and a copy (copy.go)
	os.MkdirAll(filepath.Join(home, "files", "docs"), 0o755)
	resp := do(t, f.owner, "PUT", f.base+"/api/files?file=files/docs/nota.txt", strings.NewReader("hola"), nil)
	resp.Body.Close()
	if resp.StatusCode != 200 || !synced(filepath.Join(home, "files", "docs")) {
		t.Errorf("a Drive save (%d) did not sync its folder", resp.StatusCode)
	}
	os.MkdirAll(filepath.Join(home, "files", "otra"), 0o755)
	jsonCall(t, f.owner, "POST", f.base+"/api/files?from=files/docs/nota.txt&new=files/otra/nota.txt", "", 200, nil)
	if !synced(filepath.Join(home, "files", "otra")) {
		t.Error("a copy did not sync its folder")
	}
	jsonCall(t, f.owner, "POST", f.base+"/api/files?from=files/docs&new=files/docs2", "", 200, nil)
	if !synced(filepath.Join(home, "files", "docs2")) || !synced(filepath.Join(home, "files")) {
		t.Error("a folder copy did not sync its folders")
	}

	// a save at the very top of its root: a guest's photo into an "add"
	// share (the root is the shared folder), and the admin at the base dir
	os.MkdirAll(filepath.Join(home, "files", "buzon"), 0o755)
	g := f.srv.shares.Create("ana", "beto", "files/buzon", "photos", "Buzón", "add")
	guest := signedInClient(t, f.base, "beto", "xyz")
	resp = do(t, guest, "PUT", f.base+"/api/files?file=shared/"+g.Slug+"/IMG_9.jpg", bytes.NewReader(keepJPEG), nil)
	resp.Body.Close()
	if resp.StatusCode != 200 || !synced(filepath.Join(home, "files", "buzon")) {
		t.Errorf("a guest's save into a share's top (%d) did not sync it", resp.StatusCode)
	}
	admin := signedInClient(t, f.base, "jefe", "secreto")
	resp = do(t, admin, "PUT", f.base+"/api/files?file=nota-admin.txt", strings.NewReader("hola"), nil)
	resp.Body.Close()
	if resp.StatusCode != 200 || !synced(f.srv.cfg.BaseDir) {
		t.Errorf("the admin's save at the base (%d) did not sync it", resp.StatusCode)
	}

	// a phone's photo filed into Drive (api_device_media.go)
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	os.MkdirAll(filepath.Join(home, "data", ".upload"), 0o755)
	os.WriteFile(filepath.Join(home, "data", ".upload", "p1.part"), []byte("jpeg"), 0o600)
	if _, err := fileMediaPart(root, filepath.Join("data", ".upload", "p1.part"), "files/Camera/2026", "IMG_1.jpg"); err != nil {
		t.Fatal(err)
	}
	if !synced(filepath.Join(home, "files", "Camera", "2026")) {
		t.Error("a phone's photo did not sync its folder")
	}

	// the Contacts picture set from Chat (vcard_photo.go)
	vcf := filepath.Join(home, "data", "contacts.vcf")
	os.WriteFile(vcf, []byte("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u1\r\nFN:Lola\r\nEND:VCARD\r\n"), 0o644)
	if err := setCardPhoto(vcf, "u1", append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte{1}, 32)...)); err != nil {
		t.Fatal(err)
	}
	if !synced(filepath.Join(home, "data")) {
		t.Error("the Contacts picture did not sync its folder")
	}

	// the eMail files (mail_labels.go writeMailFile)
	f.srv.mail.mu.Lock()
	err = f.srv.mail.writeMailFile("ana", "settings.json", MailSettings{TrashDays: 30})
	f.srv.mail.mu.Unlock()
	if err != nil || !synced(filepath.Join(home, "data", "mail")) {
		t.Errorf("an eMail file (%v) did not sync its folder", err)
	}

	// a chat message and a chat photo
	conv := "d-" + f.ids["Carmen"]
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"kind":"text","text":"hola"}`, 201, nil)
	if !synced(filepath.Join(home, "data", "chat", "conv", conv)) {
		t.Error("a chat message did not sync its folder")
	}
	f.upload(t, "photo", "foto.jpg", keepJPEG)
	if !synced(filepath.Join(home, "data", "chat", "conv", conv, "media")) {
		t.Error("a chat photo did not sync its folder")
	}

	// an account rename (users.go)
	if got := f.srv.users.RenameAccount("beto", "beto2"); got != "renamed" {
		t.Fatalf("rename = %s", got)
	}
	if !synced(f.srv.cfg.HomesDir) {
		t.Error("an account rename did not sync homes/")
	}
}
