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
// A PNG or a WebP keeps its metadata in chunks of its own (spliceReader). The
// EXIF chunk (PNG eXIf, WebP EXIF) stays, with its GPS IFD as zeros, the same
// walk as above - it holds the Orientation; a PNG's chunk gets its CRC anew.
// One this cannot walk is LEFT OUT, as are the text chunks: PNG tEXt, iTXt
// (XMP) and zTXt, WebP "XMP " (and the VP8X flags that announce what went,
// and the RIFF size put right). Anything after the image's end is cut, as for
// a JPEG. cleanImage picks by the file's first bytes, not its name: a browser
// does too.
//
// An AVIF (or any HEIF) keeps its Exif and XMP as items its index (iloc)
// points at; leaving one out would mean rewriting that index, so they are
// blanked in place as for a JPEG: the GPS IFD of the Exif item, all of an XMP
// item (exifstrip_avif.go). One this cannot walk is refused.
//
// Not handled: GIF (phones write no GPS there; an XMP application block would
// pass) and BMP (it has no metadata at all).
//
// exifmeta.go READS the same blocks, with the same walkers.

import (
	"bufio"
	"bytes"
	"cmp"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
	"os"
	"slices"
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

// planCache keeps a file's walk per version (path, size, mtime): a visitor
// paging through an album asks for the same photos again, and walking means
// reading the whole file.
type planCache[T any] struct {
	sync.Mutex
	m map[string]T
}

const planCacheMax = 4096

var (
	jpegPlans   = planCache[jpegPlan]{m: map[string]jpegPlan{}}
	splicePlans = planCache[[]piece]{m: map[string][]piece{}} // planPNG / planWebP
)

// get is the plan for `key` (the file's absolute path) at this version,
// made by `plan` the first time.
func (c *planCache[T]) get(key string, info os.FileInfo, plan func() (T, error)) (T, error) {
	key += "|" + itoa64(info.Size()) + "|" + itoa64(info.ModTime().UnixNano())
	c.Lock()
	v, found := c.m[key]
	c.Unlock()
	if found {
		return v, nil
	}
	v, err := plan()
	if err != nil {
		return v, err
	}
	c.Lock()
	if len(c.m) >= planCacheMax {
		clear(c.m) // crude, and enough: it only saves a re-walk
	}
	c.m[key] = v
	c.Unlock()
	return v, nil
}

// cleanJPEG is `file` as a stranger may read it. `key` names the file (its
// absolute path) for the cache.
func cleanJPEG(key string, file *os.File, info os.FileInfo) (*cleanReader, error) {
	return cleanBlanked(key, file, info, planJPEG)
}

// cleanBlanked is `file` with what `planner` finds blanked and cut, the plan
// cached per file version.
func cleanBlanked(key string, file *os.File, info os.FileInfo,
	planner func(io.ReaderAt, int64) (jpegPlan, error)) (*cleanReader, error) {

	plan, err := jpegPlans.get(key, info, func() (jpegPlan, error) { return planner(file, info.Size()) })
	if err != nil {
		return nil, err
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
	return seekTo(&c.pos, c.size, offset, whence, "cleanReader")
}

// seekTo is io.Seeker over a reader at *pos of `size` bytes; `name` is the
// reader's, for the two errors.
func seekTo(pos *int64, size, offset int64, whence int, name string) (int64, error) {
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		offset += *pos
	case io.SeekEnd:
		offset += size
	default:
		return 0, errors.New(name + ": bad whence")
	}
	if offset < 0 {
		return 0, errors.New(name + ": negative position")
	}
	*pos = offset
	return offset, nil
}

// -----------------------------------------------------------------------------
// PNG and WebP: the metadata chunks left out
// -----------------------------------------------------------------------------

var errBadImage = errors.New("not an image this can walk")

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// cleanImage is a public photo as a stranger may read it: a JPEG, PNG, WebP
// or AVIF without its position, anything else as it is. `key` names the file
// (its absolute path) for the cache.
//
// By its first bytes, never its name - except that a NAME this cleans (ctype
// image/jpeg, png, webp or avif) whose content is none of the four is refused
// (errBadImage): a TIFF renamed .png would otherwise go out with its GPS, and
// a browser would show it anyway. Any ISOBMFF file (ftyp) goes to planAVIF,
// which refuses one that is not HEIF - an MP4 renamed .gif is not sent.
func cleanImage(key string, file *os.File, info os.FileInfo, ctype string) (io.ReadSeeker, error) {
	head := make([]byte, 12)
	n, _ := file.ReadAt(head, 0)
	head = head[:n]
	switch {
	case bytes.HasPrefix(head, []byte{0xFF, 0xD8}):
		return cleanJPEG(key, file, info)
	case bytes.HasPrefix(head, pngSignature):
		return cleanSpliced(key, file, info, planPNG)
	case n == 12 && string(head[:4]) == "RIFF" && string(head[8:]) == "WEBP":
		return cleanSpliced(key, file, info, planWebP)
	case n >= 8 && string(head[4:8]) == "ftyp":
		return cleanBlanked(key, file, info, planAVIF)
	case ctype == "image/jpeg" || ctype == "image/png" || ctype == "image/webp" || ctype == "image/avif":
		return nil, errBadImage
	}
	return file, nil
}

// piece is one run of what is sent: n bytes of the file from off, n zeros
// (zero), or lit.
type piece struct {
	off, n int64
	zero   bool
	lit    []byte
}

func (p piece) len() int64 {
	if p.lit != nil {
		return int64(len(p.lit))
	}
	return p.n
}

// cleanSpliced is `file` as `plan` lays it out.
func cleanSpliced(key string, file *os.File, info os.FileInfo,
	plan func(io.ReaderAt, int64) ([]piece, error)) (*spliceReader, error) {

	pieces, err := splicePlans.get(key, info, func() ([]piece, error) { return plan(file, info.Size()) })
	if err != nil {
		return nil, err
	}
	return newSpliceReader(file, pieces), nil
}

// splicePiecesMax is the most pieces a PNG or WebP may come to. A real
// picture has a handful - kept chunks that follow on join into one - but one
// made of alternating dropped and kept empty chunks has one per chunk, and
// such a file is refused rather than planned, cached and served.
const splicePiecesMax = 4096

// keep adds the file's bytes [off, off+n) to the pieces, joined to the last
// run when they follow on.
func keep(pieces []piece, off, n int64) []piece {
	if n <= 0 {
		return pieces
	}
	if k := len(pieces) - 1; k >= 0 && pieces[k].lit == nil && !pieces[k].zero && pieces[k].off+pieces[k].n == off {
		pieces[k].n += n
		return pieces
	}
	return append(pieces, piece{off: off, n: n})
}

// keepBlanked adds the file's bytes [off, off+n) with the runs (sorted) as zeros.
func keepBlanked(pieces []piece, off, n int64, runs []span) []piece {
	end := off + n
	for _, s := range runs {
		lo, hi := max(s.off, off), min(s.off+s.n, end)
		if lo >= hi {
			continue
		}
		pieces = append(keep(pieces, off, lo-off), piece{off: lo, n: hi - lo, zero: true})
		off = hi
	}
	return keep(pieces, off, end-off)
}

// exifMax is the largest EXIF chunk walked; a bigger one is left out.
const exifMax = 1 << 20

// exifChunk reads the EXIF data at [off, off+n) - TIFF, maybe after
// "Exif\0\0" - and finds its GPS runs, sorted. ok is false when it cannot be
// walked: then it is left out.
func exifChunk(r io.ReaderAt, off, n int64) (data []byte, runs []span, ok bool) {
	if n <= 0 || n > exifMax {
		return nil, nil, false
	}
	data = make([]byte, n)
	if _, err := r.ReadAt(data, off); err != nil {
		return nil, nil, false
	}
	tiff, base := data, off
	if bytes.HasPrefix(tiff, []byte("Exif\x00\x00")) {
		tiff, base = tiff[6:], off+6
	}
	runs, err := gpsSpans(tiff, base)
	if err != nil {
		return nil, nil, false
	}
	slices.SortFunc(runs, func(a, b span) int { return cmp.Compare(a.off, b.off) })
	return data, runs, true
}

// planPNG keeps every chunk of a PNG up to IEND but the text ones, and eXIf
// with its GPS as zeros and its CRC anew. A chunk cut short by the end of the
// file is kept as far as it goes, unless it is metadata.
func planPNG(r io.ReaderAt, size int64) ([]piece, error) {
	pieces := []piece{{off: 0, n: 8}}
	head := make([]byte, 8)
	for pos := int64(8); pos+8 <= size; {
		if _, err := r.ReadAt(head, pos); err != nil {
			return nil, errBadImage
		}
		typ := string(head[4:])
		n := int64(binary.BigEndian.Uint32(head[:4]))
		end := min(pos+12+n, size)
		switch typ {
		case "tEXt", "iTXt", "zTXt":
		case "eXIf":
			data, runs, ok := exifChunk(r, pos+8, n)
			if !ok || end < pos+12+n {
				break // left out
			}
			if len(runs) == 0 {
				pieces = keep(pieces, pos, end-pos)
				break
			}
			for _, s := range runs {
				clear(data[s.off-pos-8 : s.off-pos-8+s.n])
			}
			crc := crc32.NewIEEE()
			crc.Write(head[4:])
			crc.Write(data)
			pieces = keepBlanked(keep(pieces, pos, 8), pos+8, n, runs)
			pieces = append(pieces, piece{lit: crc.Sum(nil)})
		default:
			pieces = keep(pieces, pos, end-pos)
		}
		if typ == "IEND" {
			break
		}
		if len(pieces) > splicePiecesMax {
			return nil, errBadImage
		}
		pos = end
	}
	return pieces, nil
}

// planWebP keeps every chunk of a WebP but "XMP ", and EXIF with its GPS as
// zeros; clears the VP8X flags of what went, and writes the RIFF size anew.
// Nothing after the RIFF is sent.
func planWebP(r io.ReaderAt, size int64) ([]piece, error) {
	riff := make([]byte, 12)
	if _, err := r.ReadAt(riff, 0); err != nil {
		return nil, errBadImage
	}
	riffEnd := min(8+int64(binary.LittleEndian.Uint32(riff[4:8])), size)
	pieces := []piece{{lit: riff}} // its size is put right at the end
	total := int64(12)
	head := make([]byte, 9)
	var flags []byte // VP8X's, put right at the end
	exifKept := false
	for pos := int64(12); pos+8 <= riffEnd; {
		if _, err := r.ReadAt(head[:8], pos); err != nil {
			return nil, errBadImage
		}
		fourcc := string(head[:4])
		n := int64(binary.LittleEndian.Uint32(head[4:8]))
		end := min(pos+8+n+n%2, riffEnd)
		switch {
		case fourcc == "XMP ":
		case fourcc == "EXIF":
			_, runs, ok := exifChunk(r, pos+8, n)
			if !ok || pos+8+n > riffEnd {
				break // left out
			}
			pieces = keepBlanked(keep(pieces, pos, 8), pos+8, n, runs)
			pieces = keep(pieces, pos+8+n, end-pos-8-n) // the pad byte
			total += end - pos
			exifKept = true
		case fourcc == "VP8X" && end > pos+8 && flags == nil:
			if _, err := r.ReadAt(head[8:], pos+8); err != nil {
				return nil, errBadImage
			}
			flags = []byte{head[8]}
			pieces = append(keep(pieces, pos, 8), piece{lit: flags})
			pieces = keep(pieces, pos+9, end-pos-9)
			total += end - pos
		default:
			pieces = keep(pieces, pos, end-pos)
			total += end - pos
		}
		if len(pieces) > splicePiecesMax {
			return nil, errBadImage
		}
		pos = end
	}
	if flags != nil {
		flags[0] &^= 0x04 // XMP
		if !exifKept {
			flags[0] &^= 0x08
		}
	}
	binary.LittleEndian.PutUint32(riff[4:8], uint32(total-8))
	return pieces, nil
}

// spliceReader reads the pieces one after the other. It seeks, so
// http.ServeContent can answer Range requests from it.
type spliceReader struct {
	src    io.ReaderAt
	pieces []piece
	ends   []int64 // ends[i]: where piece i ends in the output
	size   int64
	pos    int64
}

func newSpliceReader(src io.ReaderAt, pieces []piece) *spliceReader {
	ends := make([]int64, len(pieces))
	size := int64(0)
	for i, p := range pieces {
		size += p.len()
		ends[i] = size
	}
	return &spliceReader{src: src, pieces: pieces, ends: ends, size: size}
}

// Read fills p from as many pieces as it takes, finding the first by binary
// search: one piece per call, found by walking from the start, made a file of
// many small pieces quadratic to send.
func (s *spliceReader) Read(p []byte) (int, error) {
	if s.pos >= s.size {
		return 0, io.EOF
	}
	done := 0
	i, _ := slices.BinarySearch(s.ends, s.pos+1) // the first piece ending past pos
	for ; done < len(p) && i < len(s.pieces); i++ {
		pc := s.pieces[i]
		at := s.pos - (s.ends[i] - pc.len())
		want := min(int64(len(p)-done), pc.len()-at)
		dst := p[done : done+int(want)]
		switch {
		case pc.zero:
			clear(dst)
		case pc.lit != nil:
			copy(dst, pc.lit[at:])
		default:
			got, err := s.src.ReadAt(dst, pc.off+at)
			done += got
			s.pos += int64(got)
			if got < len(dst) {
				if err == nil || err == io.EOF {
					err = io.ErrUnexpectedEOF // the file shrank under us
				}
				if done > 0 {
					return done, nil // the error comes back on the next Read
				}
				return 0, err
			}
			continue
		}
		done += int(want)
		s.pos += want
	}
	return done, nil
}

func (s *spliceReader) Seek(offset int64, whence int) (int64, error) {
	return seekTo(&s.pos, s.size, offset, whence, "spliceReader")
}
