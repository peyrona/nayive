package main

// =============================================================================
// AVIF (and any HEIF): the GPS in its Exif item, as zeros.
// =============================================================================
//
// An AVIF is a row of ISOBMFF boxes: ftyp, then a meta box whose iinf lists
// the file's items (the picture, maybe an "Exif" item, maybe an XMP one - a
// "mime" item of type application/rdf+xml) and whose iloc says where each
// item's bytes lie in the file. Leaving an item out would move every byte
// after it and so break iloc; instead, as for a JPEG, the bytes are blanked in
// place and the file keeps its length:
//
//   - the Exif item: its GPS IFD, found by the same walk as a JPEG's (gpsSpans),
//     over the item's bytes joined from all its extents, each run mapped back
//     to where it lies in the file. IFD0 - the Orientation - stays;
//   - an XMP item: all of it.
//
// REFUSED (an error, so nothing is sent): a brand that is not HEIF, a box that
// runs past its parent or the file, an infe older than version 2, an iloc
// field size other than 0/4/8, an Exif or XMP item that is not plain file
// bytes (construction_method not 0, or data in another file), an extent past
// the end of the file, an Exif item bigger than avifExifMax or one gpsSpans
// cannot walk. A picture item stored some other way (a grid in idat) is fine:
// only the Exif and XMP items are read.
//
// Only the top-level meta counts: a sequence (avis) may also carry a moov,
// which is not looked into.

import (
	"bytes"
	"encoding/binary"
	"io"
)

// avifExifMax is the largest Exif item walked; a bigger one is refused.
const avifExifMax = 4 << 20

// avifBoxesMax caps how many boxes one level may hold: a file of millions of
// empty boxes is refused rather than walked.
const avifBoxesMax = 1 << 16

// heifBrands are the ftyp brands of a still or sequence HEIF / AVIF.
var heifBrands = map[string]bool{
	"avif": true, "avis": true, "mif1": true, "msf1": true, "miaf": true,
	"heic": true, "heix": true, "heim": true, "heis": true, "hevc": true, "hevx": true,
}

// isoBox is one box: its type, where its payload starts, and where it ends.
type isoBox struct {
	typ       string
	body, end int64
}

// isoBoxes lists the boxes in [pos, end) of r. A box that runs past `end`, or
// whose header does not fit, is an error. size 0 means "to the end".
func isoBoxes(r io.ReaderAt, pos, end int64) ([]isoBox, error) {
	var boxes []isoBox
	head := make([]byte, 16)
	for pos < end {
		if end-pos < 8 {
			return nil, errBadImage
		}
		if _, err := r.ReadAt(head[:8], pos); err != nil {
			return nil, errBadImage
		}
		n := int64(binary.BigEndian.Uint32(head[:4]))
		body := pos + 8
		switch n {
		case 0:
			n = end - pos
		case 1:
			if end-pos < 16 {
				return nil, errBadImage
			}
			if _, err := r.ReadAt(head[8:16], pos+8); err != nil {
				return nil, errBadImage
			}
			large := binary.BigEndian.Uint64(head[8:16])
			if large > uint64(end-pos) {
				return nil, errBadImage
			}
			n, body = int64(large), pos+16
		}
		if n < body-pos || n > end-pos {
			return nil, errBadImage
		}
		boxes = append(boxes, isoBox{typ: string(head[4:8]), body: body, end: pos + n})
		if len(boxes) > avifBoxesMax {
			return nil, errBadImage
		}
		pos += n
	}
	return boxes, nil
}

// avifItem is one iloc entry: how its bytes are found, and where they lie.
type avifItem struct {
	method, dataRef uint16
	extents         []span
}

// planAVIF works out what cleanReader blanks in the HEIF in r. Nothing is cut.
func planAVIF(r io.ReaderAt, size int64) (jpegPlan, error) {
	plan := jpegPlan{end: size}
	top, err := isoBoxes(r, 0, size)
	if err != nil {
		return plan, err
	}
	if len(top) == 0 || top[0].typ != "ftyp" {
		return plan, errBadImage
	}
	ftyp, err := readBox(r, top[0])
	if err != nil || len(ftyp) < 8 || !isHEIF(ftyp) {
		return plan, errBadImage
	}

	for _, b := range top[1:] {
		if b.typ != "meta" {
			continue
		}
		runs, err := avifMeta(r, size, b)
		if err != nil {
			return plan, err
		}
		plan.blank = append(plan.blank, runs...)
	}
	return plan, nil
}

// isHEIF: the ftyp payload names a HEIF brand, as its major brand or among
// the compatible ones.
func isHEIF(ftyp []byte) bool {
	if heifBrands[string(ftyp[:4])] {
		return true
	}
	for i := 8; i+4 <= len(ftyp); i += 4 {
		if heifBrands[string(ftyp[i:i+4])] {
			return true
		}
	}
	return false
}

// readBox reads a box's payload; a box too big to be metadata is an error.
func readBox(r io.ReaderAt, b isoBox) ([]byte, error) {
	if b.end-b.body > avifExifMax {
		return nil, errBadImage
	}
	data := make([]byte, b.end-b.body)
	if _, err := r.ReadAt(data, b.body); err != nil {
		return nil, errBadImage
	}
	return data, nil
}

// avifMeta finds the runs to blank for one meta box.
func avifMeta(r io.ReaderAt, size int64, meta isoBox) ([]span, error) {
	if meta.end-meta.body < 4 {
		return nil, errBadImage
	}
	children, err := isoBoxes(r, meta.body+4, meta.end) // FullBox: version+flags
	if err != nil {
		return nil, err
	}
	var exifIDs, xmpIDs []uint32
	var locs map[uint32][]avifItem
	for _, c := range children {
		switch c.typ {
		case "iinf":
			data, err := readBox(r, c)
			if err != nil {
				return nil, err
			}
			e, x, err := parseIinf(data, c.body)
			if err != nil {
				return nil, err
			}
			exifIDs, xmpIDs = append(exifIDs, e...), append(xmpIDs, x...)
		case "iloc":
			if locs != nil {
				return nil, errBadImage // two indexes: which one counts?
			}
			data, err := readBox(r, c)
			if err != nil {
				return nil, err
			}
			if locs, err = parseIloc(data); err != nil {
				return nil, err
			}
		}
	}

	var runs []span
	for _, id := range xmpIDs {
		for _, it := range locs[id] {
			ext, err := fileExtents(it, size)
			if err != nil {
				return nil, err
			}
			runs = append(runs, ext...)
		}
	}
	for _, id := range exifIDs {
		for _, it := range locs[id] {
			ext, err := fileExtents(it, size)
			if err != nil {
				return nil, err
			}
			got, err := avifExifRuns(r, ext)
			if err != nil {
				return nil, err
			}
			runs = append(runs, got...)
		}
	}
	return runs, nil
}

// fileExtents are an item's extents as runs of the file: refused unless the
// item is plain bytes of this file, all inside it. Length 0 = to the end.
func fileExtents(it avifItem, size int64) ([]span, error) {
	if it.method != 0 || it.dataRef != 0 {
		return nil, errBadImage
	}
	out := make([]span, 0, len(it.extents))
	for _, e := range it.extents {
		if e.off < 0 || e.off > size {
			return nil, errBadImage
		}
		n := e.n
		if n == 0 {
			n = size - e.off
		}
		if n < 0 || n > size-e.off {
			return nil, errBadImage
		}
		out = append(out, span{e.off, n})
	}
	return out, nil
}

// avifExifRuns reads an Exif item from its extents and answers its GPS runs
// as file offsets. The item: a 4-byte offset, then the TIFF data that far on.
func avifExifRuns(r io.ReaderAt, ext []span) ([]span, error) {
	var total int64
	for _, e := range ext {
		total += e.n
		if total > avifExifMax {
			return nil, errBadImage
		}
	}
	data := make([]byte, 0, total)
	for _, e := range ext {
		part := make([]byte, e.n)
		if _, err := r.ReadAt(part, e.off); err != nil {
			return nil, errBadImage
		}
		data = append(data, part...)
	}
	if len(data) < 4 {
		return nil, errBadImage
	}
	skip := int64(binary.BigEndian.Uint32(data[:4]))
	if skip > int64(len(data))-4 {
		return nil, errBadImage
	}
	at := 4 + skip
	runs, err := gpsSpans(data[at:], at) // offsets into the joined item
	if err != nil {
		return nil, err
	}

	// Each run of the joined item, laid back over the extents it falls in.
	var out []span
	for _, s := range runs {
		lo, hi := s.off, s.off+s.n
		pos := int64(0)
		for _, e := range ext {
			a, b := max(lo, pos), min(hi, pos+e.n)
			if a < b {
				out = append(out, span{e.off + a - pos, b - a})
			}
			pos += e.n
		}
	}
	return out, nil
}

// parseIinf answers the item IDs of the Exif items and of the XMP ones. `data`
// is the iinf payload.
func parseIinf(data []byte, base int64) (exif, xmp []uint32, err error) {
	if len(data) < 4 {
		return nil, nil, errBadImage
	}
	skip := int64(6) // version+flags, 16-bit entry count
	if data[0] != 0 {
		skip = 8 // 32-bit entry count
	}
	if int64(len(data)) < skip {
		return nil, nil, errBadImage
	}
	infes, err := isoBoxes(bytes.NewReader(data), skip, int64(len(data)))
	if err != nil {
		return nil, nil, err
	}
	for _, b := range infes {
		if b.typ != "infe" {
			continue
		}
		e := data[b.body:b.end]
		if len(e) < 4 {
			return nil, nil, errBadImage
		}
		var id uint32
		var rest []byte
		switch e[0] {
		case 2:
			if len(e) < 12 {
				return nil, nil, errBadImage
			}
			id, rest = uint32(binary.BigEndian.Uint16(e[4:6])), e[8:]
		case 3:
			if len(e) < 14 {
				return nil, nil, errBadImage
			}
			id, rest = binary.BigEndian.Uint32(e[4:8]), e[10:]
		default:
			return nil, nil, errBadImage // no item_type before version 2
		}
		switch string(rest[:4]) {
		case "Exif":
			exif = append(exif, id)
		case "mime":
			// item_name\0 content_type\0 ...
			name := bytes.IndexByte(rest[4:], 0)
			if name < 0 {
				return nil, nil, errBadImage
			}
			if bytes.HasPrefix(rest[4+name+1:], []byte("application/rdf+xml")) {
				xmp = append(xmp, id)
			}
		}
	}
	return exif, xmp, nil
}

// parseIloc reads the iloc payload into its items by ID.
func parseIloc(data []byte) (map[uint32][]avifItem, error) {
	p := &beReader{b: data}
	version := p.n(1)
	p.n(3) // flags
	sizes := p.n(1)
	sizes2 := p.n(1)
	offSize, lenSize := sizes>>4, sizes&15
	baseSize, idxSize := sizes2>>4, uint64(0)
	if version == 1 || version == 2 {
		idxSize = sizes2 & 15
	}
	if version > 2 || !okSize(offSize) || !okSize(lenSize) || !okSize(baseSize) || !okSize(idxSize) {
		return nil, errBadImage
	}
	wide := 2
	if version == 2 {
		wide = 4
	}
	count := p.n(wide)
	if p.bad {
		return nil, errBadImage
	}
	items := map[uint32][]avifItem{}
	all := uint64(0) // extents in all: with 0-byte fields they cost nothing to write
	for i := uint64(0); i < count; i++ {
		id := uint32(p.n(wide))
		var it avifItem
		if version >= 1 {
			it.method = uint16(p.n(2) & 15)
		}
		it.dataRef = uint16(p.n(2))
		baseOff := p.n(int(baseSize))
		extents := p.n(2)
		if all += extents; p.bad || all > avifBoxesMax {
			return nil, errBadImage
		}
		for j := uint64(0); j < extents; j++ {
			p.n(int(idxSize))
			off, n := p.n(int(offSize)), p.n(int(lenSize))
			if p.bad {
				return nil, errBadImage
			}
			at := baseOff + off
			if at < baseOff || at > 1<<62 || n > 1<<62 {
				return nil, errBadImage // overflow: no real file is that big
			}
			it.extents = append(it.extents, span{int64(at), int64(n)})
		}
		items[id] = append(items[id], it)
	}
	return items, nil
}

func okSize(n uint64) bool { return n == 0 || n == 4 || n == 8 }

// beReader reads big-endian numbers of 0-8 bytes; running out sets bad.
type beReader struct {
	b   []byte
	bad bool
}

func (p *beReader) n(size int) uint64 {
	if size > len(p.b) {
		p.bad, p.b = true, nil
		return 0
	}
	v := uint64(0)
	for _, c := range p.b[:size] {
		v = v<<8 | uint64(c)
	}
	p.b = p.b[size:]
	return v
}
