package main

// =============================================================================
// Review of batch 3: the PNG/WebP cleaner stays linear (#6's spliceReader),
// and a picture name whose content the cleaner cannot walk is never lent raw.
// =============================================================================

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
	"testing/iotest"
)

// manyPieces is a PNG of `pairs` dropped and kept empty chunks, one piece each.
func manyPieces(pairs int) []byte {
	b := append([]byte(nil), pngSignature...)
	for i := 0; i < pairs; i++ {
		b = append(b, pngChunk("tEXt", nil)...)
		b = append(b, pngChunk("abCd", nil)...)
	}
	return append(b, pngChunk("IEND", nil)...)
}

// cleanFile runs data through cleanImage as a file named `name`.
func cleanFile(t *testing.T, name string, data []byte, ctype string) (io.ReadSeeker, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	os.WriteFile(path, data, 0o644)
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	info, _ := f.Stat()
	return cleanImage(path, f, info, ctype)
}

// TestSpliceReadFillsAcrossPieces: one Read fills the buffer across pieces -
// not one piece per call, which made the whole file quadratic.
func TestSpliceReadFillsAcrossPieces(t *testing.T) {
	data := manyPieces(50)
	r, err := cleanFile(t, "x.png", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	size, _ := r.Seek(0, io.SeekEnd)
	r.Seek(0, io.SeekStart)
	buf := make([]byte, size)
	if n, _ := r.Read(buf); int64(n) != size {
		t.Fatalf("one Read of %d bytes gave %d", size, n)
	}
	// ...and from the middle of a piece too.
	r.Seek(15, io.SeekStart)
	if n, _ := r.Read(buf[:40]); n != 40 {
		t.Fatalf("a Read from offset 15 gave %d of 40", n)
	}
	whole := spliced(t, data) // the Seek sweep still agrees
	if int64(len(whole)) != size {
		t.Fatalf("spliced %d, size %d", len(whole), size)
	}
}

// TestSpliceTooManyPiecesRefused: the reviewer's file - 80,000 dropped/kept
// pairs - is refused outright, not planned and served.
func TestSpliceTooManyPiecesRefused(t *testing.T) {
	if _, err := cleanFile(t, "x.png", manyPieces(80000), "image/png"); err == nil {
		t.Fatal("a PNG of 80,000 pieces was served")
	}
	w := append([]byte("RIFF\x00\x00\x00\x00WEBP"), []byte{}...)
	for i := 0; i < 5000; i++ {
		w = append(w, riffChunk("XMP ", nil)...)
		w = append(w, riffChunk("ABCD", nil)...)
	}
	w[4], w[5], w[6], w[7] = byte(len(w)-8), byte((len(w)-8)>>8), byte((len(w)-8)>>16), 0
	if _, err := cleanFile(t, "x.webp", w, "image/webp"); err == nil {
		t.Fatal("a WebP of 10,000 pieces was served")
	}
}

// TestCleanableNameNeedsCleanableContent: a .png / .webp / .jpg that is not a
// JPEG, PNG or WebP inside (a renamed HEIC, a TIFF) is refused; other names
// still go as they are.
func TestCleanableNameNeedsCleanableContent(t *testing.T) {
	tiff := []byte("MM\x00\x2a\x00\x00\x00\x08GPS-TIFF")
	for _, c := range []struct{ name, ctype string }{
		{"x.png", "image/png"}, {"x.webp", "image/webp"}, {"x.jpg", "image/jpeg"},
	} {
		if _, err := cleanFile(t, c.name, tiff, c.ctype); err == nil {
			t.Errorf("%s holding a TIFF was lent", c.name)
		}
	}
	r, err := cleanFile(t, "x.gif", []byte("GIF89a"), "image/gif")
	if err != nil {
		t.Fatalf("a GIF: %v", err)
	}
	if got, _ := io.ReadAll(r); !bytes.Equal(got, []byte("GIF89a")) {
		t.Errorf("a GIF = %q, want it as it is", got)
	}
}

// TestPublicPhotoRenamedTIFFIs404: the same, through a public link.
func TestPublicPhotoRenamedTIFFIs404(t *testing.T) {
	srv, base, _, link := makeLink(t)
	dir := filepath.Join(srv.cfg.HomesDir, "ana", "files", "fotos", "porto")
	for _, name := range []string{"falso.png", "falso.webp", "falso.jpg"} {
		os.WriteFile(filepath.Join(dir, name), []byte("MM\x00\x2a\x00\x00\x00\x08GPS-TIFF"), 0o644)
		resp := do(t, anonymous(), "GET", base+"/api/public/"+link.Token+"/photo/"+name, nil, nil)
		body := readBody(t, resp)
		if resp.StatusCode != 404 || bytes.Contains(body, []byte("GPS-")) {
			t.Errorf("a TIFF named %s = %d %q, want 404", name, resp.StatusCode, body)
		}
	}
}

// tinyPNG is a PNG with nothing in it: the signature and IEND.
var tinyPNG = append(append([]byte(nil), pngSignature...), pngChunk("IEND", nil)...)

// FuzzSpliceReader (the reviewer's): whatever the bytes, a planned PNG or WebP
// reads to exactly its size, straight through and in one-byte Reads.
func FuzzSpliceReader(f *testing.F) {
	f.Add([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x08eXIfMM\x00\x2a\x00\x00\x00\x08\x00\x00\x00\x00"))
	f.Add([]byte("RIFF\x20\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x0c\x00\x00\x00\x00\x00\x00\x00\x00\x00EXIF\x04\x00\x00\x00MM\x00\x2a"))
	f.Add(manyPieces(20))
	f.Fuzz(func(t *testing.T, b []byte) {
		r := bytes.NewReader(b)
		var ps []piece
		var err error
		switch {
		case bytes.HasPrefix(b, pngSignature):
			ps, err = planPNG(r, int64(len(b)))
		case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
			ps, err = planWebP(r, int64(len(b)))
		default:
			return
		}
		if err != nil {
			return
		}
		sr := newSpliceReader(r, ps)
		out, err := io.ReadAll(sr)
		if err != nil || int64(len(out)) != sr.size {
			t.Fatalf("read %d of %d: %v", len(out), sr.size, err)
		}
		sr.Seek(0, io.SeekStart)
		one, err := io.ReadAll(iotest.OneByteReader(sr))
		if err != nil || !bytes.Equal(one, out) {
			t.Fatalf("one byte at a time differs: %v", err)
		}
	})
}
