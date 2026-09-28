package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// avifOpts shapes one synthetic AVIF.
type avifOpts struct {
	brand      string // major brand; "" = avif
	ilocV      byte   // 0, 1 or 2
	infeV      byte   // 2 or 3 (1 = the old layout, refused)
	exifMethod uint16 // construction_method of the Exif item
	offSize    byte   // iloc offset_size; 0 here = 4
	split      bool   // the Exif item in two extents, apart, the cut inside the GPS IFD
	noExif     bool
	noXMP      bool
	mdatZero   bool // the mdat box with size 0 ("to the end")
}

func tbe16(v int) []byte { b := make([]byte, 2); binary.BigEndian.PutUint16(b, uint16(v)); return b }
func tbe32(v int) []byte { b := make([]byte, 4); binary.BigEndian.PutUint32(b, uint32(v)); return b }

func tBox(typ string, parts ...[]byte) []byte {
	body := bytes.Join(parts, nil)
	return append(append(tbe32(8+len(body)), typ...), body...)
}

func tFullBox(typ string, version byte, parts ...[]byte) []byte {
	return tBox(typ, append([][]byte{{version, 0, 0, 0}}, parts...)...)
}

// avifTIFF is an EXIF TIFF block: IFD0 with Orientation 6 and a GPS pointer,
// a GPS IFD at 38 (30 bytes) with one rational triple at 68 (24 bytes).
func avifTIFF() []byte {
	le := binary.LittleEndian
	t := make([]byte, 92)
	copy(t, "II")
	le.PutUint16(t[2:], 42)
	le.PutUint32(t[4:], 8)
	entry := func(at int, tag, typ uint16, count, value uint32) {
		le.PutUint16(t[at:], tag)
		le.PutUint16(t[at+2:], typ)
		le.PutUint32(t[at+4:], count)
		le.PutUint32(t[at+8:], value)
	}
	le.PutUint16(t[8:], 2)
	entry(10, 0x0112, 3, 1, 6)
	entry(22, 0x8825, 4, 1, 38)
	le.PutUint16(t[38:], 2)
	entry(40, 0x0001, 2, 2, 'N')
	entry(52, 0x0002, 5, 3, 68)
	for i, v := range []uint32{41, 1, 9, 1, 2844, 100} {
		le.PutUint32(t[68+4*i:], v)
	}
	return t
}

// buildAVIF answers the file and the byte ranges that must come out as zeros.
func buildAVIF(o avifOpts) (file []byte, zero []span) {
	if o.brand == "" {
		o.brand = "avif"
	}
	if o.infeV == 0 {
		o.infeV = 2
	}
	if o.offSize == 0 {
		o.offSize = 4
	}
	image := []byte("AV1-PICTURE-BYTES-AV1-PICTURE-BYTES")
	exif := append(tbe32(0), avifTIFF()...) // exif_tiff_header_offset = 0
	xmp := []byte(`<x:xmpmeta><exif:GPSLatitude>41,9.47N</exif:GPSLatitude></x:xmpmeta>`)
	gap := []byte("--GAP--")
	cut := 4 + 50 // inside the GPS IFD (4+38 .. 4+68)

	// The mdat payload, and where each item lies in it.
	type ext struct{ at, n int }
	var mdat []byte
	put := func(b []byte) ext { e := ext{len(mdat), len(b)}; mdat = append(mdat, b...); return e }
	imgExt := put(image)
	var exifExt []ext
	if !o.noExif {
		if o.split {
			exifExt = append(exifExt, put(exif[:cut]))
			put(gap)
			exifExt = append(exifExt, put(exif[cut:]))
		} else {
			exifExt = append(exifExt, put(exif))
		}
	}
	var xmpExt ext
	if !o.noXMP {
		xmpExt = put(xmp)
	}

	infe := func(id int, typ string, extra []byte) []byte {
		idb := tbe16(id)
		if o.infeV == 3 {
			idb = tbe32(id)
		}
		if o.infeV < 2 {
			return tFullBox("infe", o.infeV, idb, tbe16(0), []byte("name\x00"), extra)
		}
		return tFullBox("infe", o.infeV, idb, tbe16(0), []byte(typ), []byte("\x00"), extra)
	}
	idw := tbe16
	if o.ilocV == 2 {
		idw = tbe32
	}
	offb := func(v int) []byte {
		switch o.offSize {
		case 8:
			return append(tbe32(0), tbe32(v)...)
		case 3:
			return tbe32(v)[1:]
		}
		return tbe32(v)
	}

	build := func(base int) []byte {
		entries := [][]byte{infe(1, "av01", nil)}
		items := 1
		if !o.noExif {
			entries = append(entries, infe(2, "Exif", nil))
			items++
		}
		if !o.noXMP {
			entries = append(entries, infe(3, "mime", []byte("application/rdf+xml\x00")))
			items++
		}
		iinf := tFullBox("iinf", 0, append([][]byte{tbe16(len(entries))}, entries...)...)

		item := func(id int, method uint16, exts []ext) []byte {
			b := idw(id)
			if o.ilocV >= 1 {
				b = append(b, tbe16(int(method))...)
			}
			b = append(b, tbe16(0)...) // data_reference_index
			b = append(b, tbe16(len(exts))...)
			for _, e := range exts {
				b = append(b, offb(base+e.at)...)
				b = append(b, tbe32(e.n)...)
			}
			return b
		}
		locs := [][]byte{{o.offSize<<4 | 4, 0}, idw(items), item(1, 0, []ext{imgExt})}
		if !o.noExif {
			locs = append(locs, item(2, o.exifMethod, exifExt))
		}
		if !o.noXMP {
			locs = append(locs, item(3, 0, []ext{xmpExt}))
		}
		iloc := tFullBox("iloc", o.ilocV, locs...)
		hdlr := tFullBox("hdlr", 0, tbe32(0), []byte("pict"), make([]byte, 12), []byte{0})
		pitm := tFullBox("pitm", 0, tbe16(1))
		meta := tFullBox("meta", 0, hdlr, pitm, iinf, iloc)
		compat := "mif1miaf"
		if o.brand == "mp42" {
			compat = "isomiso2"
		}
		ftyp := tBox("ftyp", []byte(o.brand), tbe32(0), []byte(compat))
		mdatBox := tBox("mdat", mdat)
		if o.mdatZero {
			copy(mdatBox, tbe32(0))
		}
		return append(append(ftyp, meta...), mdatBox...)
	}
	first := build(0)
	base := len(first) - len(mdat) // meta's size does not depend on the offsets
	file = build(base)

	if !o.noExif {
		// Joined item offsets of the GPS IFD and its value: 4+38 .. 4+92.
		lo, hi := 4+38, 4+92
		pos := 0
		for _, e := range exifExt {
			a, b := max(lo, pos), min(hi, pos+e.n)
			if a < b {
				zero = append(zero, span{int64(base + e.at + a - pos), int64(b - a)})
			}
			pos += e.n
		}
	}
	if !o.noXMP {
		zero = append(zero, span{int64(base + xmpExt.at), int64(xmpExt.n)})
	}
	return file, zero
}

// cleanAVIFFile writes data as <name> and runs cleanImage over it.
func cleanAVIFFile(t *testing.T, name string, data []byte) ([]byte, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	info, _ := f.Stat()
	r, err := cleanImage(path, f, info, ContentType(name))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(r)
}

func TestAVIFStripBlanksGPS(t *testing.T) {
	for name, o := range map[string]avifOpts{
		"iloc v0":           {ilocV: 0},
		"iloc v1":           {ilocV: 1},
		"iloc v2, infe v3":  {ilocV: 2, infeV: 3},
		"split exif":        {ilocV: 1, split: true},
		"offset_size 8":     {ilocV: 1, offSize: 8},
		"mdat size 0":       {ilocV: 0, mdatZero: true},
		"heic brand":        {brand: "heic"},
		"exif only, no xmp": {noXMP: true},
		"xmp only, no exif": {noExif: true},
	} {
		t.Run(name, func(t *testing.T) {
			orig, zero := buildAVIF(o)
			want := bytes.Clone(orig)
			for _, s := range zero {
				clear(want[s.off : s.off+s.n])
			}
			got, err := cleanAVIFFile(t, "p.avif", orig)
			if err != nil {
				t.Fatalf("cleanImage: %v", err)
			}
			if len(got) != len(orig) {
				t.Fatalf("length %d, want %d", len(got), len(orig))
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("bytes differ from the expected blanking")
			}
			if bytes.Contains(got, []byte("GPSLatitude")) {
				t.Error("XMP GPS still there")
			}
			if !o.noExif {
				// Orientation 6: tag 0x0112, SHORT, count 1, value 6 - still in IFD0.
				if !bytes.Contains(got, []byte{0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0}) {
					t.Error("Orientation lost")
				}
				if bytes.Contains(got, []byte{0x1c, 0x0b, 0, 0, 100, 0, 0, 0}) { // 2844/100
					t.Error("GPS latitude value still there")
				}
			}
		})
	}
}

func TestAVIFNoMetadataUnchanged(t *testing.T) {
	orig, zero := buildAVIF(avifOpts{noExif: true, noXMP: true})
	if len(zero) != 0 {
		t.Fatal("test setup")
	}
	got, err := cleanAVIFFile(t, "p.avif", orig)
	if err != nil || !bytes.Equal(got, orig) {
		t.Fatalf("an AVIF without metadata must pass unchanged (err %v)", err)
	}
}

func TestAVIFStripRefuses(t *testing.T) {
	for name, o := range map[string]avifOpts{
		"exif in idat (construction_method 1)": {ilocV: 1, exifMethod: 1},
		"infe version 1":                       {infeV: 1},
		"iloc offset_size 3":                   {ilocV: 1, offSize: 3},
		"not a HEIF brand":                     {brand: "mp42"},
	} {
		t.Run(name, func(t *testing.T) {
			orig, _ := buildAVIF(o)
			if _, err := cleanAVIFFile(t, "p.avif", orig); err == nil {
				t.Fatal("served; want refused")
			}
		})
	}
	// Named .avif, but not an image this knows.
	if _, err := cleanAVIFFile(t, "p.avif", []byte("GIF89a not really")); err == nil {
		t.Error(".avif with other content served")
	}
	// An MP4 named .gif is refused too (it goes by content).
	if _, err := cleanAVIFFile(t, "p.gif", tBox("ftyp", []byte("isom"), tbe32(0), []byte("mp42"))); err == nil {
		t.Error("MP4 renamed .gif served")
	}
}

// Every cut-short file and every flipped header byte: refused or planned,
// never a panic; one cut inside the mdat is always refused.
func TestAVIFStripMalformed(t *testing.T) {
	for _, o := range []avifOpts{{ilocV: 1, split: true}, {ilocV: 2, infeV: 3}} {
		good, _ := buildAVIF(o)
		mdatAt := bytes.Index(good, []byte("mdat")) - 4
		for n := 0; n < len(good); n++ {
			_, err := planAVIF(bytes.NewReader(good[:n]), int64(n))
			if n > mdatAt && err == nil {
				t.Errorf("cut at %d of %d: planned, want refused", n, len(good))
			}
		}
		for i := 0; i < mdatAt+8; i++ {
			for _, x := range []byte{0xFF, 0x80, 0x01} {
				bad := bytes.Clone(good)
				bad[i] ^= x
				planAVIF(bytes.NewReader(bad), int64(len(bad))) // must not panic
			}
		}
	}
	for _, junk := range [][]byte{
		nil,
		[]byte("\x00\x00\x00\x01ftyp"), // largesize cut short
		[]byte("\x00\x00\x00\x01ftyp\xff\xff\xff\xff\xff\xff\xff\xff"),                                         // largesize huge
		[]byte("\x00\x00\x00\x04ftyp"),                                                                         // size < header
		append(tBox("ftyp", []byte("avif"), tbe32(0)), tFullBox("meta", 0, []byte("\x00\x00\x00\x09iloc"))...), // child past parent
	} {
		if _, err := planAVIF(bytes.NewReader(junk), int64(len(junk))); err == nil {
			t.Errorf("junk %q planned, want refused", junk)
		}
	}
}

// A real .avif, when there is one on this machine: AVIF_REAL=/path/file.avif
// (AVIF_OUT=/path/out.avif keeps what would be sent, to look at by hand).
func TestAVIFStripRealFile(t *testing.T) {
	path := os.Getenv("AVIF_REAL")
	if path == "" {
		t.Skip("AVIF_REAL not set")
	}
	orig, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := cleanAVIFFile(t, "real.avif", orig)
	if err != nil {
		t.Fatalf("cleanImage: %v", err)
	}
	diff := 0
	for i := range orig {
		if orig[i] != got[i] {
			diff++
		}
	}
	t.Logf("%d bytes, %d blanked", len(orig), diff)
	if out := os.Getenv("AVIF_OUT"); out != "" {
		os.WriteFile(out, got, 0o600)
	}
}
