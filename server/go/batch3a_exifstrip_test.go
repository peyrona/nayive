package main

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// pngChunk is one PNG chunk: length, type, data, CRC.
func pngChunk(typ string, data []byte) []byte {
	out := binary.BigEndian.AppendUint32(nil, uint32(len(data)))
	out = append(out, typ...)
	out = append(out, data...)
	return binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(append([]byte(typ), data...)))
}

// gpsPNG is a real 4x4 PNG carrying its position in every text chunk a writer
// may use - eXIf, tEXt, iTXt (XMP), zTXt - and a tail after IEND.
func gpsPNG(t *testing.T, exif []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewGray(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	ihdrEnd := 8 + 12 + 13 // signature, then IHDR (13 bytes of data)
	var out []byte
	out = append(out, raw[:ihdrEnd]...)
	out = append(out, pngChunk("eXIf", exif)...)
	out = append(out, pngChunk("tEXt", []byte("Comment\x00GPS-TEXT"))...)
	out = append(out, pngChunk("iTXt", []byte("XML:com.adobe.xmp\x00\x00\x00\x00\x00<x>GPS-XMP</x>"))...)
	out = append(out, pngChunk("zTXt", []byte("Raw\x00\x00GPS-Z"))...)
	out = append(out, raw[ihdrEnd:]...)
	return append(out, "GPS-TAIL"...)
}

// riffChunk is one WebP chunk: FourCC, little-endian size, data, pad to even.
func riffChunk(fourcc string, data []byte) []byte {
	out := append([]byte(fourcc), binary.LittleEndian.AppendUint32(nil, uint32(len(data)))...)
	out = append(out, data...)
	if len(data)%2 == 1 {
		out = append(out, 0)
	}
	return out
}

// gpsWebP is an extended WebP whose VP8X says "EXIF and XMP follow", with both
// chunks, and a tail after the RIFF.
func gpsWebP(exif []byte) []byte {
	vp8x := make([]byte, 10)
	vp8x[0] = 0x20 | 0x10 | 0x08 | 0x04 // ICC, alpha, EXIF, XMP
	body := []byte("WEBP")
	body = append(body, riffChunk("VP8X", vp8x)...)
	body = append(body, riffChunk("VP8 ", []byte("IMAGE"))...) // odd: padded
	body = append(body, riffChunk("EXIF", exif)...)
	body = append(body, riffChunk("XMP ", []byte("<x>GPS-XMP</x>"))...)
	out := append([]byte("RIFF"), binary.LittleEndian.AppendUint32(nil, uint32(len(body)))...)
	return append(append(out, body...), "GPS-TAIL"...)
}

// webpChunks lists a WebP's chunks, checking the RIFF size on the way.
func webpChunks(t *testing.T, b []byte) map[string][]byte {
	t.Helper()
	if len(b) < 12 || string(b[:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		t.Fatalf("not a WebP: %q", b)
	}
	if n := int(binary.LittleEndian.Uint32(b[4:8])); n+8 != len(b) {
		t.Fatalf("RIFF size %d, file %d bytes", n, len(b))
	}
	out := map[string][]byte{}
	for pos := 12; pos < len(b); {
		n := int(binary.LittleEndian.Uint32(b[pos+4 : pos+8]))
		out[string(b[pos:pos+4])] = b[pos+8 : pos+8+n]
		pos += 8 + n + n%2
	}
	return out
}

// spliced is data through cleanImage, read whole, then again from every
// offset after a Seek - both must agree.
func spliced(t *testing.T, data []byte) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), "x")
	os.WriteFile(path, data, 0o644)
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	info, _ := f.Stat()
	r, err := cleanImage(path, f, info, "")
	if err != nil {
		t.Fatalf("cleanImage: %v", err)
	}
	whole, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	for off := range whole {
		r.Seek(int64(off), io.SeekStart)
		one := make([]byte, 3)
		n, _ := io.ReadFull(r, one)
		if !bytes.Equal(one[:n], whole[off:min(off+3, len(whole))]) {
			t.Fatalf("at %d read %x, want %x", off, one[:n], whole[off:min(off+3, len(whole))])
		}
	}
	return whole
}

// TestSpliceCutShortAndSeek: a file cut in the middle of a metadata chunk sends
// none of it; reading after a Seek matches reading straight through.
func TestSpliceCutShortAndSeek(t *testing.T) {
	p := gpsPNG(t, junkExif)
	cut := bytes.Index(p, []byte("GPS-TEXT")) + 2
	if got := spliced(t, p[:cut]); bytes.Contains(got, []byte("GPS")) || !bytes.HasPrefix(got, pngSignature) {
		t.Errorf("a PNG cut short sent %q", got)
	}
	w := gpsWebP(junkExif)
	cut = bytes.Index(w, []byte("GPS-EXIF")) + 2
	if got := spliced(t, w[:cut]); bytes.Contains(got, []byte("GPS")) {
		t.Errorf("a WebP cut short sent %q", got)
	} else {
		webpChunks(t, got)
	}
	webpChunks(t, spliced(t, gpsWebP(junkExif)))
	if got := spliced(t, []byte("png")); string(got) != "png" {
		t.Errorf("a file that is no picture = %q, want it as it is", got)
	}
}

// TestPublicPhotosLoseTheirPosition: a public link hands out PNG and WebP (and
// a JPEG under another name) with no position in them, still well formed.
func TestPublicPhotosLoseTheirPosition(t *testing.T) {
	srv, base, _, link := makeLink(t)
	dir := filepath.Join(srv.cfg.HomesDir, "ana", "files", "fotos", "porto")
	jpg, _ := gpsJPEG(t)
	os.WriteFile(filepath.Join(dir, "g.png"), gpsPNG(t, junkExif), 0o644)
	os.WriteFile(filepath.Join(dir, "g.webp"), gpsWebP(junkExif), 0o644)
	os.WriteFile(filepath.Join(dir, "disfraz.png"), jpg, 0o644) // a JPEG by another name
	url := base + "/api/public/" + link.Token + "/photo/"

	get := func(name string) []byte {
		t.Helper()
		resp := do(t, anonymous(), "GET", url+name, nil, nil)
		body := readBody(t, resp)
		if resp.StatusCode != 200 {
			t.Fatalf("%s: %d", name, resp.StatusCode)
		}
		if cl := resp.Header.Get("Content-Length"); cl != strconv.Itoa(len(body)) {
			t.Errorf("%s: Content-Length %s, body %d", name, cl, len(body))
		}
		if bytes.Contains(body, []byte("GPS-")) {
			t.Errorf("%s still carries its position: %q", name, body)
		}
		return body
	}

	p := get("g.png")
	if _, err := png.Decode(bytes.NewReader(p)); err != nil {
		t.Errorf("g.png does not decode: %v", err)
	}
	resp := do(t, anonymous(), "GET", url+"g.png", nil, map[string]string{"Range": "bytes=8-15"})
	if part := readBody(t, resp); resp.StatusCode != 206 || !bytes.Equal(part, p[8:16]) {
		t.Errorf("g.png Range: %d %x", resp.StatusCode, part)
	}

	w := webpChunks(t, get("g.webp"))
	if len(w) != 2 || w["VP8 "] == nil || w["VP8X"] == nil {
		t.Errorf("g.webp chunks = %v, want VP8X and VP8 only", w)
	} else if w["VP8X"][0] != 0x20|0x10 {
		t.Errorf("g.webp VP8X flags = %#x, want EXIF and XMP cleared", w["VP8X"][0])
	}

	if n := binary16(exifTIFF(t, get("disfraz.png"))[testGPSIFD:]); n != 0 {
		t.Errorf("a JPEG named .png still carries %d GPS entries", n)
	}
}

// junkExif is an EXIF chunk that is no TIFF: it cannot be walked, so it goes.
var junkExif = []byte("MM\x00\x2aGPS-EXIF")

// TestExifChunkKeepsOrientation: a PNG's or WebP's EXIF that CAN be walked
// stays - it holds the Orientation - with only its GPS IFD as zeros.
func TestExifChunkKeepsOrientation(t *testing.T) {
	jpg, _ := gpsJPEG(t)
	tiff := exifTIFF(t, jpg)
	check := func(name string, got []byte) {
		t.Helper()
		if len(got) != len(tiff) || !bytes.Equal(got[:testGPSIFD], tiff[:testGPSIFD]) {
			t.Fatalf("%s: IFD0 (the Orientation) changed or went: %x", name, got)
		}
		if n := binary16(got[testGPSIFD:]); n != 0 {
			t.Errorf("%s: %d GPS entries left", name, n)
		}
		if !bytes.Equal(got[testGPSData:testGPSData+24], make([]byte, 24)) {
			t.Errorf("%s: the latitude is still there", name)
		}
	}

	p := spliced(t, gpsPNG(t, tiff))
	if _, err := png.Decode(bytes.NewReader(p)); err != nil {
		t.Fatalf("the PNG does not decode (its eXIf CRC?): %v", err)
	}
	at := bytes.Index(p, []byte("eXIf"))
	if at < 0 {
		t.Fatal("the PNG lost its eXIf")
	}
	check("png", p[at+4:at+4+int(binary.BigEndian.Uint32(p[at-4:at]))])

	w := webpChunks(t, spliced(t, gpsWebP(append([]byte("Exif\x00\x00"), tiff...))))
	if w["VP8X"][0] != 0x20|0x10|0x08 {
		t.Errorf("VP8X flags = %#x, want only XMP cleared", w["VP8X"][0])
	}
	if exif := w["EXIF"]; len(exif) < 6 {
		t.Fatal("the WebP lost its EXIF")
	} else {
		check("webp", exif[6:])
	}
}
