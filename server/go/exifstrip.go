package main

// =============================================================================
// Taking the position out of a JPEG before a stranger gets it.
// =============================================================================
//
// A phone writes where each photo was taken into the file itself - EXIF tag
// 0x8825 points at a "GPS IFD" - to a few metres. A public trip link promises
// "about 100 m", so the full-size photo it hands out must not carry that.
//
// NOTHING IS RE-ENCODED. Decoding and encoding again would drop the Orientation
// tag (every portrait photo sideways), cost a CPU-second on a big photo, and
// change the picture. Instead the bytes that hold the position read as zeros,
// so the file keeps its layout and every other byte:
//
//   - the GPS IFD: entry count, entries and next-IFD offset, plus every value
//     those entries point at. IFD0 still points at it; a zero count is an
//     empty IFD, which every reader accepts;
//   - an XMP packet (APP1 "http://ns.adobe.com/..."), which can repeat the
//     position as text: the whole segment payload;
//   - everything AFTER the image's end marker is cut off. Phones append things
//     there - a Samsung "motion photo" is a whole MP4 with its own location.
//
// The file on disk is never touched: cleanReader lays the zeros over the bytes
// as they are read. A JPEG this cannot walk is refused, never sent as it is.
//
// Not handled: PNG / WebP / AVIF metadata. Phones write JPEG (or HEIC, which
// a browser cannot show and a link does not lend).
//
// exifmeta.go READS the same blocks, with the same walkers.

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"sync"
)

var errBadJPEG = errors.New("not a JPEG this can walk")

// errStopWalk, returned by a jpegSegments callback, ends the walk early. It is
// not an error.
var errStopWalk = errors.New("stop walking")

// span is a run of bytes to hand out as zeros.
type span struct{ off, n int64 }

// jpegPlan is what to change in one JPEG: the runs to blank, and where the
// image ends (nothing after `end` is sent).
type jpegPlan struct {
	blank []span
	end   int64
}

// jpegPlans caches the walk per file version: a visitor paging through an album
// asks for the same photos again, and walking means reading the whole file.
var jpegPlans = struct {
	sync.Mutex
	m map[string]jpegPlan
}{m: map[string]jpegPlan{}}

const jpegPlansMax = 4096

// cleanJPEG is `file` as a stranger may read it. `key` names the file (its
// absolute path) for the cache.
func cleanJPEG(key string, file *os.File, info os.FileInfo) (*cleanReader, error) {
	key += "|" + itoa64(info.Size()) + "|" + itoa64(info.ModTime().UnixNano())

	jpegPlans.Lock()
	plan, found := jpegPlans.m[key]
	jpegPlans.Unlock()

	if !found {
		var err error
		if plan, err = planJPEG(file, info.Size()); err != nil {
			return nil, err
		}
		jpegPlans.Lock()
		if len(jpegPlans.m) >= jpegPlansMax {
			clear(jpegPlans.m) // crude, and enough: it only saves a re-walk
		}
		jpegPlans.m[key] = plan
		jpegPlans.Unlock()
	}
	return &cleanReader{src: file, blank: plan.blank, size: plan.end}, nil
}

// jpegSegments walks the marker segments of the JPEG in r, from its start to
// its first scan, calling fn for every segment that has a length: its marker,
// where its payload starts, and how long that is. It answers the offset just
// past the last segment walked, and whether that segment was the start of scan
// (false when the image ended first, or fn stopped the walk with errStopWalk).
func jpegSegments(r io.ReaderAt, size int64, fn func(marker byte, body, n int64) error) (int64, bool, error) {
	head := make([]byte, 2)
	if size < 4 {
		return 0, false, errBadJPEG
	}
	if _, err := r.ReadAt(head, 0); err != nil || head[0] != 0xFF || head[1] != 0xD8 {
		return 0, false, errBadJPEG
	}

	pos := int64(2)
	for {
		// A marker: 0xFF, maybe more 0xFF fill bytes, then its code.
		if _, err := r.ReadAt(head[:1], pos); err != nil || head[0] != 0xFF {
			return pos, false, errBadJPEG
		}
		for {
			pos++
			if _, err := r.ReadAt(head[:1], pos); err != nil {
				return pos, false, errBadJPEG
			}
			if head[0] != 0xFF {
				break
			}
		}
		marker := head[0]
		pos++

		switch {
		case marker == 0xD9: // end of image, with no scan: odd, but complete
			return pos, false, nil
		case marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7):
			continue // no length field
		case marker == 0x00:
			return pos, false, errBadJPEG
		}

		if _, err := r.ReadAt(head, pos); err != nil {
			return pos, false, errBadJPEG
		}
		length := int64(binary.BigEndian.Uint16(head))
		body, n := pos+2, length-2
		if length < 2 || body+n > size {
			return pos, false, errBadJPEG
		}
		if err := fn(marker, body, n); err != nil {
			if errors.Is(err, errStopWalk) {
				return body + n, false, nil
			}
			return pos, false, err
		}

		pos = body + n
		if marker == 0xDA { // start of scan: the picture itself follows
			return pos, true, nil
		}
	}
}

// planJPEG works out what cleanReader has to blank and cut in the JPEG in r.
func planJPEG(r io.ReaderAt, size int64) (jpegPlan, error) {
	plan := jpegPlan{end: size}
	pos, scan, err := jpegSegments(r, size, func(marker byte, body, n int64) error {
		if marker != 0xE1 { // APP1: EXIF or XMP
			return nil
		}
		payload := make([]byte, n)
		if _, err := r.ReadAt(payload, body); err != nil {
			return errBadJPEG
		}
		switch {
		case bytes.HasPrefix(payload, []byte("Exif\x00\x00")):
			runs, err := gpsSpans(payload[6:], body+6)
			if err != nil {
				return err
			}
			plan.blank = append(plan.blank, runs...)
		case bytes.HasPrefix(payload, []byte("http://ns.adobe.com/")):
			plan.blank = append(plan.blank, span{body, n})
		}
		return nil
	})
	if err != nil {
		return plan, err
	}
	if !scan {
		plan.end = pos // the image ended before any scan
		return plan, nil
	}
	end, err := scanToEOI(r, pos, size)
	if err != nil {
		return plan, err
	}
	plan.end = end
	return plan, nil
}

// scanToEOI finds the end of the image: the offset just past its 0xFFD9. Inside
// the compressed data a 0xFF byte is always followed by 0x00 or a restart
// marker, so the first other marker is structure - another scan of a
// progressive JPEG (skipped by its length), or the end. A file that just stops
// is sent up to where it stops.
func scanToEOI(r io.ReaderAt, pos, size int64) (int64, error) {
	br := bufio.NewReaderSize(io.NewSectionReader(r, pos, size-pos), 64<<10)
	off := pos
	next := func() (byte, bool) {
		b, err := br.ReadByte()
		if err != nil {
			return 0, false
		}
		off++
		return b, true
	}

	for {
		b, ok := next()
		if !ok {
			return size, nil
		}
		if b != 0xFF {
			continue
		}
		m, ok := next()
		for ok && m == 0xFF {
			m, ok = next()
		}
		if !ok {
			return size, nil
		}
		switch {
		case m == 0x00 || (m >= 0xD0 && m <= 0xD7):
			// a stuffed 0xFF, or a restart marker: still image data
		case m == 0xD9:
			return off, nil
		default:
			hi, ok1 := next()
			lo, ok2 := next()
			if !ok1 || !ok2 {
				return size, nil
			}
			length := int(hi)<<8 | int(lo)
			if length < 2 {
				return 0, errBadJPEG
			}
			skipped, _ := br.Discard(length - 2)
			off += int64(skipped)
			if skipped < length-2 {
				return size, nil
			}
		}
	}
}

// tiffTypeSize is the byte size of one value of each TIFF field type.
var tiffTypeSize = map[uint16]uint64{
	1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4,
}

// tiffOrder is the byte order of TIFF data, or nil when it is not TIFF.
func tiffOrder(t []byte) binary.ByteOrder {
	if len(t) < 8 {
		return nil
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return nil
	}
	if bo.Uint16(t[2:4]) != 42 {
		return nil
	}
	return bo
}

// gpsSpans are the runs that hold the GPS IFD in one EXIF block. `t` is the
// TIFF data (after "Exif\0\0"), found at absolute offset `base`. No GPS IFD is
// no runs, not an error.
func gpsSpans(t []byte, base int64) ([]span, error) {
	bo := tiffOrder(t)
	if bo == nil {
		return nil, errBadJPEG
	}

	gps := int64(-1)
	_, err := walkIFD(t, bo, int64(bo.Uint32(t[4:8])), func(tag, typ uint16, count uint32, e int64) error {
		if tag == 0x8825 {
			gps = int64(bo.Uint32(t[e+8 : e+12]))
		}
		return nil
	})
	if err != nil || gps < 0 {
		return nil, err
	}

	var runs []span
	count, err := walkIFD(t, bo, gps, func(tag, typ uint16, n uint32, e int64) error {
		unit, known := tiffTypeSize[typ]
		if !known {
			return errBadJPEG // its value cannot be found, so it cannot be blanked
		}
		total := unit * uint64(n)
		if total > 4 { // stored elsewhere; the entry holds its offset
			at := uint64(bo.Uint32(t[e+8 : e+12]))
			if at+total > uint64(len(t)) {
				return errBadJPEG
			}
			runs = append(runs, span{base + int64(at), int64(total)})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// The IFD itself: count, entries, and the next-IFD offset when it is there.
	ifdLen := 2 + 12*int64(count) + 4
	if gps+ifdLen > int64(len(t)) {
		ifdLen = int64(len(t)) - gps
	}
	return append(runs, span{base + gps, ifdLen}), nil
}

// walkIFD calls fn for each 12-byte entry of the IFD at `off` (e = the entry's
// offset in t) and returns how many there are.
func walkIFD(t []byte, bo binary.ByteOrder, off int64,
	fn func(tag, typ uint16, count uint32, e int64) error) (int, error) {

	if off < 8 || off+2 > int64(len(t)) {
		return 0, errBadJPEG
	}
	n := int(bo.Uint16(t[off : off+2]))
	if off+2+12*int64(n) > int64(len(t)) {
		return 0, errBadJPEG
	}
	for i := 0; i < n; i++ {
		e := off + 2 + 12*int64(i)
		if err := fn(bo.Uint16(t[e:e+2]), bo.Uint16(t[e+2:e+4]), bo.Uint32(t[e+4:e+8]), e); err != nil {
			return n, err
		}
	}
	return n, nil
}

// cleanReader reads the first `size` bytes of src with every blank run as
// zeros. It seeks, so http.ServeContent can answer Range requests from it.
type cleanReader struct {
	src   io.ReaderAt
	blank []span
	size  int64
	pos   int64
}

func (c *cleanReader) Read(p []byte) (int, error) {
	if c.pos >= c.size {
		return 0, io.EOF
	}
	if rest := c.size - c.pos; int64(len(p)) > rest {
		p = p[:rest]
	}
	n, err := c.src.ReadAt(p, c.pos)
	for _, s := range c.blank {
		lo, hi := max(s.off, c.pos), min(s.off+s.n, c.pos+int64(n))
		if lo < hi {
			clear(p[lo-c.pos : hi-c.pos])
		}
	}
	c.pos += int64(n)
	if err == io.EOF && n > 0 {
		err = nil
	}
	return n, err
}

func (c *cleanReader) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		offset += c.pos
	case io.SeekEnd:
		offset += c.size
	default:
		return 0, errors.New("cleanReader: bad whence")
	}
	if offset < 0 {
		return 0, errors.New("cleanReader: negative position")
	}
	c.pos = offset
	return offset, nil
}
