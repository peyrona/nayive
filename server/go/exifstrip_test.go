package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// The layout of the EXIF block gpsJPEG writes, as offsets inside its TIFF data.
const (
	testGPSIFD   = 38 // IFD0 (8..38) points here
	testGPSData  = 68 // the three GPSLatitude rationals
	testTIFFSize = 92
)

// plainJPEG is a real, decodable 4x4 JPEG with no metadata at all.
func plainJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for i := range img.Pix {
		img.Pix[i] = 0x80
	}
	img.Set(1, 1, color.RGBA{255, 0, 0, 255})
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return buf.Bytes()
}

// gpsJPEG is what a phone hands over: Orientation 6 and a GPS IFD in EXIF, the
// position again in XMP, and a "motion photo" stuck on after the image.
func gpsJPEG(t *testing.T) (withTrailer []byte, trailer []byte) {
	t.Helper()
	le := binary.LittleEndian
	tiff := make([]byte, testTIFFSize)
	copy(tiff, "II")
	le.PutUint16(tiff[2:], 42)
	le.PutUint32(tiff[4:], 8)

	entry := func(at int, tag, typ uint16, count uint32, value []byte) {
		le.PutUint16(tiff[at:], tag)
		le.PutUint16(tiff[at+2:], typ)
		le.PutUint32(tiff[at+4:], count)
		copy(tiff[at+8:at+12], value)
	}
	u32 := func(v uint32) []byte { b := make([]byte, 4); le.PutUint32(b, v); return b }

	// IFD0: Orientation = 6, GPS IFD pointer.
	le.PutUint16(tiff[8:], 2)
	entry(10, 0x0112, 3, 1, []byte{6, 0, 0, 0})
	entry(22, 0x8825, 4, 1, u32(testGPSIFD))
	// GPS IFD: GPSLatitudeRef "N" (inline), GPSLatitude 3 rationals (out of line).
	le.PutUint16(tiff[testGPSIFD:], 2)
	entry(testGPSIFD+2, 0x0001, 2, 2, []byte{'N', 0, 0, 0})
	entry(testGPSIFD+14, 0x0002, 5, 3, u32(testGPSData))
	for i, v := range []uint32{41, 1, 9, 1, 2844, 100} {
		le.PutUint32(tiff[testGPSData+4*i:], v)
	}

	segment := func(marker byte, payload []byte) []byte {
		out := []byte{0xFF, marker, 0, 0}
		binary.BigEndian.PutUint16(out[2:], uint16(len(payload)+2))
		return append(out, payload...)
	}
	exif := segment(0xE1, append([]byte("Exif\x00\x00"), tiff...))
	xmp := segment(0xE1, []byte("http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta><exif:GPSLatitude>41,9.47N</exif:GPSLatitude></x:xmpmeta>"))

	plain := plainJPEG(t)
	trailer = []byte("MOTIONPHOTO-mp4-with-its-own-GPS")
	out := append([]byte{0xFF, 0xD8}, exif...)
	out = append(out, xmp...)
	out = append(out, plain[2:]...)
	return append(out, trailer...), trailer
}

// cleaned runs cleanJPEG over `data` as a file on disk.
func cleaned(t *testing.T, data []byte) ([]byte, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "foto.jpg")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	info, _ := f.Stat()
	reader, err := cleanJPEG(path, f, info)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(reader)
}

// exifTIFF is the TIFF data of the first EXIF block in a JPEG.
func exifTIFF(t *testing.T, data []byte) []byte {
	t.Helper()
	at := bytes.Index(data, []byte("Exif\x00\x00"))
	if at < 0 || at+6+testTIFFSize > len(data) {
		t.Fatalf("no EXIF block left")
	}
	return data[at+6 : at+6+testTIFFSize]
}

func TestCleanJPEGRemovesThePosition(t *testing.T) {
	orig, trailer := gpsJPEG(t)
	out, err := cleaned(t, orig)
	if err != nil {
		t.Fatalf("cleanJPEG: %v", err)
	}

	if _, err := jpeg.Decode(bytes.NewReader(out)); err != nil {
		t.Errorf("the cleaned photo no longer decodes: %v", err)
	}
	if len(out) != len(orig)-len(trailer) {
		t.Errorf("length %d, want %d (everything but what came after the image)", len(out), len(orig)-len(trailer))
	}
	if bytes.Contains(out, []byte("MOTIONPHOTO")) {
		t.Error("the data stuck on after the image was sent")
	}
	if bytes.Contains(out, []byte("GPSLatitude")) {
		t.Error("the XMP copy of the position was sent")
	}

	tiff := exifTIFF(t, out)
	le := binary.LittleEndian
	if le.Uint16(tiff[10:]) != 0x0112 || tiff[18] != 6 {
		t.Error("Orientation was lost - portrait photos would show sideways")
	}
	if le.Uint16(tiff[22:]) != 0x8825 {
		t.Error("IFD0 itself was changed; only the GPS IFD should be")
	}
	if n := le.Uint16(tiff[testGPSIFD:]); n != 0 {
		t.Errorf("GPS IFD still has %d entries", n)
	}
	for i := testGPSIFD; i < testTIFFSize; i++ {
		if tiff[i] != 0 {
			t.Fatalf("GPS byte at %d is still %#x", i, tiff[i])
		}
	}
	if !bytes.Equal(out[:4], orig[:4]) {
		t.Error("the start of the file changed")
	}
}

func TestCleanJPEGWithoutMetadataIsUntouched(t *testing.T) {
	orig := plainJPEG(t)
	out, err := cleaned(t, orig)
	if err != nil {
		t.Fatalf("cleanJPEG: %v", err)
	}
	if !bytes.Equal(out, orig) {
		t.Error("a JPEG with nothing to remove came out different")
	}
}

// TestCleanJPEGSeeks - http.ServeContent answers Range requests by seeking, so
// any slice must match the same bytes of the whole cleaned file.
func TestCleanJPEGSeeks(t *testing.T) {
	orig, _ := gpsJPEG(t)
	whole, err := cleaned(t, orig)
	if err != nil {
		t.Fatalf("cleanJPEG: %v", err)
	}

	path := filepath.Join(t.TempDir(), "foto.jpg")
	os.WriteFile(path, orig, 0o644)
	f, _ := os.Open(path)
	defer f.Close()
	info, _ := f.Stat()
	reader, err := cleanJPEG(path, f, info)
	if err != nil {
		t.Fatalf("cleanJPEG: %v", err)
	}

	if end, _ := reader.Seek(0, io.SeekEnd); end != int64(len(whole)) {
		t.Fatalf("size by seeking %d, want %d", end, len(whole))
	}
	from := int64(testGPSIFD) // a slice across a blanked run
	reader.Seek(from, io.SeekStart)
	part := make([]byte, 60)
	if _, err := io.ReadFull(reader, part); err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(part, whole[from:from+60]) {
		t.Error("a seek-then-read slice differs from the whole cleaned file")
	}
}

func TestCleanJPEGRefusesWhatItCannotWalk(t *testing.T) {
	orig, _ := gpsJPEG(t)
	broken := append([]byte{}, orig...)
	binary.BigEndian.PutUint16(broken[4:], 0xFFFF) // APP1 claims more than the file holds

	for name, data := range map[string][]byte{
		"not a jpeg":        []byte("this is a text file, not a picture"),
		"segment too long":  broken,
		"only the SOI mark": {0xFF, 0xD8},
	} {
		if _, err := cleaned(t, data); err == nil {
			t.Errorf("%s: served instead of refused", name)
		}
	}
}
