package main

// Data-safety seal (cleanup Phase 3, batch S5): every file has a real version
// tag (ETag: inode + size + mtime in ns) and a save made from an old version
// is refused (If-Match -> 412). The server half of "each page keeps its own
// version" (groups A, B, C of the audit):
//   B1 an older version restored from the bin     B2 a file moved onto the path
//   B3 any change not made by a PUT: a direct disk write in the held second,
//      a zip extract with old dates, the Office twin made again
// plus the contract the browser half is built on (etag.go).
//
// These tests speak HTTP only: they compile on the code before the tag, and
// fail there (no ETag, If-Match ignored).

import (
	"archive/zip"
	"compress/gzip"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// dsPutTag PUTs `body` to `rel` and answers the status and the ETag the
// answer carries ("" when none).
func dsPutTag(t *testing.T, client *http.Client, base, rel, body string, h map[string]string) (int, string) {
	t.Helper()
	resp := do(t, client, "PUT", base+"/api/files?file="+rel, strings.NewReader(body), h)
	resp.Body.Close()
	return resp.StatusCode, resp.Header.Get("ETag")
}

// dsGetTag answers the ETag a plain GET of `rel` carries.
func dsGetTag(t *testing.T, client *http.Client, base, rel string) string {
	t.Helper()
	resp := do(t, client, "GET", base+"/api/files?file="+rel, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d", rel, resp.StatusCode)
	}
	return resp.Header.Get("ETag")
}

// dsHeld is the tag an editor holds. None at all is an error of its own; a
// stand-in keeps the test going, so it also shows what the save then did.
func dsHeld(t *testing.T, tag, what string) string {
	t.Helper()
	if tag == "" {
		t.Errorf("%s answered no ETag", what)
		return `"no-tag-answered"`
	}
	return tag
}

// TestDS_B1_RestoreOlderVersionRefused: an editor holds v2; in Drive v2 is
// binned and an OLDER copy (v1) restored in place. It keeps its old time, so
// If-Unmodified-Since let the editor's next save write over it - and v1 had
// already left the bin. With the tag the save is refused.
func TestDS_B1_RestoreOlderVersionRefused(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	p := filepath.Join(srv.cfg.HomesDir, "ana", "files", "informe.txt")
	const v1 = "v1 - the version he wants back"

	os.WriteFile(p, []byte(v1), 0o644)
	old := time.Now().Add(-10 * time.Second)
	os.Chtimes(p, old, old)
	v1ids := dsBinIDs(t, client, ts.URL, "files/informe.txt")

	// v2, saved by the editor: it keeps this tag.
	code, tag := dsPutTag(t, client, ts.URL, "files/informe.txt", "v2", nil)
	if code != http.StatusOK {
		t.Fatalf("v2 PUT = %d", code)
	}
	held := dsHeld(t, tag, "the v2 PUT")

	// In Drive: bin v2, restore v1 in place.
	dsBinIDs(t, client, ts.URL, "files/informe.txt")
	jsonCall(t, client, "POST", ts.URL+"/api/files?trash=restore&ids="+v1ids[0], "", 200, nil)
	if dsRead(p) != v1 {
		t.Fatalf("the restore did not bring v1 back: %q", dsRead(p))
	}

	code, _ = dsPutTag(t, client, ts.URL, "files/informe.txt", "v2 + more typing",
		map[string]string{"If-Match": held})
	if code != http.StatusPreconditionFailed {
		t.Errorf("the editor's save over the restored v1 = %d, want 412", code)
	}
	if got := dsRead(p); got != v1 {
		t.Errorf("restored v1 overwritten: file = %q", got)
	}
}

// TestDS_B2_MoveOntoHeldPathRefused: an editor holds acta.txt; in Drive it
// is binned and an older file moved onto its name (Drive's "Replace"). The
// moved file keeps its own time; the editor's save is refused.
func TestDS_B2_MoveOntoHeldPathRefused(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	const other = "the OTHER file's only copy"

	code, tag := dsPutTag(t, client, ts.URL, "files/acta.txt", "editor's acta", nil)
	if code != http.StatusOK {
		t.Fatalf("PUT = %d", code)
	}
	held := dsHeld(t, tag, "the PUT")

	b := filepath.Join(files, "otra.txt")
	os.WriteFile(b, []byte(other), 0o644)
	old := time.Now().Add(-time.Hour)
	os.Chtimes(b, old, old)

	dsBinIDs(t, client, ts.URL, "files/acta.txt")
	jsonCall(t, client, "POST", ts.URL+"/api/files?old=files/otra.txt&new=files/acta.txt", "", 200, nil)

	code, _ = dsPutTag(t, client, ts.URL, "files/acta.txt", "editor's acta + typing",
		map[string]string{"If-Match": held})
	if code != http.StatusPreconditionFailed {
		t.Errorf("the editor's save over the moved file = %d, want 412", code)
	}
	if got := dsRead(filepath.Join(files, "acta.txt")); got != other {
		t.Errorf("the moved file was overwritten: %q", got)
	}
}

// TestDS_B3_SameSecondDirectWriteRefused: bookmarks-test #10's case. Two
// quick saves put the file's time a second AHEAD of the clock (nextSecond);
// a change written straight to disk then (a server writer, an admin's
// script) gets a time at or before the held one, so If-Unmodified-Since
// cannot see it. The tag does: its time is in nanoseconds, and its size and
// inode are in it too.
func TestDS_B3_SameSecondDirectWriteRefused(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	p := filepath.Join(srv.cfg.HomesDir, "ana", "data", "marcas.json")
	os.MkdirAll(filepath.Dir(p), 0o755)
	const phone = `{"links":["a","x","y-from-the-phone"]}`

	dsPutTag(t, client, ts.URL, "data/marcas.json", `{"links":["a","x"]}`, nil)
	code, tag := dsPutTag(t, client, ts.URL, "data/marcas.json", `{"links":["a"]}`, nil)
	if code != http.StatusOK {
		t.Fatalf("PUT = %d", code)
	}
	held := dsHeld(t, tag, "the second PUT")

	// Straight to disk, in place: same inode, a time inside the held second.
	if err := os.WriteFile(p, []byte(phone), 0o644); err != nil {
		t.Fatal(err)
	}

	code, _ = dsPutTag(t, client, ts.URL, "data/marcas.json", `{"links":["a","z"]}`,
		map[string]string{"If-Match": held})
	if code != http.StatusPreconditionFailed {
		t.Errorf("a save from before the disk write = %d, want 412", code)
	}
	if got := dsRead(p); got != phone {
		t.Errorf("the disk write was overwritten: %q", got)
	}

	// The same, but the disk write keeps the SIZE: same inode, same size -
	// only the nanoseconds of its time tell it apart.
	const phone2 = `{"links":["a","w"]}` // as long as the save below
	code, tag = dsPutTag(t, client, ts.URL, "data/marcas.json", `{"links":["a","v"]}`, nil)
	if code != http.StatusOK {
		t.Fatalf("PUT = %d", code)
	}
	held = dsHeld(t, tag, "the third PUT")
	// The kernel's file clock moves in ticks of a few ms; a write inside the
	// same tick, of the same size, is the known limit (etag.go). So the one
	// fixed wait of this suite: the clock itself must move.
	time.Sleep(20 * time.Millisecond)
	if err := os.WriteFile(p, []byte(phone2), 0o644); err != nil {
		t.Fatal(err)
	}
	code, _ = dsPutTag(t, client, ts.URL, "data/marcas.json", `{"links":["a","u"]}`,
		map[string]string{"If-Match": held})
	if code != http.StatusPreconditionFailed {
		t.Errorf("a save from before a same-size disk write = %d, want 412", code)
	}
	if got := dsRead(p); got != phone2 {
		t.Errorf("the same-size disk write was overwritten: %q", got)
	}
}

// TestDS_B3_ExtractOldDateRefused: an editor holds Fotos/notas.txt; the
// folder is binned and a zip extracted that makes "Fotos/notas.txt" again,
// dated 2024 (an extract keeps the zip's dates). The editor's save is
// refused: the extracted file is another file.
func TestDS_B3_ExtractOldDateRefused(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	const fromZip = "notes from the 2024 zip"

	code, tag := dsPutTag(t, client, ts.URL, "files/Fotos/notas.txt", "editor's notes", nil)
	if code != http.StatusOK {
		t.Fatalf("PUT = %d", code)
	}
	held := dsHeld(t, tag, "the PUT")

	dsBinIDs(t, client, ts.URL, "files/Fotos")
	when := time.Date(2024, 5, 12, 10, 0, 0, 0, time.UTC)
	upload(t, client, ts.URL+"/api/files?file=files/Fotos.zip", makeZip(t,
		file("Fotos/", ""),
		zipPart{h: zip.FileHeader{Name: "Fotos/notas.txt", Modified: when}, body: fromZip}))
	if code, got := callZip(t, client, "POST", ts.URL+"/api/zip?file=files/Fotos.zip"); code != http.StatusOK || got["path"] != "files/Fotos" {
		t.Fatalf("extract = %d %v", code, got)
	}

	code, _ = dsPutTag(t, client, ts.URL, "files/Fotos/notas.txt", "editor's notes + typing",
		map[string]string{"If-Match": held})
	if code != http.StatusPreconditionFailed {
		t.Errorf("the editor's save over the extracted file = %d, want 412", code)
	}
	if got := dsRead(filepath.Join(files, "Fotos", "notas.txt")); got != fromZip {
		t.Errorf("the extracted file was overwritten: %q", got)
	}
}

// TestDS_B3_TwinReplaceRefused: Write holds x.docx; the LibreOffice twin is
// made again over it (an upload of x.odt, "replace"), with no PUT and so no
// nextSecond. The editor's next save is refused.
func TestDS_B3_TwinReplaceRefused(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	const twin = "PK the new twin from x.odt"

	code, tag := dsPutTag(t, client, ts.URL, "files/x.docx", "PK what Write saved", nil)
	if code != http.StatusOK {
		t.Fatalf("PUT = %d", code)
	}
	held := dsHeld(t, tag, "the PUT")

	made := filepath.Join(t.TempDir(), "x.docx")
	os.WriteFile(made, []byte(twin), 0o644)
	dst, ok := srv.users.Resolve("user", "ana", "files/x.docx")
	if !ok {
		t.Fatal("resolve files/x.docx")
	}
	if err := placeFile(made, dst, true); err != nil {
		t.Fatalf("placeFile: %v", err)
	}

	code, _ = dsPutTag(t, client, ts.URL, "files/x.docx", "PK Write's next save",
		map[string]string{"If-Match": held})
	if code != http.StatusPreconditionFailed {
		t.Errorf("Write's save over the new twin = %d, want 412", code)
	}
	if got := dsRead(dst.Abs); got != twin {
		t.Errorf("the new twin was overwritten: %q", got)
	}
}

// TestDS_ETag_StableAcrossRename: the tag a PUT answers is the one a GET
// then shows, and a plain move keeps it (same file: inode, size and time
// unchanged) - so a page may carry it to the new name. A save changes it.
func TestDS_ETag_StableAcrossRename(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	code, put := dsPutTag(t, client, ts.URL, "files/a.txt", "uno", nil)
	if code != http.StatusOK || put == "" {
		t.Fatalf("PUT = %d, ETag %q", code, put)
	}
	if got := dsGetTag(t, client, ts.URL, "files/a.txt"); got != put {
		t.Errorf("GET tag %q, the PUT answered %q", got, put)
	}
	jsonCall(t, client, "POST", ts.URL+"/api/files?old=files/a.txt&new=files/sub/b.txt", "", 200, nil)
	if got := dsGetTag(t, client, ts.URL, "files/sub/b.txt"); got != put {
		t.Errorf("after the move the tag is %q, want %q (same file)", got, put)
	}
	code, next := dsPutTag(t, client, ts.URL, "files/sub/b.txt", "dos", map[string]string{"If-Match": put})
	if code != http.StatusOK {
		t.Fatalf("a save carried to the new name = %d, want 200", code)
	}
	if next == "" || next == put {
		t.Errorf("a save answered tag %q (was %q): it must change", next, put)
	}
	if got := dsGetTag(t, client, ts.URL, "files/sub/b.txt"); got != next {
		t.Errorf("GET tag %q, the PUT answered %q", got, next)
	}
}

// TestDS_ETag_GetConditional: a GET with If-None-Match is answered 304 only
// for the exact tag, in both tiers (ServeContent for a small or binary file,
// the request-time gzip tier for a big text one). A change inside the same
// second as the cached copy - which If-Modified-Since cannot see - now comes
// back 200 with the new bytes (store-core G4). If-Modified-Since alone is
// never a 304 here (TestDS_ETag_NoDate304UnderATag says why). A gzipped
// answer offers no byte ranges.
func TestDS_ETag_GetConditional(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	for _, tier := range []struct {
		name, rel string
		body      string
		gzipped   bool
	}{
		{"ServeContent", "pequeno.txt", "small text", false},
		{"gzip tier", "grande.txt", strings.Repeat("una línea de texto\n", 200), true},
	} {
		p := filepath.Join(files, tier.rel)
		os.WriteFile(p, []byte(tier.body), 0o644)
		url := ts.URL + "/api/files?file=files/" + tier.rel
		get := func(h map[string]string) (*http.Response, string) {
			t.Helper()
			if h == nil {
				h = map[string]string{}
			}
			h["Accept-Encoding"] = "gzip"
			resp := do(t, client, "GET", url, nil, h)
			defer resp.Body.Close()
			var rd io.Reader = resp.Body
			if resp.Header.Get("Content-Encoding") == "gzip" {
				zr, err := gzip.NewReader(resp.Body)
				if err != nil {
					t.Fatalf("%s: bad gzip: %v", tier.name, err)
				}
				rd = zr
			}
			b, _ := io.ReadAll(rd)
			return resp, string(b)
		}

		first, body := get(nil)
		if first.StatusCode != http.StatusOK || body != tier.body {
			t.Fatalf("%s: GET = %d %q", tier.name, first.StatusCode, body)
		}
		if gz := first.Header.Get("Content-Encoding") == "gzip"; gz != tier.gzipped {
			t.Fatalf("%s: gzipped = %v - the test is not on the tier it names", tier.name, gz)
		}
		// Ranges are of the plain bytes: offered on a gzipped answer, a resumed
		// download would append plain bytes to gzip ones.
		if ranges := first.Header.Get("Accept-Ranges"); tier.gzipped && ranges != "" {
			t.Errorf("%s: a gzipped answer offers Accept-Ranges %q", tier.name, ranges)
		}
		lm := first.Header.Get("Last-Modified")
		tag := dsHeld(t, first.Header.Get("ETag"), tier.name+" GET")

		head := do(t, client, "HEAD", url, nil, nil)
		head.Body.Close()
		if head.Header.Get("ETag") != first.Header.Get("ETag") {
			t.Errorf("%s: HEAD tag %q, GET %q", tier.name, head.Header.Get("ETag"), first.Header.Get("ETag"))
		}
		if r, _ := get(map[string]string{"If-None-Match": tag}); r.StatusCode != http.StatusNotModified {
			t.Errorf("%s: If-None-Match with the tag = %d, want 304", tier.name, r.StatusCode)
		}
		if r, _ := get(map[string]string{"If-None-Match": `"other", W/` + tag}); r.StatusCode != http.StatusNotModified {
			t.Errorf("%s: a list holding the weak tag = %d, want 304", tier.name, r.StatusCode)
		}
		if r, _ := get(map[string]string{"If-None-Match": `"other"`, "If-Modified-Since": lm}); r.StatusCode != http.StatusOK {
			t.Errorf("%s: another tag, a current date = %d, want 200 (the tag decides)", tier.name, r.StatusCode)
		}
		if r, body := get(map[string]string{"If-Modified-Since": lm}); r.StatusCode != http.StatusOK || body != tier.body {
			t.Errorf("%s: If-Modified-Since alone = %d, want 200 with the bytes (never a 304 by date)", tier.name, r.StatusCode)
		}

		// A change written inside the same second: what a browser's cache
		// asks (both validators) must now get the new bytes.
		info, _ := os.Stat(p)
		changed := tier.body + "+ a change"
		os.WriteFile(p, []byte(changed), 0o644)
		same := info.ModTime().Truncate(time.Second)
		os.Chtimes(p, same, same)
		r, got := get(map[string]string{"If-None-Match": tag, "If-Modified-Since": lm})
		if r.StatusCode != http.StatusOK || got != changed {
			t.Errorf("%s: after a same-second change = %d %q, want 200 with the new bytes",
				tier.name, r.StatusCode, got)
		}
		if r.Header.Get("ETag") == "" || r.Header.Get("ETag") == tag {
			t.Errorf("%s: the changed file's tag is %q (was %q)", tier.name, r.Header.Get("ETag"), tag)
		}
	}
}

// TestDS_ETag_NoDate304UnderATag: a browser copy cached before the tag (a
// body and its Last-Modified only) revalidates with If-Modified-Since alone,
// after a change made inside that second by another writer. A 304 by date
// would hand out the CURRENT file's tag for the OLD body the browser keeps:
// its next save, If-Match with that tag, would pass over the change. So the
// file API never answers 304 by date: the browser gets the bytes the tag names.
func TestDS_ETag_NoDate304UnderATag(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	for _, tier := range []struct {
		name, rel, old string
		gzipped        bool
	}{
		{"ServeContent", "x.txt", "old cached body", false},
		{"gzip tier", "y.txt", strings.Repeat("old cached line\n", 200), true},
	} {
		p := filepath.Join(files, tier.rel)
		os.WriteFile(p, []byte(tier.old), 0o644)
		info, _ := os.Stat(p)
		cached := info.ModTime().UTC().Format(http.TimeFormat) // the old copy's Last-Modified

		changed := tier.old + "NEW, written in the same second"
		os.WriteFile(p, []byte(changed), 0o644)
		sec := info.ModTime().Truncate(time.Second)
		os.Chtimes(p, sec, sec)

		resp := do(t, client, "GET", ts.URL+"/api/files?file=files/"+tier.rel, nil,
			map[string]string{"If-Modified-Since": cached, "Accept-Encoding": "gzip"})
		var rd io.Reader = resp.Body
		gzipped := resp.Header.Get("Content-Encoding") == "gzip"
		if gzipped {
			zr, err := gzip.NewReader(resp.Body)
			if err != nil {
				t.Fatalf("%s: bad gzip: %v", tier.name, err)
			}
			rd = zr
		}
		body, _ := io.ReadAll(rd)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK && gzipped != tier.gzipped {
			t.Fatalf("%s: gzipped = %v - the test is not on the tier it names", tier.name, gzipped)
		}
		if resp.StatusCode != http.StatusOK || string(body) != changed {
			t.Errorf("%s: revalidation by date alone = %d (%d bytes), want 200 with the changed file",
				tier.name, resp.StatusCode, len(body))
		}
		tag := resp.Header.Get("ETag")
		if tag == "" {
			t.Errorf("%s: no ETag", tier.name)
		}
		// What the page holds now IS the version the tag names: its save passes.
		if code, _ := dsPutTag(t, client, ts.URL, "files/"+tier.rel, changed+" + an edit",
			map[string]string{"If-Match": tag}); code != http.StatusOK {
			t.Errorf("%s: a save from the bytes that came with the tag = %d, want 200", tier.name, code)
		}
	}
}

// TestDS_ETag_IfMatchMissingFile412: If-Match on a name with no file there
// is false (RFC 9110 13.1.1) - a tag or "*" alike - and nothing is made: the
// page then merges ("theirs missing") or offers to save a copy. A weak tag
// never passes If-Match, and a value that is not a tag fails closed.
func TestDS_ETag_IfMatchMissingFile412(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	p := filepath.Join(srv.cfg.HomesDir, "ana", "files", "nuevo.txt")

	for _, im := range []string{`"1-2-3"`, "*"} {
		code, _ := dsPutTag(t, client, ts.URL, "files/nuevo.txt", "made", map[string]string{"If-Match": im})
		if code != http.StatusPreconditionFailed {
			t.Errorf("If-Match %s on a missing file = %d, want 412", im, code)
		}
		if pathExists(p) {
			t.Fatalf("If-Match %s on a missing file made it", im)
		}
	}

	_, tag := dsPutTag(t, client, ts.URL, "files/nuevo.txt", "v1", nil)
	held := dsHeld(t, tag, "the PUT")
	for _, c := range []struct {
		im   string
		want int
	}{
		{"W/" + held, http.StatusPreconditionFailed}, // weak: never for a write
		{"not-a-tag", http.StatusPreconditionFailed}, // meant a condition: fail closed
		{`"a", ` + held + `, "b"`, http.StatusOK},    // one of a list
	} {
		code, next := dsPutTag(t, client, ts.URL, "files/nuevo.txt", "v-"+c.im, map[string]string{"If-Match": c.im})
		if code != c.want {
			t.Errorf("If-Match %s = %d, want %d", c.im, code, c.want)
		}
		if code == http.StatusOK {
			held = next
		}
	}
	if code, _ := dsPutTag(t, client, ts.URL, "files/nuevo.txt", "any", map[string]string{"If-Match": "*"}); code != http.StatusOK {
		t.Errorf("If-Match * on a file that exists = %d, want 200", code)
	}
}

// TestDS_ETag_IfMatchWinsOverIUS: a page that sends both is judged by the
// tag alone (RFC 9110 13.2.2): a current tag passes whatever the date says,
// a stale one is refused even when the date would pass (the B-cases).
func TestDS_ETag_IfMatchWinsOverIUS(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	put := func(body string, h map[string]string) *http.Response {
		t.Helper()
		resp := do(t, client, "PUT", ts.URL+"/api/files?file=files/c.txt", strings.NewReader(body), h)
		resp.Body.Close()
		return resp
	}
	tag := dsHeld(t, put("v1", nil).Header.Get("ETag"), "the PUT")
	hourAgo := time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat)

	r := put("v2", map[string]string{"If-Match": tag, "If-Unmodified-Since": hourAgo})
	if r.StatusCode != http.StatusOK {
		t.Errorf("current tag + stale date = %d, want 200", r.StatusCode)
	}
	// v1's tag is stale now; v2's own Last-Modified would pass on its own.
	r = put("v3", map[string]string{"If-Match": tag, "If-Unmodified-Since": r.Header.Get("Last-Modified")})
	if r.StatusCode != http.StatusPreconditionFailed {
		t.Errorf("stale tag + passing date = %d, want 412", r.StatusCode)
	}
	if got := dsGetBody(t, client, ts.URL, "files/c.txt"); got != "v2" {
		t.Errorf("file = %q, want v2", got)
	}
}

// dsGetBody answers the bytes a GET of `rel` carries.
func dsGetBody(t *testing.T, client *http.Client, base, rel string) string {
	t.Helper()
	resp := do(t, client, "GET", base+"/api/files?file="+rel, nil, nil)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

// TestDS_ETag_IfMatchCheckedAtPlacement: two saves from the same version,
// the first still streaming its body when the second lands: the first is
// refused at the rename (the check before its body passed).
func TestDS_ETag_IfMatchCheckedAtPlacement(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")

	_, tag := dsPutTag(t, client, ts.URL, "files/d.txt", "base", nil)
	held := dsHeld(t, tag, "the PUT")

	finish := dsSlowPut(t, client, ts.URL+"/api/files?file=files/d.txt", "the slow device's save",
		map[string]string{"If-Match": held})
	dsWaitTemp(t, files)
	if code, _ := dsPutTag(t, client, ts.URL, "files/d.txt", "the quick device's save",
		map[string]string{"If-Match": held}); code != http.StatusOK {
		t.Fatalf("the quick save = %d", code)
	}
	if code := finish(); code != http.StatusPreconditionFailed {
		t.Errorf("the slow save, from the same version = %d, want 412", code)
	}
	if got := dsRead(filepath.Join(files, "d.txt")); got != "the quick device's save" {
		t.Errorf("file = %q, want the quick save kept", got)
	}
}

// TestDS_ETag_OldClientsUnchanged: a page loaded before the tag (open across
// the deploy) sends If-Unmodified-Since only; it is judged exactly as
// before: a stale date 412, its own Last-Modified 200, a garbled or missing
// header no check, and two saves in one second still get different times.
// A COMPATIBILITY GUARD, not a red test: it passes on the old code by design
// (accepted in review) - it fails only if this batch changed old pages' rules.
func TestDS_ETag_OldClientsUnchanged(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	put := func(body string, h map[string]string) *http.Response {
		t.Helper()
		resp := do(t, client, "PUT", ts.URL+"/api/files?file=files/old.txt", strings.NewReader(body), h)
		resp.Body.Close()
		return resp
	}

	r1 := put("v1", nil)
	lm1 := r1.Header.Get("Last-Modified")
	hourAgo := time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat)
	if r := put("stale", map[string]string{"If-Unmodified-Since": hourAgo}); r.StatusCode != http.StatusPreconditionFailed {
		t.Errorf("stale date = %d, want 412", r.StatusCode)
	}
	r2 := put("v2", map[string]string{"If-Unmodified-Since": lm1})
	lm2 := r2.Header.Get("Last-Modified")
	if r2.StatusCode != http.StatusOK {
		t.Errorf("its own Last-Modified = %d, want 200", r2.StatusCode)
	}
	if lm1 == lm2 {
		t.Errorf("two saves share Last-Modified %q", lm1)
	}
	if r := put("v3", map[string]string{"If-Unmodified-Since": lm1}); r.StatusCode != http.StatusPreconditionFailed {
		t.Errorf("a save based on the first = %d, want 412", r.StatusCode)
	}
	if r := put("v4", map[string]string{"If-Unmodified-Since": "no es una fecha"}); r.StatusCode != http.StatusOK {
		t.Errorf("a garbled date = %d, want 200 (no check)", r.StatusCode)
	}
	if r := put("v5", nil); r.StatusCode != http.StatusOK {
		t.Errorf("no header = %d, want 200", r.StatusCode)
	}
	// Create-only still means create-only.
	if r := put("v6", map[string]string{"If-None-Match": "*"}); r.StatusCode != http.StatusPreconditionFailed {
		t.Errorf("If-None-Match * on a file that exists = %d, want 412", r.StatusCode)
	}
}
