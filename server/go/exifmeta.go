package main

// =============================================================================
// Reading where and when a JPEG was taken, for photo_position.go.
// =============================================================================
//
// The companion of exifstrip.go, built on the same walkers (jpegSegments,
// walkIFD). Only the first EXIF block is read, which sits in the first few KB
// of the file:
//
//	IFD0 0x8825 -> GPS IFD:  0x0001-0x0004 latitude / longitude with their
//	                         N-S / E-W refs, 0x0007 GPSTimeStamp (UTC),
//	                         0x001D GPSDateStamp, 0x001F GPSHPositioningError
//	IFD0 0x8769 -> Exif IFD: 0x9003 DateTimeOriginal, 0x9011 OffsetTimeOriginal

import (
	"bytes"
	"encoding/binary"
	"io"
	"math"
	"strings"
	"time"
)

// jpegMeta is what a photo says about where and when it was taken.
type jpegMeta struct {
	HasGPS  bool
	Lat     float64
	Lon     float64
	Acc     float64   // GPSHPositioningError, metres; 0 = not written
	GPSTime time.Time // the GPS fix time (UTC); zero = not written
	Taken   string    // DateTimeOriginal, "2006:01:02 15:04:05"; "" = not written
	Offset  string    // OffsetTimeOriginal, "+01:00"; "" = not written
}

// readJPEGMeta reads the first EXIF block of the JPEG in r. A JPEG without one
// is an empty jpegMeta, not an error.
func readJPEGMeta(r io.ReaderAt, size int64) (jpegMeta, error) {
	var meta jpegMeta
	_, _, err := jpegSegments(r, size, func(marker byte, body, n int64) error {
		if marker != 0xE1 || n < 14 {
			return nil
		}
		payload := make([]byte, n)
		if _, err := r.ReadAt(payload, body); err != nil {
			return errBadJPEG
		}
		if !bytes.HasPrefix(payload, []byte("Exif\x00\x00")) {
			return nil
		}
		meta = exifMeta(payload[6:])
		return errStopWalk
	})
	return meta, err
}

// exifMeta reads the TIFF data of one EXIF block. Whatever is missing or odd is
// simply left out.
func exifMeta(t []byte) jpegMeta {
	var m jpegMeta
	bo := tiffOrder(t)
	if bo == nil {
		return m
	}

	gpsAt, exifAt := int64(-1), int64(-1)
	walkIFD(t, bo, int64(bo.Uint32(t[4:8])), func(tag, typ uint16, count uint32, e int64) error {
		switch tag {
		case 0x8825:
			gpsAt = int64(bo.Uint32(t[e+8 : e+12]))
		case 0x8769:
			exifAt = int64(bo.Uint32(t[e+8 : e+12]))
		}
		return nil
	})

	if exifAt > 0 {
		walkIFD(t, bo, exifAt, func(tag, typ uint16, count uint32, e int64) error {
			switch tag {
			case 0x9003:
				m.Taken = tiffASCII(tiffValue(t, bo, e, typ, count))
			case 0x9011:
				m.Offset = tiffASCII(tiffValue(t, bo, e, typ, count))
			}
			return nil
		})
	}

	if gpsAt > 0 {
		var latRef, lonRef, date string
		var lat, lon, clock []float64
		walkIFD(t, bo, gpsAt, func(tag, typ uint16, count uint32, e int64) error {
			v := tiffValue(t, bo, e, typ, count)
			switch tag {
			case 0x0001:
				latRef = tiffASCII(v)
			case 0x0002:
				lat = tiffNumbers(bo, typ, v)
			case 0x0003:
				lonRef = tiffASCII(v)
			case 0x0004:
				lon = tiffNumbers(bo, typ, v)
			case 0x0007:
				clock = tiffNumbers(bo, typ, v)
			case 0x001D:
				date = tiffASCII(v)
			case 0x001F:
				if acc := tiffNumbers(bo, typ, v); len(acc) == 1 && acc[0] > 0 {
					m.Acc = acc[0]
				}
			}
			return nil
		})

		if len(lat) == 3 && len(lon) == 3 {
			la := lat[0] + lat[1]/60 + lat[2]/3600
			lo := lon[0] + lon[1]/60 + lon[2]/3600
			if strings.EqualFold(latRef, "S") {
				la = -la
			}
			if strings.EqualFold(lonRef, "W") {
				lo = -lo
			}
			if validLatLon(la, lo) {
				m.HasGPS, m.Lat, m.Lon = true, la, lo
			}
		}
		if day, err := time.Parse("2006:01:02", date); err == nil && day.Year() >= 2000 && len(clock) == 3 {
			seconds := clock[0]*3600 + clock[1]*60 + clock[2]
			m.GPSTime = day.Add(time.Duration(seconds * float64(time.Second)))
		}
	}
	return m
}

// tiffValue is the bytes of one IFD entry's value - inline in the entry, or at
// the offset it holds - or nil when they do not fit in t.
func tiffValue(t []byte, bo binary.ByteOrder, e int64, typ uint16, count uint32) []byte {
	unit, known := tiffTypeSize[typ]
	if !known {
		return nil
	}
	total := unit * uint64(count)
	if total > 1<<16 {
		return nil
	}
	if total <= 4 {
		return t[e+8 : e+8+int64(total)]
	}
	at := uint64(bo.Uint32(t[e+8 : e+12]))
	if at+total > uint64(len(t)) {
		return nil
	}
	return t[at : at+total]
}

// tiffASCII is an ASCII value without its NUL and padding.
func tiffASCII(v []byte) string {
	if i := bytes.IndexByte(v, 0); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(string(v))
}

// tiffNumbers are the numbers in a numeric value: RATIONAL / SRATIONAL, as the
// EXIF standard asks for GPS, and also SHORT, LONG, FLOAT and DOUBLE, which some
// software writes instead (Python's Pillow writes DOUBLE). nil for any other
// type, or when a phone left a placeholder with a zero denominator.
func tiffNumbers(bo binary.ByteOrder, typ uint16, v []byte) []float64 {
	unit, known := tiffTypeSize[typ]
	if !known || len(v) == 0 || uint64(len(v))%unit != 0 {
		return nil
	}
	size := int(unit)
	out := make([]float64, 0, len(v)/size)
	for i := 0; i+size <= len(v); i += size {
		b := v[i : i+size]
		switch typ {
		case 3:
			out = append(out, float64(bo.Uint16(b)))
		case 4:
			out = append(out, float64(bo.Uint32(b)))
		case 5, 10:
			num, den := bo.Uint32(b[0:4]), bo.Uint32(b[4:8])
			if den == 0 {
				return nil
			}
			if typ == 10 {
				out = append(out, float64(int32(num))/float64(int32(den)))
			} else {
				out = append(out, float64(num)/float64(den))
			}
		case 11:
			out = append(out, float64(math.Float32frombits(bo.Uint32(b))))
		case 12:
			out = append(out, math.Float64frombits(bo.Uint64(b)))
		default:
			return nil
		}
	}
	return out
}
