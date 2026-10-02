package main

// Data-safety seal (cleanup Phase 3, batch S8): L5, the server half. Two
// accounts on one browser: ana's tab left open after beto signed in there
// sends its changes with beto's cookie. The page names its owner in
// X-Nayive-User (shared/gum-api.js); every route that changes files refuses
// another account's page with 423 and does nothing - not only the PUT.

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// homeSnapshot is every name under `dir` with its size and time: what a
// refused request must leave exactly as it was (the bin is in there too).
func homeSnapshot(t *testing.T, dir string) string {
	t.Helper()
	var rows []string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		if d.IsDir() {
			rows = append(rows, rel+"/")
		} else {
			rows = append(rows, fmt.Sprintf("%s %d %d", rel, info.Size(), info.ModTime().UnixNano()))
		}
		return nil
	})
	sort.Strings(rows)
	return strings.Join(rows, "\n")
}

// TestDS_L5_ChangesFromAnotherAccountsPage: beto is signed in; ana's page
// sends a move, a rename, a delete, a purge, the bin's restore / delete /
// empty, a new folder, a copy, a save, a setting, Extract, Compress and the
// Office twin. Each is 423 and beto's home is untouched. A read is still
// answered; beto's own page, and a page that names nobody (from before the
// header), go through.
func TestDS_L5_ChangesFromAnotherAccountsPage(t *testing.T) {
	srv, ts, beto := newTestServer(t)
	signIn(t, beto, ts.URL, "beto", "xyz")
	home := filepath.Join(srv.cfg.HomesDir, "beto")
	files := filepath.Join(home, "files")
	os.WriteFile(filepath.Join(files, "a.txt"), []byte("de beto\n"), 0o644)
	os.WriteFile(filepath.Join(files, "x.odt"), []byte("odt"), 0o644)
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	w, _ := zw.Create("dentro.txt")
	w.Write([]byte("hola"))
	zw.Close()
	os.WriteFile(filepath.Join(files, "caja.zip"), zbuf.Bytes(), 0o644)
	thumb := filepath.Join(home, "data", "photos", "thumbs", "10_20.jpg")
	os.MkdirAll(filepath.Dir(thumb), 0o755)
	os.WriteFile(thumb, []byte("jpg"), 0o644)
	os.WriteFile(filepath.Join(files, "binned.txt"), []byte("en la papelera"), 0o644)
	var binned struct{ IDs []string }
	jsonCall(t, beto, "DELETE", ts.URL+"/api/files?paths=files/binned.txt", "", http.StatusOK, &binned)
	if len(binned.IDs) != 1 {
		t.Fatalf("the bin fixture: %v", binned.IDs)
	}
	id := binned.IDs[0]

	anasPage := map[string]string{whoHeader: whoValue("user", "ana")}
	before := homeSnapshot(t, home)
	for _, c := range []struct{ name, method, url, body string }{
		{"move / rename", "POST", "/api/files?old=files/a.txt&new=files/b.txt", ""},
		{"delete (to the bin)", "DELETE", "/api/files?paths=files/a.txt", ""},
		{"delete, legacy ?file=", "DELETE", "/api/files?file=files/a.txt", ""},
		{"purge", "DELETE", "/api/files?paths=data/photos/thumbs/10_20.jpg&purge=1", ""},
		{"bin restore", "POST", "/api/files?trash=restore&ids=" + id, ""},
		{"bin delete", "DELETE", "/api/files?trash=1&ids=" + id, ""},
		{"bin empty (the items seen)", "POST", "/api/files?trash=empty&ids=" + id, ""},
		{"bin empty (all)", "POST", "/api/files?trash=empty", ""},
		{"new folder", "PUT", "/api/files?type=dir&name=nueva&parent=files", ""},
		{"copy", "POST", "/api/files?from=files/a.txt&new=files/copia.txt", ""},
		{"save", "PUT", "/api/files?file=files/a.txt", "de ana"},
		{"bin days", "POST", "/api/files?trash=days&value=7", ""},
		{"trip reminder days", "POST", "/api/files?tripdays=1&value=3", ""},
		{"zip: Extract here", "POST", "/api/zip?file=files/caja.zip", ""},
		{"zip: Compress", "POST", "/api/zip?paths=files/a.txt", ""},
		{"the Office twin", "POST", "/api/office?file=files/x.odt&replace=1", ""},
	} {
		var body io.Reader
		if c.body != "" {
			body = strings.NewReader(c.body)
		}
		resp := do(t, beto, c.method, ts.URL+c.url, body, anasPage)
		if raw := readBody(t, resp); resp.StatusCode != http.StatusLocked {
			t.Errorf("%s from ana's page under beto's session = %d %s, want 423", c.name, resp.StatusCode, raw)
		}
	}
	if after := homeSnapshot(t, home); after != before {
		t.Errorf("beto's home changed under ana's page:\nbefore:\n%s\nafter:\n%s", before, after)
	}
	if d := srv.users.UserTrashDays("beto"); d != nil {
		t.Errorf("beto's bin days were set to %d by ana's page", *d)
	}

	// A read is the session's own, whoever's page asks.
	resp := do(t, beto, "GET", ts.URL+"/api/files?dir=files", nil, anasPage)
	if raw := readBody(t, resp); resp.StatusCode != http.StatusOK {
		t.Errorf("a listing from ana's page = %d %s, want 200", resp.StatusCode, raw)
	}

	// Beto's own page, and a page that names nobody: as always.
	resp = do(t, beto, "POST", ts.URL+"/api/files?old=files/a.txt&new=files/b.txt", nil,
		map[string]string{whoHeader: whoValue("user", "beto")})
	if raw := readBody(t, resp); resp.StatusCode != http.StatusOK {
		t.Errorf("beto's own move = %d %s", resp.StatusCode, raw)
	}
	jsonCall(t, beto, "POST", ts.URL+"/api/files?trash=restore&ids="+id, "", http.StatusOK, nil)
	if _, err := os.Stat(filepath.Join(files, "b.txt")); err != nil {
		t.Errorf("beto's move did not happen: %v", err)
	}
	if _, err := os.Stat(filepath.Join(files, "binned.txt")); err != nil {
		t.Errorf("beto's restore did not happen: %v", err)
	}
}

// TestDS_L5_OldNamePageAfterRename: the admin renamed beto to beto2. A page
// beto2 loaded before the rename still names "user:beto": his own (L3), its
// changes go through; ana's page still gets 423.
func TestDS_L5_OldNamePageAfterRename(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	adminCall(t, ts.URL, `{"action":"rename-user","name":"beto","new_name":"beto2"}`, http.StatusOK)
	client := noFollow()
	signIn(t, client, ts.URL, "beto2", "xyz")
	files := filepath.Join(srv.cfg.HomesDir, "beto2", "files")

	resp := do(t, client, "POST", ts.URL+"/api/files?old=files/suyo.txt&new=files/movido.txt", nil,
		map[string]string{whoHeader: whoValue("user", "ana")})
	readBody(t, resp)
	if resp.StatusCode != http.StatusLocked {
		t.Errorf("ana's page under beto2's session = %d, want 423", resp.StatusCode)
	}
	resp = do(t, client, "POST", ts.URL+"/api/files?old=files/suyo.txt&new=files/movido.txt", nil,
		map[string]string{whoHeader: whoValue("user", "beto")})
	if raw := readBody(t, resp); resp.StatusCode != http.StatusOK {
		t.Fatalf("a page of beto's old name = %d %s, want 200", resp.StatusCode, raw)
	}
	if _, err := os.Stat(filepath.Join(files, "movido.txt")); err != nil {
		t.Errorf("the move did not happen: %v", err)
	}
	resp = do(t, client, "DELETE", ts.URL+"/api/files?paths=files/movido.txt", nil,
		map[string]string{whoHeader: whoValue("user", "beto")})
	if raw := readBody(t, resp); resp.StatusCode != http.StatusOK {
		t.Errorf("a delete from a page of beto's old name = %d %s, want 200", resp.StatusCode, raw)
	}
}

// TestDS_L5_ChatCopyFromAnotherAccountsPage: Chat's "Copiar" (into the
// owner's files) and "Editar" (points the message at a file of theirs) from
// beto's page under ana's session: 423, nothing in her files, the message
// as it was. Her own page copies.
func TestDS_L5_ChatCopyFromAnotherAccountsPage(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	fotos := filepath.Join(f.srv.cfg.HomesDir, "ana", "files", "Fotos")
	os.MkdirAll(fotos, 0o755)
	photo := f.upload(t, "photo", "IMG_1.jpg", keepJPEG)
	base := fmt.Sprintf("%s/api/chat/conv/%s/messages/%d/", f.base, conv, photo.ID)
	betosPage := map[string]string{whoHeader: whoValue("user", "beto"), "Content-Type": "application/json"}

	resp := do(t, f.owner, "POST", base+"keep", strings.NewReader(`{"dir":"files/Fotos"}`), betosPage)
	if raw := readBody(t, resp); resp.StatusCode != http.StatusLocked {
		t.Errorf("Copiar from beto's page = %d %s, want 423", resp.StatusCode, raw)
	}
	if list, _ := os.ReadDir(fotos); len(list) != 0 {
		t.Errorf("Copiar from beto's page put %d file(s) in ana's folder", len(list))
	}
	resp = do(t, f.owner, "POST", base+"edited", strings.NewReader(`{"ref":"files/Fotos/otra.jpg"}`), betosPage)
	if raw := readBody(t, resp); resp.StatusCode != http.StatusLocked {
		t.Errorf("Editar from beto's page = %d %s, want 423", resp.StatusCode, raw)
	}

	resp = do(t, f.owner, "POST", base+"keep", strings.NewReader(`{"dir":"files/Fotos"}`),
		map[string]string{whoHeader: whoValue("user", "ana"), "Content-Type": "application/json"})
	if raw := readBody(t, resp); resp.StatusCode != http.StatusOK {
		t.Errorf("Copiar from ana's own page = %d %s, want 200", resp.StatusCode, raw)
	}
	if _, err := os.Stat(filepath.Join(fotos, "IMG_1.jpg")); err != nil {
		t.Errorf("ana's own Copiar did not land: %v", err)
	}
}
