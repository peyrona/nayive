package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"testing"
	"time"
)

// ifdEntry is one TIFF entry for exifJPEG: its raw value bytes, little-endian.
type ifdEntry struct {
	tag, typ uint16
	count    uint32
	val      []byte
}

func asciiEntry(tag uint16, s string) ifdEntry {
	v := append([]byte(s), 0)
	return ifdEntry{tag, 2, uint32(len(v)), v}
}

func rationals(vals ...[2]uint32) []byte {
	b := make([]byte, 8*len(vals))
	for i, v := range vals {
		binary.LittleEndian.PutUint32(b[8*i:], v[0])
		binary.LittleEndian.PutUint32(b[8*i+4:], v[1])
	}
	return b
}

// gpsEntries is a GPS IFD for this position, fix time and accuracy (0 = no tag).
func gpsEntries(lat, lon float64, fix time.Time, acc uint32) []ifdEntry {
	dms := func(v float64) []byte {
		v = math.Abs(v)
		d := math.Floor(v)
		m := math.Floor((v - d) * 60)
		s := ((v-d)*60 - m) * 60
		return rationals([2]uint32{uint32(d), 1}, [2]uint32{uint32(m), 1},
			[2]uint32{uint32(math.Round(s * 10000)), 10000})
	}
	ns, ew := "N", "E"
	if lat < 0 {
		ns = "S"
	}
	if lon < 0 {
		ew = "W"
	}
	fix = fix.UTC()
	out := []ifdEntry{
		asciiEntry(0x0001, ns), {0x0002, 5, 3, dms(lat)},
		asciiEntry(0x0003, ew), {0x0004, 5, 3, dms(lon)},
		{0x0007, 5, 3, rationals([2]uint32{uint32(fix.Hour()), 1}, [2]uint32{uint32(fix.Minute()), 1},
			[2]uint32{uint32(fix.Second()), 1})},
		asciiEntry(0x001D, fix.Format("2006:01:02")),
	}
	if acc > 0 {
		out = append(out, ifdEntry{0x001F, 5, 1, rationals([2]uint32{acc, 1})})
	}
	return out
}

// exifJPEG is a real, decodable JPEG whose EXIF block holds these Exif IFD and
// GPS IFD entries (either may be nil).
func exifJPEG(t *testing.T, exif, gps []ifdEntry) []byte {
	t.Helper()
	le := binary.LittleEndian
	u32 := func(v int) []byte { b := make([]byte, 4); le.PutUint32(b, uint32(v)); return b }
	ifdLen := func(n int) int { return 2 + 12*n + 4 }

	var ifd0 []ifdEntry
	if exif != nil {
		ifd0 = append(ifd0, ifdEntry{0x8769, 4, 1, nil})
	}
	if gps != nil {
		ifd0 = append(ifd0, ifdEntry{0x8825, 4, 1, nil})
	}
	exifAt := 8 + ifdLen(len(ifd0))
	gpsAt := exifAt
	if exif != nil {
		gpsAt += ifdLen(len(exif))
	}
	end := gpsAt
	if gps != nil {
		end += ifdLen(len(gps))
	}
	for i := range ifd0 {
		if ifd0[i].tag == 0x8769 {
			ifd0[i].val = u32(exifAt)
		} else {
			ifd0[i].val = u32(gpsAt)
		}
	}

	buf := make([]byte, end)
	copy(buf, "II")
	le.PutUint16(buf[2:], 42)
	le.PutUint32(buf[4:], 8)
	write := func(at int, entries []ifdEntry) {
		le.PutUint16(buf[at:], uint16(len(entries)))
		for i, e := range entries {
			p := at + 2 + 12*i
			le.PutUint16(buf[p:], e.tag)
			le.PutUint16(buf[p+2:], e.typ)
			le.PutUint32(buf[p+4:], e.count)
			if len(e.val) <= 4 {
				copy(buf[p+8:p+12], e.val)
			} else {
				le.PutUint32(buf[p+8:], uint32(len(buf)))
				buf = append(buf, e.val...)
			}
		}
	}
	write(8, ifd0)
	if exif != nil {
		write(exifAt, exif)
	}
	if gps != nil {
		write(gpsAt, gps)
	}

	payload := append([]byte("Exif\x00\x00"), buf...)
	segment := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(segment[2:], uint16(len(payload)+2))
	out := append([]byte{0xFF, 0xD8}, append(segment, payload...)...)
	return append(out, plainJPEG(t)[2:]...)
}

func TestReadJPEGMeta(t *testing.T) {
	fix := time.Date(2026, 9, 14, 13, 45, 30, 0, time.UTC)
	data := exifJPEG(t,
		[]ifdEntry{asciiEntry(0x9003, "2026:09:14 15:45:31"), asciiEntry(0x9011, "+02:00")},
		gpsEntries(41.157944, -8.629105, fix, 12))

	meta, err := readJPEGMeta(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("readJPEGMeta: %v", err)
	}
	if !meta.HasGPS || math.Abs(meta.Lat-41.157944) > 1e-5 || math.Abs(meta.Lon+8.629105) > 1e-5 {
		t.Errorf("position %+v", meta)
	}
	if meta.Acc != 12 || !meta.GPSTime.Equal(fix) {
		t.Errorf("accuracy %v, fix time %v", meta.Acc, meta.GPSTime)
	}
	if meta.Taken != "2026:09:14 15:45:31" || meta.Offset != "+02:00" {
		t.Errorf("taken %q offset %q", meta.Taken, meta.Offset)
	}

	// The copy a stranger gets has no position left - and still its date.
	out, err := cleaned(t, data)
	if err != nil {
		t.Fatalf("cleanJPEG: %v", err)
	}
	back, _ := readJPEGMeta(bytes.NewReader(out), int64(len(out)))
	if back.HasGPS || !back.GPSTime.IsZero() {
		t.Errorf("the cleaned photo still has a position: %+v", back)
	}
	if back.Taken == "" {
		t.Error("cleaning removed more than the position")
	}

	// No EXIF at all is simply nothing.
	plain := plainJPEG(t)
	if m, err := readJPEGMeta(bytes.NewReader(plain), int64(len(plain))); err != nil || m.HasGPS {
		t.Errorf("plain JPEG: %+v %v", m, err)
	}
}

// TestReadJPEGMetaDoubles - some software writes the GPS numbers as DOUBLE
// instead of RATIONAL (Python's Pillow does). They still place the photo.
func TestReadJPEGMetaDoubles(t *testing.T) {
	doubles := func(vals ...float64) []byte {
		b := make([]byte, 8*len(vals))
		for i, v := range vals {
			binary.LittleEndian.PutUint64(b[8*i:], math.Float64bits(v))
		}
		return b
	}
	data := exifJPEG(t, nil, []ifdEntry{
		asciiEntry(0x0001, "N"), {0x0002, 12, 3, doubles(40, 38, 24)},
		asciiEntry(0x0003, "W"), {0x0004, 12, 3, doubles(8, 39, 0)},
		{0x0007, 12, 3, doubles(13, 24, 50)}, asciiEntry(0x001D, "2026:09:15"),
	})
	meta, err := readJPEGMeta(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("readJPEGMeta: %v", err)
	}
	if !meta.HasGPS || math.Abs(meta.Lat-40.64) > 1e-9 || math.Abs(meta.Lon+8.65) > 1e-9 {
		t.Errorf("position %+v", meta)
	}
	if !meta.GPSTime.Equal(time.Date(2026, 9, 15, 13, 24, 50, 0, time.UTC)) {
		t.Errorf("fix time %v", meta.GPSTime)
	}

	// A phone's placeholder - empty refs, 0/0 numbers - is no position.
	blank := exifJPEG(t, nil, []ifdEntry{
		asciiEntry(0x0001, ""), {0x0002, 5, 3, rationals([2]uint32{0, 0}, [2]uint32{0, 0}, [2]uint32{0, 0})},
		asciiEntry(0x0003, ""), {0x0004, 5, 3, rationals([2]uint32{0, 0}, [2]uint32{0, 0}, [2]uint32{0, 0})},
	})
	if m, _ := readJPEGMeta(bytes.NewReader(blank), int64(len(blank))); m.HasGPS {
		t.Errorf("a placeholder GPS block gave a position: %+v", m)
	}
}

func TestPhotoTime(t *testing.T) {
	lisbon, _ := time.LoadLocation("Europe/Lisbon")
	madrid, _ := time.LoadLocation("Europe/Madrid")
	trip := publicTripFile{Stages: []publicTripStage{
		{StartDate: "2026-09-13", EndDate: "2026-09-15", Tz: "Europe/Lisbon"},
	}}
	fix := time.Date(2026, 9, 14, 13, 45, 30, 0, time.UTC)

	cases := []struct {
		name string
		meta jpegMeta
		want time.Time
	}{
		{"the GPS time first", jpegMeta{GPSTime: fix, Taken: "2026:09:14 10:00:00", Offset: "+02:00"}, fix},
		{"taken, with its offset", jpegMeta{Taken: "2026:09:14 15:45:30", Offset: "+02:00"}, fix},
		{"taken, on the stage's clock", jpegMeta{Taken: "2026:09:14 14:45:30"},
			time.Date(2026, 9, 14, 14, 45, 30, 0, lisbon)},
		{"taken, on the owner's clock", jpegMeta{Taken: "2026:09:20 14:45:30"},
			time.Date(2026, 9, 20, 14, 45, 30, 0, madrid)},
	}
	for _, tc := range cases {
		got, ok := photoTime(tc.meta, trip, madrid)
		if !ok || got != tc.want.Unix() {
			t.Errorf("%s: %v %v, want %v", tc.name, time.Unix(got, 0).UTC(), ok, tc.want.UTC())
		}
	}
	if _, ok := photoTime(jpegMeta{}, trip, madrid); ok {
		t.Error("a photo with no time got one")
	}
}
