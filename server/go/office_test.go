package main

// =============================================================================
// LibreOffice twins, end to end: an .odt / .ods becomes a .docx / .xlsx beside
// it, an existing twin is reused, and a document linked to someone else's file
// does NOT pull that file in. The conversions need soffice and are skipped
// without it; the refusals do not.
// =============================================================================

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func needSoffice(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("soffice"); err != nil {
		t.Skip("soffice not installed")
	}
}

// Flat OpenDocument: the whole document in one XML file - no zip to build.
const flatHead = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 xmlns:xlink="http://www.w3.org/1999/xlink"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.%s">
<office:body>`

func flatODT(body string) []byte {
	return []byte(fmt.Sprintf(flatHead, "text") + "<office:text>" + body +
		"</office:text></office:body></office:document>")
}

func flatODS(body string) []byte {
	return []byte(fmt.Sprintf(flatHead, "spreadsheet") + "<office:spreadsheet>" + body +
		"</office:spreadsheet></office:body></office:document>")
}

// zipEntries is every file inside a zip, by name.
func zipEntries(t *testing.T, raw []byte) map[string][]byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	out := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = b
	}
	return out
}

// zipText is every file inside a zip, joined: enough to look for a word.
func zipText(t *testing.T, raw []byte) string {
	t.Helper()
	var sb strings.Builder
	for _, b := range zipEntries(t, raw) {
		sb.Write(b)
	}
	return sb.String()
}

func postOffice(t *testing.T, client *http.Client, url string) (int, map[string]any) {
	t.Helper()
	resp := do(t, client, "POST", url, nil, nil)
	defer resp.Body.Close()
	var answer map[string]any
	json.NewDecoder(resp.Body).Decode(&answer)
	return resp.StatusCode, answer
}

// odfFromFlat turns a flat document into the real, zipped kind (`ext` "odt"
// or "ods") with LibreOffice itself: what users actually upload, and what the
// forced writer8 / calc8 filters must read.
func odfFromFlat(t *testing.T, flat []byte, flatExt, ext string) []byte {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "doc"+flatExt)
	os.WriteFile(src, flat, 0o644)
	cmd := exec.Command("soffice",
		"-env:UserInstallation="+(&url.URL{Scheme: "file", Path: filepath.Join(dir, "profile")}).String(),
		"--headless", "--norestore", "--convert-to", ext, "--outdir", dir, src)
	cmd.Env = append(os.Environ(), "HOME="+dir)
	if msg, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("making the test .%s: %v\n%s", ext, err, msg)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "doc."+ext))
	if err != nil || !bytes.HasPrefix(raw, []byte("PK\x03\x04")) {
		t.Fatalf("no zipped .%s made: %v", ext, err)
	}
	return raw
}

func TestOfficeTwinName(t *testing.T) {
	for name, want := range map[string]string{
		"carta.odt": "carta.docx", "Hoja.ODS": "Hoja.xlsx", "a.b.fodt": "a.b.docx",
		"plantilla.ott": "plantilla.docx", "vieja.sxc": "vieja.xlsx",
		"charla.odp": "", "dibujo.odg": "", "formula.odf": "", "base.odb": "",
		"carta.docx": "", "odt": "", ".odt": "",
	} {
		got, ok := OfficeTwinName(name)
		if got != want || ok != (want != "") {
			t.Errorf("OfficeTwinName(%q) = %q, %v; want %q", name, got, ok, want)
		}
	}
}

func TestOfficeConvert(t *testing.T) {
	needSoffice(t)
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	resp := do(t, client, "GET", ts.URL+"/api/office", nil, nil)
	var st map[string]any
	json.NewDecoder(resp.Body).Decode(&st)
	resp.Body.Close()
	if st["available"] != true {
		t.Fatalf("GET /api/office = %v, want available", st)
	}

	odt := flatODT(`<text:p>Hola Nayive</text:p>`)
	upload(t, client, ts.URL+"/api/files?file=files/Docs/carta.fodt", odt)

	start := time.Now()
	code, a := postOffice(t, client, ts.URL+"/api/office?file=files/Docs/carta.fodt")
	t.Logf("first conversion (makes the profile): %v", time.Since(start).Round(time.Millisecond))
	if code != http.StatusOK || a["path"] != "files/Docs/carta.docx" || a["converted"] != true {
		t.Fatalf("POST = %d %v", code, a)
	}
	docs := filepath.Join(srv.cfg.HomesDir, "ana", "files", "Docs")
	docx := filepath.Join(docs, "carta.docx")
	raw, err := os.ReadFile(docx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(zipText(t, raw), "Hola Nayive") {
		t.Fatal("the docx does not hold the text")
	}
	if info, _ := os.Stat(docx); info.Mode().Perm() != 0o644 {
		t.Errorf("docx mode %v, want 0644", info.Mode().Perm())
	}
	if orig, _ := os.ReadFile(filepath.Join(docs, "carta.fodt")); !bytes.Equal(orig, odt) {
		t.Fatal("the original was touched")
	}

	// Asked again (a double-click): the twin is the answer, left as it is.
	old := time.Now().Add(-time.Hour).Truncate(time.Second)
	os.Chtimes(docx, old, old)
	code, a = postOffice(t, client, ts.URL+"/api/office?file=files/Docs/carta.fodt")
	if code != http.StatusOK || a["converted"] != false || a["path"] != "files/Docs/carta.docx" {
		t.Fatalf("second POST = %d %v, want the existing twin", code, a)
	}
	if info, _ := os.Stat(docx); !info.ModTime().Equal(old) {
		t.Fatal("an existing twin was rewritten without replace=1")
	}

	// An upload (replace=1) always converts again.
	start = time.Now()
	code, a = postOffice(t, client, ts.URL+"/api/office?file=files/Docs/carta.fodt&replace=1")
	t.Logf("second conversion: %v", time.Since(start).Round(time.Millisecond))
	if code != http.StatusOK || a["converted"] != true {
		t.Fatalf("POST replace=1 = %d %v", code, a)
	}
	if info, _ := os.Stat(docx); info.ModTime().Equal(old) {
		t.Fatal("replace=1 did not write the twin again")
	}

	// Calc.
	upload(t, client, ts.URL+"/api/files?file=files/Docs/cuentas.fods", flatODS(
		`<table:table table:name="Hoja1"><table:table-row>
		 <table:table-cell office:value-type="string"><text:p>Hola Calc</text:p></table:table-cell>
		 <table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell>
		 </table:table-row></table:table>`))
	code, a = postOffice(t, client, ts.URL+"/api/office?file=files/Docs/cuentas.fods")
	if code != http.StatusOK || a["path"] != "files/Docs/cuentas.xlsx" {
		t.Fatalf("POST .fods = %d %v", code, a)
	}
	raw, _ = os.ReadFile(filepath.Join(docs, "cuentas.xlsx"))
	if txt := zipText(t, raw); !strings.Contains(txt, "Hola Calc") || !strings.Contains(txt, "42") {
		t.Fatal("the xlsx does not hold the cells")
	}

	// What users really upload: the zipped kinds, read through writer8 / calc8.
	for _, c := range []struct {
		name, twin, text string
		raw              []byte
	}{
		{"real.odt", "real.docx", "Texto de verdad",
			odfFromFlat(t, flatODT(`<text:p>Texto de verdad</text:p>`), ".fodt", "odt")},
		{"real.ods", "real.xlsx", "Celda de verdad",
			odfFromFlat(t, flatODS(`<table:table table:name="Hoja1"><table:table-row>
			 <table:table-cell office:value-type="string"><text:p>Celda de verdad</text:p></table:table-cell>
			 </table:table-row></table:table>`), ".fods", "ods")},
	} {
		upload(t, client, ts.URL+"/api/files?file=files/Docs/"+c.name, c.raw)
		code, a := postOffice(t, client, ts.URL+"/api/office?file=files/Docs/"+c.name)
		if code != http.StatusOK || a["path"] != "files/Docs/"+c.twin {
			t.Fatalf("POST %s = %d %v", c.name, code, a)
		}
		raw, _ := os.ReadFile(filepath.Join(docs, c.twin))
		if !strings.Contains(zipText(t, raw), c.text) {
			t.Fatalf("%s does not hold %q", c.twin, c.text)
		}
	}

	entries, _ := os.ReadDir(docs)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".convert-") {
			t.Fatalf("temp left behind: %s", e.Name())
		}
	}
}

// Anything that is not really the kind its name says fails with 422 and
// leaves nothing behind. Left to guess, LibreOffice converted all three.
func TestOfficeBrokenDocument(t *testing.T) {
	needSoffice(t)
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	docs := map[string][]byte{
		"roto.odt": []byte("esto no es un documento"),
		// HTML behind an .odt name - HTML can link to other files.
		"pagina.odt": []byte(`<html><body><p>hola</p><img src="file:///etc/hostname"></body></html>`),
		"hoja.ods":   []byte("a,b,c\n1,2,3\n"), // a csv behind an .ods name
	}
	for name, body := range docs {
		upload(t, client, ts.URL+"/api/files?file=files/"+name, body)
		if code, a := postOffice(t, client, ts.URL+"/api/office?file=files/"+name); code != http.StatusUnprocessableEntity {
			t.Errorf("%s: POST = %d %v, want 422", name, code, a)
		}
		if raw, _ := os.ReadFile(filepath.Join(files, name)); !bytes.Equal(raw, body) {
			t.Errorf("%s: the original was touched", name)
		}
	}
	entries, _ := os.ReadDir(files)
	for _, e := range entries {
		if n := e.Name(); strings.HasPrefix(n, ".convert-") ||
			strings.HasSuffix(n, ".docx") || strings.HasSuffix(n, ".xlsx") {
			t.Errorf("left behind: %s", n)
		}
	}
}

// The door this could open: a document that LINKS to another file on the
// server. Converting it must keep the copy saved inside the document, never
// read the linked file - here "bea's" secret, which ana could not read herself.
func TestOfficeDoesNotFollowLinks(t *testing.T) {
	needSoffice(t)
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	const secret = "SECRETO-DE-BEA"
	dir := t.TempDir()
	link := func(name string) string {
		return (&url.URL{Scheme: "file", Path: filepath.Join(dir, name)}).String()
	}
	os.WriteFile(filepath.Join(dir, "secreto.fodt"), flatODT(`<text:p>`+secret+`</text:p>`), 0o644)
	os.WriteFile(filepath.Join(dir, "secreto.csv"), []byte(secret+"\n"), 0o644)
	var pic bytes.Buffer
	png.Encode(&pic, image.NewRGBA(image.Rect(0, 0, 7, 3)))
	os.WriteFile(filepath.Join(dir, "secreto.png"), pic.Bytes(), 0o644)

	// Writer: a section linked to the secret document, and a linked picture.
	upload(t, client, ts.URL+"/api/files?file=files/enlace.fodt", flatODT(
		`<text:p>Antes</text:p>
		 <text:section text:name="S1">
		  <text:section-source xlink:type="simple" xlink:href="`+link("secreto.fodt")+`"/>
		  <text:p>COPIA-GUARDADA</text:p>
		 </text:section>
		 <text:p><draw:frame draw:name="F1" text:anchor-type="as-char" svg:width="2cm" svg:height="1cm">
		  <draw:image xlink:type="simple" xlink:href="`+link("secreto.png")+`" xlink:show="embed" xlink:actuate="onLoad"/>
		 </draw:frame></text:p>`))
	code, a := postOffice(t, client, ts.URL+"/api/office?file=files/enlace.fodt")
	if code != http.StatusOK {
		t.Fatalf("POST .fodt = %d %v", code, a)
	}
	raw, _ := os.ReadFile(filepath.Join(srv.cfg.HomesDir, "ana", "files", "enlace.docx"))
	entries := zipEntries(t, raw)
	txt := zipText(t, raw)
	if strings.Contains(txt, secret) {
		t.Fatal("the linked section was READ: another file's text is inside the docx")
	}
	if !strings.Contains(txt, "COPIA-GUARDADA") {
		t.Fatal("the section's saved copy is gone - the test proves nothing")
	}
	for name := range entries {
		if strings.HasPrefix(name, "word/media/") {
			t.Fatalf("the linked picture was pulled in as %s", name)
		}
	}

	// Calc: a sheet linked to the secret csv.
	upload(t, client, ts.URL+"/api/files?file=files/enlace.fods", flatODS(
		`<table:table table:name="Hoja1">
		  <table:table-source xlink:type="simple" xlink:href="`+link("secreto.csv")+`"
		   table:filter-name="Text - txt - csv (StarCalc)" table:mode="copy-all"/>
		  <table:table-row><table:table-cell office:value-type="string"><text:p>COPIA-GUARDADA</text:p></table:table-cell></table:table-row>
		 </table:table>`))
	code, a = postOffice(t, client, ts.URL+"/api/office?file=files/enlace.fods")
	if code != http.StatusOK {
		t.Fatalf("POST .fods = %d %v", code, a)
	}
	raw, _ = os.ReadFile(filepath.Join(srv.cfg.HomesDir, "ana", "files", "enlace.xlsx"))
	txt = zipText(t, raw)
	if strings.Contains(txt, secret) {
		t.Fatal("the linked sheet was READ: another file's cells are inside the xlsx")
	}
	if !strings.Contains(txt, "COPIA-GUARDADA") {
		t.Fatal("the sheet's saved copy is gone - the test proves nothing")
	}
}

// What the endpoint refuses, with or without LibreOffice.
func TestOfficeRefusals(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	upload(t, client, ts.URL+"/api/files?file=files/nota.txt", []byte("hola"))
	for _, c := range []struct {
		method, query string
		want          int
	}{
		{"POST", "?file=files/nota.txt", http.StatusBadRequest},   // not LibreOffice
		{"POST", "?file=files/charla.odp", http.StatusBadRequest}, // Impress: never
		{"POST", "?file=files/nada.odt", http.StatusNotFound},     // no such file
		{"POST", "?file=../../etc/x.odt", http.StatusForbidden},   // out of the home
		{"POST", "", http.StatusBadRequest},                       // no ?file=
		{"PUT", "?file=files/nada.odt", http.StatusMethodNotAllowed},
	} {
		resp := do(t, client, c.method, ts.URL+"/api/office"+c.query, nil, nil)
		resp.Body.Close()
		if resp.StatusCode != c.want {
			t.Errorf("%s %s = %d, want %d", c.method, c.query, resp.StatusCode, c.want)
		}
	}

	// A folder where the twin would go: 409, nothing replaced.
	upload(t, client, ts.URL+"/api/files?file=files/b.odt", []byte("x"))
	os.Mkdir(filepath.Join(files, "b.docx"), 0o755)
	if code, a := postOffice(t, client, ts.URL+"/api/office?file=files/b.odt"); code != http.StatusConflict {
		t.Errorf("twin name taken by a folder = %d %v, want 409", code, a)
	}

}

// LibreOffice missing: a twin that exists is still the answer; making one is a
// 503. The field is set before the first request, so no handler reads it while
// it changes.
func TestOfficeWithoutLibreOffice(t *testing.T) {
	srv, ts, client := newTestServer(t)
	srv.office.soffice = ""
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	upload(t, client, ts.URL+"/api/files?file=files/a.odt", []byte("x"))
	if code, a := postOffice(t, client, ts.URL+"/api/office?file=files/a.odt"); code != http.StatusServiceUnavailable {
		t.Errorf("no soffice, no twin = %d %v, want 503", code, a)
	}
	os.WriteFile(filepath.Join(files, "a.docx"), []byte("hecho antes"), 0o644)
	if code, a := postOffice(t, client, ts.URL+"/api/office?file=files/a.odt"); code != http.StatusOK ||
		a["path"] != "files/a.docx" || a["converted"] != false {
		t.Errorf("no soffice, twin there = %d %v, want the twin", code, a)
	}
	resp := do(t, client, "GET", ts.URL+"/api/office", nil, nil)
	var st map[string]any
	json.NewDecoder(resp.Body).Decode(&st)
	resp.Body.Close()
	if st["available"] != false {
		t.Errorf("GET /api/office = %v, want not available", st)
	}
}
