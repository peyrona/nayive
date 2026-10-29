package main

// =============================================================================
// Drive's shortcuts (links.go).
// =============================================================================

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// linkCall answers the status and the decoded body of one /api/files request.
func linkCall(t *testing.T, client *http.Client, method, u string) (int, map[string]any) {
	t.Helper()
	resp := do(t, client, method, u, nil, nil)
	defer resp.Body.Close()
	var answer map[string]any
	json.NewDecoder(resp.Body).Decode(&answer)
	return resp.StatusCode, answer
}

func makeShortcut(t *testing.T, client *http.Client, base, to, into string) (int, string) {
	t.Helper()
	q := url.Values{"link": {to}, "into": {into}}
	code, got := linkCall(t, client, "POST", base+"/api/files?"+q.Encode())
	p, _ := got["path"].(string)
	return code, p
}

// listLinks is ?dir= with &links=1: the `link` of each node, by path.
func listLinks(t *testing.T, client *http.Client, base, dir string, links bool) map[string]map[string]any {
	t.Helper()
	q := url.Values{"dir": {dir}}
	if links {
		q.Set("links", "1")
	}
	code, got := linkCall(t, client, "GET", base+"/api/files?"+q.Encode())
	if code != http.StatusOK {
		t.Fatalf("list %s = %d", dir, code)
	}
	out := map[string]map[string]any{}
	nodes, _ := got["nodes"].([]any)
	for _, n := range nodes {
		m := n.(map[string]any)
		l, _ := m["link"].(map[string]any)
		out[m["path"].(string)] = l
	}
	return out
}

func readLink(t *testing.T, abs string) linkFile {
	t.Helper()
	var lf linkFile
	b, err := os.ReadFile(abs)
	if err != nil || json.Unmarshal(b, &lf) != nil {
		t.Fatalf("read shortcut %s: %v", abs, err)
	}
	return lf
}

// TestLinksMakeAndList - a shortcut is made next to nothing it could replace,
// lists for Drive with where it leads, and is hidden from everyone else.
func TestLinksMakeAndList(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(files, "Trabajo"), 0o755)
	os.MkdirAll(filepath.Join(files, "Atajos"), 0o755)
	os.WriteFile(filepath.Join(files, "Trabajo", "presu.docx"), []byte("doc"), 0o644)

	code, p := makeShortcut(t, client, ts.URL, "files/Trabajo/presu.docx", "files/Atajos")
	if code != http.StatusCreated || p != "files/Atajos/presu.docx.nayive-link" {
		t.Fatalf("make = %d %q", code, p)
	}
	// Taken: a second one gets "(2)", the first stays as it was.
	first, _ := os.ReadFile(filepath.Join(files, "Atajos", "presu.docx.nayive-link"))
	if code, p := makeShortcut(t, client, ts.URL, "files/Trabajo/presu.docx", "files/Atajos"); code != http.StatusCreated ||
		p != "files/Atajos/presu.docx (2).nayive-link" {
		t.Fatalf("second make = %d %q", code, p)
	}
	if now, _ := os.ReadFile(filepath.Join(files, "Atajos", "presu.docx.nayive-link")); string(now) != string(first) {
		t.Error("the second shortcut changed the first")
	}
	if code, p := makeShortcut(t, client, ts.URL, "files/Trabajo", "files/Atajos"); code != http.StatusCreated ||
		p != "files/Atajos/Trabajo.nayive-link" {
		t.Fatalf("folder make = %d %q", code, p)
	}
	if info, err := os.Stat(filepath.Join(files, "Atajos", "Trabajo.nayive-link")); err != nil || info.Mode().Perm() != 0o644 {
		t.Errorf("the shortcut's mode = %v, %v", info, err)
	}

	got := listLinks(t, client, ts.URL, "files/Atajos", true)
	if l := got["files/Atajos/presu.docx.nayive-link"]; l == nil || l["to"] != "files/Trabajo/presu.docx" || l["dir"] != false {
		t.Errorf("file shortcut = %v", l)
	}
	if l := got["files/Atajos/Trabajo.nayive-link"]; l == nil || l["to"] != "files/Trabajo" || l["dir"] != true {
		t.Errorf("folder shortcut = %v", l)
	}
	if hidden := listLinks(t, client, ts.URL, "files/Atajos", false); len(hidden) != 0 {
		t.Errorf("without &links=1 the listing shows %v", hidden)
	}

	// Refusals: a shortcut to a shortcut, into data/, to nothing, to the root.
	for _, c := range [][2]string{
		{"files/Atajos/presu.docx.nayive-link", "files/Atajos"},
		{"files/Trabajo/presu.docx", "data"},
		{"files/Trabajo/nada.docx", "files/Atajos"},
		{"files", "files/Atajos"},
		{"files/Trabajo/presu.docx", "files/Trabajo/presu.docx"},
	} {
		if code, _ := makeShortcut(t, client, ts.URL, c[0], c[1]); code < 400 {
			t.Errorf("make %v = %d, want a refusal", c, code)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(files, "Trabajo", "presu.docx")); string(b) != "doc" {
		t.Error("the target was written")
	}
}

// TestLinksFollowMoves - a moved or renamed target is found again and the
// shortcut mended; a target gone is broken; a save (new inode) is kept.
func TestLinksFollowMoves(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(files, "A"), 0o755)
	os.MkdirAll(filepath.Join(files, "B"), 0o755)
	os.MkdirAll(filepath.Join(files, "S"), 0o755)
	os.WriteFile(filepath.Join(files, "A", "x.txt"), []byte("x"), 0o644)
	os.MkdirAll(filepath.Join(files, "A", "Fotos"), 0o755)
	if info, _ := os.Stat(filepath.Join(files, "A", "x.txt")); fileID(info) == 0 {
		t.Skip("no inodes here")
	}
	makeShortcut(t, client, ts.URL, "files/A/x.txt", "files/S")
	makeShortcut(t, client, ts.URL, "files/A/Fotos", "files/S")
	xLink := filepath.Join(files, "S", "x.txt.nayive-link")

	// Moved (same name), renamed (same folder).
	os.Rename(filepath.Join(files, "A", "x.txt"), filepath.Join(files, "B", "x.txt"))
	os.Rename(filepath.Join(files, "A", "Fotos"), filepath.Join(files, "A", "Japón"))
	got := listLinks(t, client, ts.URL, "files/S", true)
	if l := got["files/S/x.txt.nayive-link"]; l == nil || l["to"] != "files/B/x.txt" {
		t.Errorf("moved file = %v", l)
	}
	if l := got["files/S/Fotos.nayive-link"]; l == nil || l["to"] != "files/A/Japón" || l["dir"] != true {
		t.Errorf("renamed folder = %v", l)
	}
	if lf := readLink(t, xLink); lf.To != "files/B/x.txt" {
		t.Errorf("the shortcut was not mended: %+v", lf)
	}

	// A save replaces the file (new inode): the path still leads there, and
	// the new inode is kept, so the move after it is followed too.
	tmp := filepath.Join(files, "B", "tmp")
	os.WriteFile(tmp, []byte("x2"), 0o644)
	os.Rename(tmp, filepath.Join(files, "B", "x.txt"))
	listLinks(t, client, ts.URL, "files/S", true)
	os.Rename(filepath.Join(files, "B", "x.txt"), filepath.Join(files, "A", "x.txt"))
	if l := listLinks(t, client, ts.URL, "files/S", true)["files/S/x.txt.nayive-link"]; l == nil || l["to"] != "files/A/x.txt" {
		t.Errorf("moved after a save = %v", l)
	}

	// Moved AND renamed: not taken for it - an inode number can be reused.
	os.Rename(filepath.Join(files, "A", "x.txt"), filepath.Join(files, "B", "y.txt"))
	if l := listLinks(t, client, ts.URL, "files/S", true)["files/S/x.txt.nayive-link"]; l == nil || l["broken"] != true {
		t.Errorf("moved and renamed = %v, want broken", l)
	}
	// Gone (to the bin): broken, and the bin is not looked in.
	os.RemoveAll(filepath.Join(files, "A", "Japón"))
	if l := listLinks(t, client, ts.URL, "files/S", true)["files/S/Fotos.nayive-link"]; l == nil || l["broken"] != true {
		t.Errorf("gone = %v, want broken", l)
	}

	// Every shortcut, for the warning before the bin.
	code, list := linkCall(t, client, "GET", ts.URL+"/api/files?shortcuts=1")
	if links, _ := list["links"].([]any); code != http.StatusOK || len(links) != 2 {
		t.Errorf("shortcuts = %d %v", code, list)
	}
}

// TestLinksLeftOut - a zip leaves shortcuts out, and so does every listing
// that did not ask for them.
func TestLinksLeftOut(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.MkdirAll(filepath.Join(files, "F"), 0o755)
	os.WriteFile(filepath.Join(files, "nota.txt"), []byte("nota"), 0o644)
	os.WriteFile(filepath.Join(files, "F", "a.txt"), []byte("a"), 0o644)
	makeShortcut(t, client, ts.URL, "files/nota.txt", "files/F")

	code, got := compress(t, client, ts.URL, "files/F")
	if code != http.StatusOK || got["files"] != 1.0 {
		t.Fatalf("compress = %d %v", code, got)
	}
	body, _ := zipNames(t, filepath.Join(files, "F.zip"))
	if _, in := body["F/nota.txt.nayive-link"]; in {
		t.Error("the zip holds the shortcut")
	}

	for _, q := range []string{"find=*nota*", "dir=files/F&recursive=1", "search=1&name=has:nota"} {
		_, ans := linkCall(t, client, "GET", ts.URL+"/api/files?"+q)
		nodes, _ := ans["nodes"].([]any)
		for _, n := range nodes {
			if p := n.(map[string]any)["path"].(string); isLinkName(filepath.Base(p)) {
				t.Errorf("?%s lists %s", q, p)
			}
		}
	}
	_, ans := linkCall(t, client, "GET", ts.URL+"/api/files?find=*nota*&links=1")
	if nodes, _ := ans["nodes"].([]any); len(nodes) != 2 {
		t.Errorf("Drive's search = %v, want the note and its shortcut", nodes)
	}
}
