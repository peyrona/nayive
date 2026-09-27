package main

// =============================================================================
// /api/zip - the list and "Extract here" (api_zip.go).
// =============================================================================

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// zipPart is one entry of a test zip. raw != nil writes it with CreateRaw:
// already-compressed bytes, with whatever method, flags and sizes `h` claims.
type zipPart struct {
	h    zip.FileHeader
	body string
	raw  []byte
}

func file(name, body string) zipPart { return zipPart{h: zip.FileHeader{Name: name}, body: body} }

func makeZip(t *testing.T, parts ...zipPart) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, p := range parts {
		h := p.h
		if h.Method == 0 && p.raw == nil {
			h.Method = zip.Deflate
		}
		var w io.Writer
		var err error
		if p.raw != nil {
			w, err = zw.CreateRaw(&h)
		} else {
			w, err = zw.CreateHeader(&h)
		}
		if err != nil {
			t.Fatalf("zip entry %q: %v", h.Name, err)
		}
		if p.raw != nil {
			w.Write(p.raw)
		} else {
			io.WriteString(w, p.body)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

// callZip answers the status and the decoded body of one /api/zip request.
func callZip(t *testing.T, client *http.Client, method, url string) (int, map[string]any) {
	t.Helper()
	resp := do(t, client, method, url, nil, nil)
	defer resp.Body.Close()
	var answer map[string]any
	json.NewDecoder(resp.Body).Decode(&answer)
	return resp.StatusCode, answer
}

func readText(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Errorf("read %s: %v", path, err)
	}
	return string(b)
}

// TestZipListAndExtract - the list shows what will be made, "Extract here"
// makes exactly that in a new folder, and nothing leaves it.
func TestZipListAndExtract(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	home := filepath.Join(srv.cfg.HomesDir, "ana")
	files := filepath.Join(home, "files")

	when := time.Date(2019, 7, 14, 10, 30, 0, 0, time.UTC)
	link := zip.FileHeader{Name: "enlace"}
	link.SetMode(os.ModeSymlink | 0o777)
	dos := zip.FileHeader{Name: "a\xa4o.txt"} // "año" in code page 850, no UTF-8 flag
	dated := zip.FileHeader{Name: "fecha.txt", Modified: when}

	upload(t, client, ts.URL+"/api/files?file=files/caja.zip", makeZip(t,
		file("a.txt", "uno"),
		file("sub/", ""),
		file("sub/b.txt", "dos"),
		file(`win\c.txt`, "tres"),
		zipPart{h: dos, body: "cuatro"},
		zipPart{h: dated, body: "cinco"},
		file("__MACOSX/._a.txt", "basura"),
		file(".DS_Store", "basura"),
		file("../fuera.txt", "escapa"),
		file("x/../../fuera2.txt", "escapa"),
		file("/abs/d.txt", "seis"),
		zipPart{h: link, body: "/etc/passwd"},
		file("a.txt", "otra vez"),
	))

	code, list := callZip(t, client, "GET", ts.URL+"/api/zip?file=files/caja.zip")
	if code != http.StatusOK {
		t.Fatalf("GET list = %d %v", code, list)
	}
	var names []string
	for _, e := range list["entries"].([]any) {
		names = append(names, e.(map[string]any)["name"].(string))
	}
	want := "a.txt a.txt abs/d.txt año.txt fecha.txt sub/b.txt win/c.txt"
	if got := strings.Join(names, " "); got != want {
		t.Errorf("listed %q, want %q", got, want)
	}
	if list["into"] != "caja" || list["files"] != 7.0 || list["locked"] != false {
		t.Errorf("list header = %v", list)
	}

	code, got := callZip(t, client, "POST", ts.URL+"/api/zip?file=files/caja.zip")
	if code != http.StatusOK || got["path"] != "files/caja" {
		t.Fatalf("POST = %d %v", code, got)
	}
	// The escapes, the link and the second a.txt.
	if got["files"] != 6.0 || got["skipped"] != 4.0 {
		t.Errorf("answer = %v, want 6 files and 4 skipped", got)
	}

	dest := filepath.Join(files, "caja")
	for name, body := range map[string]string{
		"a.txt": "uno", "sub/b.txt": "dos", "win/c.txt": "tres",
		"año.txt": "cuatro", "fecha.txt": "cinco", "abs/d.txt": "seis",
	} {
		if s := readText(t, filepath.Join(dest, name)); s != body {
			t.Errorf("%s = %q, want %q", name, s, body)
		}
	}
	for _, p := range []string{
		filepath.Join(home, "fuera.txt"), filepath.Join(files, "fuera.txt"),
		filepath.Join(files, "fuera2.txt"), filepath.Join(dest, "fuera.txt"),
		filepath.Join(dest, "enlace"), filepath.Join(dest, "__MACOSX"),
		filepath.Join(dest, ".DS_Store"),
	} {
		if pathExists(p) {
			t.Errorf("%s was made", p)
		}
	}
	if info, err := os.Stat(filepath.Join(dest, "fecha.txt")); err != nil || !info.ModTime().Equal(when) {
		t.Errorf("fecha.txt lost its date: %v", info.ModTime())
	}

	// Again: the name is taken, so a second folder - nothing is written over.
	os.WriteFile(filepath.Join(dest, "a.txt"), []byte("cambiado"), 0o644)
	if code, got := callZip(t, client, "POST", ts.URL+"/api/zip?file=files/caja.zip"); code != http.StatusOK || got["path"] != "files/caja (2)" {
		t.Errorf("second POST = %d %v, want files/caja (2)", code, got)
	}
	if s := readText(t, filepath.Join(dest, "a.txt")); s != "cambiado" {
		t.Errorf("the first folder was written over: %q", s)
	}
	if _, list := callZip(t, client, "GET", ts.URL+"/api/zip?file=files/caja.zip"); list["into"] != "caja (3)" {
		t.Errorf("list into = %v, want caja (3)", list["into"])
	}
}

// TestZipOneTopFolder - a zipped folder unpacks as that folder, never as a
// folder inside a folder of the same name.
func TestZipOneTopFolder(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	upload(t, client, ts.URL+"/api/files?file=files/descarga.zip", makeZip(t,
		file("Fotos/", ""), file("Fotos/x.jpg", "x"), file("Fotos/viaje/y.jpg", "y")))

	if _, list := callZip(t, client, "GET", ts.URL+"/api/zip?file=files/descarga.zip"); list["into"] != "Fotos" || list["dirs"] != 2.0 {
		t.Errorf("list = %v, want into Fotos, 2 folders", list)
	}
	if code, got := callZip(t, client, "POST", ts.URL+"/api/zip?file=files/descarga.zip"); code != http.StatusOK || got["path"] != "files/Fotos" {
		t.Fatalf("POST = %d %v", code, got)
	}
	if readText(t, filepath.Join(files, "Fotos", "viaje", "y.jpg")) != "y" || pathExists(filepath.Join(files, "Fotos", "Fotos")) {
		t.Error("the top folder was not taken as the folder to make")
	}

	// One FILE at the top is not a folder: it gets the zip's name around it.
	upload(t, client, ts.URL+"/api/files?file=files/solo.zip", makeZip(t, file("informe.pdf", "pdf")))
	if code, got := callZip(t, client, "POST", ts.URL+"/api/zip?file=files/solo.zip"); code != http.StatusOK || got["path"] != "files/solo" {
		t.Errorf("single file POST = %d %v, want files/solo", code, got)
	}
}

// TestZipRefusals - every refusal answers before anything is written, and a
// job that fails half way takes its folder away.
func TestZipRefusals(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	home := filepath.Join(srv.cfg.HomesDir, "ana")
	files := filepath.Join(home, "files")

	locked := zip.FileHeader{Name: "secreto.txt", Flags: 0x1}
	bzip2 := zip.FileHeader{Name: "raro.txt", Method: 12, CompressedSize64: 3, UncompressedSize64: 3}
	// Declares 5 bytes, inflates to 100 000: Go's reader stops it.
	var packed bytes.Buffer
	packed.Write(deflated(t, strings.Repeat("A", 100000)))
	liar := zip.FileHeader{Name: "miente.txt", Method: zip.Deflate,
		CompressedSize64: uint64(packed.Len()), UncompressedSize64: 5}

	for name, raw := range map[string][]byte{
		"texto.zip":  []byte("esto no es un zip"),
		"clave.zip":  makeZip(t, zipPart{h: locked, body: "x"}),
		"bzip2.zip":  makeZip(t, zipPart{h: bzip2, raw: []byte("abc")}),
		"vacio.zip":  makeZip(t),
		"miente.zip": makeZip(t, file("bien.txt", "ok"), zipPart{h: liar, raw: packed.Bytes()}),
		"grande.zip": makeZip(t, file("g.bin", strings.Repeat("0", 4096))),
	} {
		upload(t, client, ts.URL+"/api/files?file=files/"+name, raw)
	}

	for _, c := range []struct {
		method, query string
		want          int
	}{
		{"POST", "?file=files/texto.zip", http.StatusUnprocessableEntity},
		{"POST", "?file=files/clave.zip", http.StatusLocked},
		{"POST", "?file=files/bzip2.zip", http.StatusUnsupportedMediaType},
		{"POST", "?file=files/vacio.zip", http.StatusUnprocessableEntity},
		{"POST", "?file=files/miente.zip", http.StatusUnprocessableEntity},
		{"POST", "?file=files/nada.zip", http.StatusNotFound},
		{"POST", "?file=../../etc/x.zip", http.StatusForbidden},
		{"POST", "", http.StatusBadRequest},
		{"PUT", "?file=files/clave.zip", http.StatusMethodNotAllowed},
	} {
		if code, a := callZip(t, client, c.method, ts.URL+"/api/zip"+c.query); code != c.want {
			t.Errorf("%s %s = %d %v, want %d", c.method, c.query, code, a, c.want)
		}
	}
	for _, dir := range []string{"texto", "clave", "bzip2", "vacio", "miente"} {
		if pathExists(filepath.Join(files, dir)) {
			t.Errorf("a refused %s.zip left its folder", dir)
		}
	}
	if _, list := callZip(t, client, "GET", ts.URL+"/api/zip?file=files/clave.zip"); list["locked"] != true {
		t.Errorf("the list of a zip with a password = %v, want locked", list)
	}
	if _, list := callZip(t, client, "GET", ts.URL+"/api/zip?file=files/bzip2.zip"); list["unsupported"] != true {
		t.Errorf("the list of a bzip2 zip = %v, want unsupported", list)
	}

	// Quota: 4 096 bytes do not fit in what is left of ~2 KB.
	os.WriteFile(filepath.Join(home, "data", "config.json"),
		[]byte(`{"password":"abc","quota":0.000002}`), 0o644)
	srv.users.ForgetUsage("")
	if code, a := callZip(t, client, "POST", ts.URL+"/api/zip?file=files/grande.zip"); code != http.StatusInsufficientStorage {
		t.Errorf("past the quota = %d %v, want 507", code, a)
	}
	if pathExists(filepath.Join(files, "grande")) {
		t.Error("a zip past the quota left its folder")
	}

	// An "add" grant lends a folder to drop files in, not to make folders in.
	os.MkdirAll(filepath.Join(files, "buzon"), 0o755)
	os.WriteFile(filepath.Join(files, "buzon", "p.zip"), makeZip(t, file("a.txt", "a")), 0o644)
	g := srv.shares.Create("ana", "beto", "files/buzon", "", "Buzón", "add")
	if g == nil {
		t.Fatal("Create refused")
	}
	signIn(t, client, ts.URL, "beto", "xyz")
	url := ts.URL + "/api/zip?file=shared/" + g.Slug + "/p.zip"
	if code, list := callZip(t, client, "GET", url); code != http.StatusOK || list["into"] != "" {
		t.Errorf("guest GET = %d %v, want 200 with no folder to make", code, list)
	}
	if code, _ := callZip(t, client, "POST", url); code != http.StatusForbidden {
		t.Errorf("guest POST = %d, want 403", code)
	}
	if pathExists(filepath.Join(files, "buzon", "p")) {
		t.Error("a guest unpacked into a shared folder")
	}
}

// deflated is `s` compressed on its own, as a zip entry's raw bytes.
func deflated(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.CreateHeader(&zip.FileHeader{Name: "t", Method: zip.Deflate})
	io.WriteString(w, s)
	zw.Close()
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	rc, _ := zr.File[0].OpenRaw()
	raw, _ := io.ReadAll(rc)
	return raw
}

func TestDecodeCP850(t *testing.T) {
	if got := decodeCP850("a\xa4o \xb5rbol \x90l \xa5"); got != "año Árbol Él Ñ" {
		t.Errorf("decodeCP850 = %q", got)
	}
}

// zipNames is what a .zip on disk holds: name -> content ("" for a folder),
// and the method of each entry.
func zipNames(t *testing.T, file string) (map[string]string, map[string]uint16) {
	t.Helper()
	zr, err := zip.OpenReader(file)
	if err != nil {
		t.Fatalf("open %s: %v", file, err)
	}
	defer zr.Close()
	body, method := map[string]string{}, map[string]uint16{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("%s in %s: %v", f.Name, file, err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		body[f.Name], method[f.Name] = string(b), f.Method
	}
	return body, method
}

func compress(t *testing.T, client *http.Client, base string, paths ...string) (int, map[string]any) {
	t.Helper()
	q := url.Values{}
	for _, p := range paths {
		q.Add("paths", p)
	}
	return callZip(t, client, "POST", base+"/api/zip?"+q.Encode())
}

// TestZipCompress - what is picked goes into ONE new .zip beside it, with
// the shape an extract gives back; nothing already there is written over.
func TestZipCompress(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	when := time.Date(2021, 3, 4, 5, 6, 0, 0, time.UTC)
	fotos := filepath.Join(files, "Fotos")
	os.MkdirAll(filepath.Join(fotos, "viaje"), 0o755)
	os.MkdirAll(filepath.Join(fotos, "vacia"), 0o755)
	os.WriteFile(filepath.Join(fotos, "x.jpg"), []byte("jpeg"), 0o644)
	os.WriteFile(filepath.Join(fotos, "viaje", "y.txt"), []byte(strings.Repeat("y", 1000)), 0o644)
	os.Chtimes(filepath.Join(fotos, "x.jpg"), when, when)
	os.WriteFile(filepath.Join(fotos, ".upload-abcdefgh"), []byte("a medias"), 0o600)
	os.Symlink("/etc/passwd", filepath.Join(fotos, "enlace"))
	os.WriteFile(filepath.Join(files, "nota.txt"), []byte("nota"), 0o644)

	code, got := compress(t, client, ts.URL, "files/Fotos")
	if code != http.StatusOK || got["path"] != "files/Fotos.zip" || got["files"] != 2.0 {
		t.Fatalf("compress Fotos = %d %v", code, got)
	}
	body, method := zipNames(t, filepath.Join(files, "Fotos.zip"))
	want := map[string]string{"Fotos/": "", "Fotos/vacia/": "", "Fotos/viaje/": "",
		"Fotos/x.jpg": "jpeg", "Fotos/viaje/y.txt": strings.Repeat("y", 1000)}
	if len(body) != len(want) {
		t.Errorf("zip holds %v, want %v", body, want)
	}
	for k, v := range want {
		if b, ok := body[k]; !ok || b != v {
			t.Errorf("%s = %q (in zip: %v)", k, b, ok)
		}
	}
	if method["Fotos/x.jpg"] != zip.Store || method["Fotos/viaje/y.txt"] != zip.Deflate {
		t.Errorf("methods = %v, want the jpg stored and the text deflated", method)
	}
	if info, err := os.Stat(filepath.Join(files, "Fotos.zip")); err != nil || info.Mode().Perm() != 0o644 {
		t.Errorf("the zip's mode = %v, want 0644", info.Mode())
	}

	// Taken: "Fotos (2).zip", the first one untouched.
	before, _ := os.ReadFile(filepath.Join(files, "Fotos.zip"))
	if code, got := compress(t, client, ts.URL, "files/Fotos"); code != http.StatusOK || got["path"] != "files/Fotos (2).zip" {
		t.Errorf("second compress = %d %v", code, got)
	}
	if after, _ := os.ReadFile(filepath.Join(files, "Fotos.zip")); !bytes.Equal(before, after) {
		t.Error("the first zip was written over")
	}

	// Round trip: extracting it gives the folder back, date included.
	if code, got := callZip(t, client, "POST", ts.URL+"/api/zip?file=files/Fotos.zip"); code != http.StatusOK || got["path"] != "files/Fotos (2)" {
		t.Fatalf("extract = %d %v", code, got)
	}
	back := filepath.Join(files, "Fotos (2)")
	if readText(t, filepath.Join(back, "viaje", "y.txt")) != strings.Repeat("y", 1000) || !pathExists(filepath.Join(back, "vacia")) {
		t.Error("the round trip lost something")
	}
	if info, err := os.Stat(filepath.Join(back, "x.jpg")); err != nil || !info.ModTime().Equal(when) {
		t.Errorf("x.jpg came back dated %v, want %v", info.ModTime(), when)
	}

	// A file and a folder: named after the FIRST, a file without its extension.
	if code, got := compress(t, client, ts.URL, "files/nota.txt", "files/Fotos"); code != http.StatusOK || got["path"] != "files/nota.zip" {
		t.Errorf("two items = %d %v", code, got)
	}
	if body, _ := zipNames(t, filepath.Join(files, "nota.zip")); body["nota.txt"] != "nota" || body["Fotos/x.jpg"] != "jpeg" {
		t.Errorf("nota.zip holds %v", body)
	}

	// The same name from two folders (a search can pick both).
	os.MkdirAll(filepath.Join(files, "a"), 0o755)
	os.MkdirAll(filepath.Join(files, "b"), 0o755)
	os.WriteFile(filepath.Join(files, "a", "n.txt"), []byte("A"), 0o644)
	os.WriteFile(filepath.Join(files, "b", "n.txt"), []byte("B"), 0o644)
	if code, got := compress(t, client, ts.URL, "files/a/n.txt", "files/b/n.txt"); code != http.StatusOK || got["path"] != "files/a/n.zip" {
		t.Errorf("same names = %d %v", code, got)
	}
	if body, _ := zipNames(t, filepath.Join(files, "a", "n.zip")); body["n.txt"] != "A" || body["n (2).txt"] != "B" {
		t.Errorf("n.zip holds %v", body)
	}
	for _, dir := range []string{files, filepath.Join(files, "a")} {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".convert-") {
				t.Errorf("a temp was left in %s: %s", dir, e.Name())
			}
		}
	}
}

// TestZipCompressRefusals - nothing is made when the answer is no.
func TestZipCompressRefusals(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	home := filepath.Join(srv.cfg.HomesDir, "ana")
	files := filepath.Join(home, "files")
	os.WriteFile(filepath.Join(files, "grande.bin"), []byte(strings.Repeat("0", 4096)), 0o644)

	for _, c := range []struct {
		paths []string
		want  int
	}{
		{[]string{""}, http.StatusBadRequest},
		{[]string{"files/nada"}, http.StatusNotFound},
		{[]string{"../../etc/passwd"}, http.StatusForbidden},
		{[]string{"files/mio.txt", "../beto/files/suyo.txt"}, http.StatusForbidden},
	} {
		if code, a := compress(t, client, ts.URL, c.paths...); code != c.want {
			t.Errorf("compress %v = %d %v, want %d", c.paths, code, a, c.want)
		}
	}
	if pathExists(filepath.Join(files, "mio.zip")) {
		t.Error("a refused compress made its zip")
	}

	// Quota: 4 096 bytes do not fit in ~2 KB.
	os.WriteFile(filepath.Join(home, "data", "config.json"),
		[]byte(`{"password":"abc","quota":0.000002}`), 0o644)
	srv.users.ForgetUsage("")
	if code, a := compress(t, client, ts.URL, "files/grande.bin"); code != http.StatusInsufficientStorage {
		t.Errorf("past the quota = %d %v, want 507", code, a)
	}
	if pathExists(filepath.Join(files, "grande.zip")) {
		t.Error("a zip past the quota was made")
	}

	// A guest on an "add" grant: never a new zip in the owner's folder.
	os.WriteFile(filepath.Join(home, "data", "config.json"), []byte(`{"password":"abc"}`), 0o644)
	os.MkdirAll(filepath.Join(files, "buzon"), 0o755)
	os.WriteFile(filepath.Join(files, "buzon", "p.txt"), []byte("p"), 0o644)
	g := srv.shares.Create("ana", "beto", "files/buzon", "", "Buzón", "add")
	if g == nil {
		t.Fatal("Create refused")
	}
	signIn(t, client, ts.URL, "beto", "xyz")
	if code, _ := compress(t, client, ts.URL, "shared/"+g.Slug+"/p.txt"); code != http.StatusForbidden {
		t.Errorf("guest compress = %d, want 403", code)
	}
	if pathExists(filepath.Join(files, "buzon", "p.zip")) {
		t.Error("a guest made a zip in a shared folder")
	}
}
