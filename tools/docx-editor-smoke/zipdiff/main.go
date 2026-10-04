// zipdiff - two .docx files, compared part by part by MEANING, not by bytes.
//
//	go -C tools run ./docx-editor-smoke/zipdiff original.docx saved.docx
//
// Prints one JSON object: {same, total, changed, blocks, lost, added, problems}.
// `blocks` is how many top-level blocks of the body (paragraphs, tables) differ
// when word/document.xml changed - an edit in one paragraph should say 1.
//
// Why not bytes: the engine re-serialises every XML part it keeps - no XML
// declaration, namespaces sorted, prefixes renamed - so a byte compare calls
// every part "changed" even when not one element moved. So each XML part is
// parsed (namespace PREFIXES vanish, their URIs stay) and compared as a tree,
// leaving out what carries no content:
//   - w14:paraId / w14:textId (paragraph ids Word itself adds and renews),
//   - xml:space, but ONLY where the text has no edge space - where it has one,
//     dropping "preserve" makes Word eat the space, so there it still counts,
//   - the ORDER of the prefixes in mc:Ignorable (it is a set),
//   - whitespace-only text between elements (indentation), but never inside a
//     leaf such as <w:t> </w:t>, where a lone space is content.
//
// Binary parts (images, fonts) - and an .xml part that does not parse
// (Synology's synoDoc.xml is JSON) - are compared byte for byte.
//
// `problems` is a small integrity check of the SAVED file, the kind of thing
// that makes Word refuse a document while lenient readers (pandoc) shrug:
//   - an mc:Ignorable prefix the part's root does not declare,
//   - a relationship whose internal target is missing from the zip,
//   - an r:id / r:embed used in a part but absent from that part's .rels.
//
// The output is byte for byte what the old zipdiff.py printed (Python's
// json.dumps: ", " and ": ", non-ASCII as is).
package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	w14Space = "http://schemas.microsoft.com/office/word/2010/wordml"
	xmlSpace = "http://www.w3.org/XML/1998/namespace"
	mcSpace  = "http://schemas.openxmlformats.org/markup-compatibility/2006"
	ws       = " \t\r\n" // XML's whitespace. NOT unicode.IsSpace: a no-break space is content
)

// node is one element as compared: "{uri}local" names, attributes sorted, the
// text before its first child, and each child with the text after it.
type node struct {
	tag   string
	attrs [][2]string
	text  string
	kids  []kid
}

type kid struct {
	n    *node
	tail string
}

func (a *node) equal(b *node) bool {
	if a.tag != b.tag || a.text != b.text || len(a.attrs) != len(b.attrs) || len(a.kids) != len(b.kids) {
		return false
	}
	for i := range a.attrs {
		if a.attrs[i] != b.attrs[i] {
			return false
		}
	}
	for i := range a.kids {
		if a.kids[i].tail != b.kids[i].tail || !a.kids[i].n.equal(b.kids[i].n) {
			return false
		}
	}
	return true
}

// raw is an element as parsed, before the compare's rules apply.
type raw struct {
	tag   string
	attrs [][2]string
	text  string
	kids  []*raw
	tail  string
}

var errParse = errors.New("not well-formed XML")

// parse reads one XML document into its root element, resolving namespace
// prefixes itself so an unbound prefix, a mismatched end tag, a repeated
// attribute or anything but space around the root is a parse error.
func parse(data []byte) (*raw, error) {
	wide := bytes.HasPrefix(data, []byte("\xFF\xFE")) || bytes.HasPrefix(data, []byte("\xFE\xFF"))
	if wide { // UTF-16 with its BOM: read as the UTF-8 it says
		if len(data)%2 != 0 {
			return nil, errParse
		}
		units := make([]uint16, len(data)/2-1)
		for i := range units {
			if data[0] == 0xFF {
				units[i] = uint16(data[2+2*i]) | uint16(data[3+2*i])<<8
			} else {
				units[i] = uint16(data[2+2*i])<<8 | uint16(data[3+2*i])
			}
		}
		data = []byte(string(utf16.Decode(units)))
	}
	data = bytes.TrimPrefix(data, []byte("\xEF\xBB\xBF"))
	// Every character of the file must be XML's, comments included - the
	// decoder below only checks text and attributes.
	if !utf8.Valid(data) || bytes.ContainsFunc(data, func(r rune) bool { return !xmlChar(r) }) {
		return nil, errParse
	}
	d := xml.NewDecoder(bytes.NewReader(data))
	d.CharsetReader = func(label string, in io.Reader) (io.Reader, error) {
		if wide && strings.HasPrefix(strings.ToLower(label), "utf-16") {
			return in, nil // already UTF-8
		}
		return nil, errParse
	}
	type open struct {
		el   *raw
		name xml.Name
		ns   map[string]string
	}
	var stack []open
	var root *raw
	var sink *string // where character data goes now
	scope := map[string]string{"xml": xmlSpace}
	for {
		at := d.InputOffset()
		tok, err := d.RawToken()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			// A literal tab or line end in an attribute value reads as a
			// space (XML's attribute-value normalisation; a &#10; stays a
			// line end). The decoder keeps them, so the tag is read again
			// with them made spaces - outside the quotes they only separate.
			if tag := data[at:d.InputOffset()]; bytes.ContainsAny(tag, "\t\n\r") {
				tag = bytes.ReplaceAll(tag, []byte("\r\n"), []byte(" "))
				tag = bytes.Map(func(r rune) rune {
					if r == '\t' || r == '\n' || r == '\r' {
						return ' '
					}
					return r
				}, tag)
				again, err := xml.NewDecoder(bytes.NewReader(tag)).RawToken()
				if err != nil {
					return nil, err
				}
				t = again.(xml.StartElement)
			}
			if len(stack) == 0 && root != nil {
				return nil, errParse // junk after the document element
			}
			ns, own := scope, false
			for _, a := range t.Attr {
				if a.Name.Space == "xmlns" || (a.Name.Space == "" && a.Name.Local == "xmlns") {
					if !own {
						ns, own = maps.Clone(scope), true
					}
					if a.Name.Space == "xmlns" {
						ns[a.Name.Local] = a.Value
					} else {
						ns[""] = a.Value
					}
				}
			}
			name := func(n xml.Name, attr bool) (string, error) {
				if n.Space == "" {
					if uri := ns[""]; !attr && uri != "" {
						return "{" + uri + "}" + n.Local, nil
					}
					return n.Local, nil
				}
				uri, ok := ns[n.Space]
				if !ok || uri == "" {
					return "", errParse // unbound prefix
				}
				return "{" + uri + "}" + n.Local, nil
			}
			tag, err := name(t.Name, false)
			if err != nil {
				return nil, err
			}
			el := &raw{tag: tag}
			seen := map[string]bool{}
			for _, a := range t.Attr {
				if a.Name.Space == "xmlns" || (a.Name.Space == "" && a.Name.Local == "xmlns") {
					continue
				}
				k, err := name(a.Name, true)
				if err != nil {
					return nil, err
				}
				if seen[k] {
					return nil, errParse // duplicate attribute
				}
				seen[k] = true
				el.attrs = append(el.attrs, [2]string{k, a.Value})
			}
			if len(stack) == 0 {
				root = el
			} else {
				p := stack[len(stack)-1].el
				p.kids = append(p.kids, el)
			}
			stack = append(stack, open{el: el, name: t.Name, ns: scope})
			scope = ns
			sink = &el.text
		case xml.EndElement:
			if len(stack) == 0 || stack[len(stack)-1].name != t.Name {
				return nil, errParse
			}
			top := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			scope = top.ns
			if len(stack) == 0 {
				sink = nil
			} else {
				sink = &top.el.tail
			}
		case xml.CharData:
			if sink == nil {
				if strings.Trim(string(t), ws) != "" {
					return nil, errParse // text outside the document element
				}
				continue
			}
			*sink += string(t)
		}
	}
	if root == nil || len(stack) > 0 {
		return nil, errParse
	}
	return root, nil
}

// xmlChar is XML 1.0's Char production.
func xmlChar(r rune) bool {
	return r == 0x09 || r == 0x0A || r == 0x0D ||
		r >= 0x20 && r <= 0xD7FF || r >= 0xE000 && r <= 0xFFFD || r >= 0x10000 && r <= 0x10FFFF
}

// tree is an element as compared (zipdiff's rules, see the header).
func tree(e *raw) *node {
	n := &node{tag: e.tag, text: e.text}
	for _, a := range e.attrs {
		k, v := a[0], a[1]
		if k == "{"+w14Space+"}paraId" || k == "{"+w14Space+"}textId" {
			continue
		}
		if k == "{"+xmlSpace+"}space" && e.text == strings.Trim(e.text, ws) {
			continue
		}
		if k == "{"+mcSpace+"}Ignorable" {
			f := strings.Fields(v)
			sort.Strings(f)
			v = strings.Join(f, " ")
		}
		n.attrs = append(n.attrs, [2]string{k, v})
	}
	sort.Slice(n.attrs, func(i, j int) bool {
		if n.attrs[i][0] != n.attrs[j][0] {
			return n.attrs[i][0] < n.attrs[j][0]
		}
		return n.attrs[i][1] < n.attrs[j][1]
	})
	if len(e.kids) > 0 && strings.Trim(e.text, ws) == "" {
		n.text = ""
	}
	for _, k := range e.kids {
		tail := k.tail
		if strings.Trim(tail, ws) == "" {
			tail = ""
		}
		n.kids = append(n.kids, kid{n: tree(k), tail: tail})
	}
	return n
}

// meaning is a part as compared: its tree for XML that parses, else its bytes.
type meaning struct {
	tree *node
	data []byte
}

func meaningOf(name string, data []byte) meaning {
	if !strings.HasSuffix(name, ".xml") && !strings.HasSuffix(name, ".rels") {
		return meaning{data: data}
	}
	e, err := parse(data)
	if err != nil {
		return meaning{data: data}
	}
	return meaning{tree: tree(e)}
}

func (a meaning) equal(b meaning) bool {
	if (a.tree == nil) != (b.tree == nil) {
		return false
	}
	if a.tree != nil {
		return a.tree.equal(b.tree)
	}
	return bytes.Equal(a.data, b.data)
}

// archive is one zip: its names in order (repeats too) and, per name, the
// last entry of that name - what Python's ZipFile.read takes.
type archive struct {
	names []string
	files map[string]*zip.File
}

func openZip(p string) (*archive, error) {
	r, err := zip.OpenReader(p)
	if err != nil {
		return nil, err
	}
	z := &archive{files: map[string]*zip.File{}}
	for _, f := range r.File {
		z.names = append(z.names, f.Name)
		z.files[f.Name] = f
	}
	return z, nil
}

func (z *archive) read(name string) []byte {
	rc, err := z.files[name].Open()
	if err == nil {
		var data []byte
		data, err = io.ReadAll(rc)
		rc.Close()
		if err == nil {
			return data
		}
	}
	fail(fmt.Errorf("%s: %w", name, err))
	return nil
}

// text is `data` as Python's decode('utf-8', 'replace') reads it: each
// maximal invalid subpart one U+FFFD.
func text(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	var b strings.Builder
	for i := 0; i < len(data); {
		r, size := utf8.DecodeRune(data[i:])
		if r != utf8.RuneError || size > 1 {
			b.WriteRune(r)
			i += size
			continue
		}
		b.WriteRune(utf8.RuneError)
		i += invalidRun(data[i:])
	}
	return b.String()
}

// invalidRun is the length of the maximal subpart of an ill-formed sequence
// at the start of `p` (at least 1 byte).
func invalidRun(p []byte) int {
	c := p[0]
	var need int
	lo, hi := byte(0x80), byte(0xBF)
	switch {
	case c >= 0xC2 && c <= 0xDF:
		need = 1
	case c >= 0xE0 && c <= 0xEF:
		need = 2
		if c == 0xE0 {
			lo = 0xA0
		} else if c == 0xED {
			hi = 0x9F
		}
	case c >= 0xF0 && c <= 0xF4:
		need = 3
		if c == 0xF0 {
			lo = 0x90
		} else if c == 0xF4 {
			hi = 0x8F
		}
	default:
		return 1
	}
	n := 1
	for k := 0; k < need && n < len(p); k++ {
		b := p[n]
		if k > 0 {
			lo, hi = 0x80, 0xBF
		}
		if b < lo || b > hi {
			break
		}
		n++
	}
	return n
}

// pyDirname is Python's posixpath.dirname: "" for a bare name.
func pyDirname(p string) string {
	i := strings.LastIndex(p, "/") + 1
	head := p[:i]
	if head != "" && strings.Trim(head, "/") != "" {
		head = strings.TrimRight(head, "/")
	}
	return head
}

// relsOf is the .rels file of a part: word/document.xml ->
// word/_rels/document.xml.rels.
func relsOf(part string) string {
	d, b := pyDirname(part), part[strings.LastIndex(part, "/")+1:]
	if d == "" {
		return "_rels/" + b + ".rels"
	}
	return strings.TrimRight(d, "/") + "/_rels/" + b + ".rels"
}

var (
	rootTag      = regexp.MustCompile(`<[A-Za-z][^?!][^>]*>`)
	ignorableRe  = regexp.MustCompile(`mc:Ignorable="([^"]*)"`)
	relationRe   = regexp.MustCompile(`<Relationship [^>]*>`)
	targetRe     = regexp.MustCompile(`Target="([^"]*)"`)
	usedIDRe     = regexp.MustCompile(`\br:(?:id|embed|link|pict)="([^"]*)"`)
	declaredIDRe = regexp.MustCompile(`Id="([^"]*)"`)
)

func problems(z *archive) []string {
	out := []string{}
	names := map[string]bool{}
	for _, n := range z.names {
		names[n] = true
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	for _, n := range sorted {
		if !strings.HasSuffix(n, ".xml") && !strings.HasSuffix(n, ".rels") {
			continue
		}
		t := text(z.read(n))

		if tag := rootTag.FindString(t); tag != "" {
			if ign := ignorableRe.FindStringSubmatch(tag); ign != nil {
				for _, p := range strings.Fields(ign[1]) {
					if !strings.Contains(tag, "xmlns:"+p+"=") {
						out = append(out, fmt.Sprintf(`%s: mc:Ignorable names "%s" but the root does not declare it`, n, p))
					}
				}
			}
		}

		if strings.HasSuffix(n, ".rels") {
			base := pyDirname(pyDirname(n))
			for _, r := range relationRe.FindAllString(t, -1) {
				if strings.Contains(r, `TargetMode="External"`) {
					continue
				}
				m := targetRe.FindStringSubmatch(r)
				if m == nil {
					fail(fmt.Errorf("%s: a Relationship with no Target: %s", n, r))
				}
				target := m[1]
				var full string
				if strings.HasPrefix(target, "/") {
					full = strings.TrimLeft(target, "/")
				} else if base == "" {
					full = path.Clean(target)
				} else {
					full = path.Clean(base + "/" + target)
				}
				if !names[full] {
					out = append(out, fmt.Sprintf("%s: target %s is not in the zip", n, target))
				}
			}
			continue
		}
		used := map[string]bool{}
		for _, m := range usedIDRe.FindAllStringSubmatch(t, -1) {
			used[m[1]] = true
		}
		if len(used) == 0 {
			continue
		}
		rp := relsOf(n)
		ids := map[string]bool{}
		if names[rp] {
			for _, m := range declaredIDRe.FindAllStringSubmatch(text(z.read(rp)), -1) {
				ids[m[1]] = true
			}
		}
		var missing []string
		for id := range used {
			if !ids[id] {
				missing = append(missing, id)
			}
		}
		sort.Strings(missing)
		for _, id := range missing {
			out = append(out, fmt.Sprintf("%s: uses %s, not in %s", n, id, rp))
		}
	}
	return out
}

// body is the top-level blocks of word/document.xml: the children of the
// first element (root first, in document order) whose tag ends in "}body".
func body(z *archive) []*raw {
	e, err := parse(z.read("word/document.xml"))
	if err != nil {
		fail(fmt.Errorf("word/document.xml: %w", err))
	}
	var find func(e *raw) *raw
	find = func(e *raw) *raw {
		if strings.HasSuffix(e.tag, "}body") {
			return e
		}
		for _, k := range e.kids {
			if b := find(k); b != nil {
				return b
			}
		}
		return nil
	}
	b := find(e)
	if b == nil {
		fail(errors.New("word/document.xml has no body"))
	}
	return b.kids
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "zipdiff:", err)
	os.Exit(1)
}

// pyString is a JSON string as Python's json.dumps(ensure_ascii=False)
// writes it.
func pyString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

func pyList(list []string) string {
	q := make([]string, len(list))
	for i, s := range list {
		q[i] = pyString(s)
	}
	return "[" + strings.Join(q, ", ") + "]"
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: zipdiff original.docx saved.docx")
		os.Exit(2)
	}
	a, err := openZip(os.Args[1])
	if err != nil {
		fail(err)
	}
	b, err := openZip(os.Args[2])
	if err != nil {
		fail(err)
	}
	same, changed := 0, []string{}
	for _, n := range a.names {
		if _, ok := b.files[n]; !ok {
			continue
		}
		if meaningOf(n, a.read(n)).equal(meaningOf(n, b.read(n))) {
			same++
		} else {
			changed = append(changed, n)
		}
	}
	blocks := 0
	for _, n := range changed {
		if n != "word/document.xml" {
			continue
		}
		x, y := body(a), body(b)
		for i := 0; i < len(x) && i < len(y); i++ {
			if !tree(x[i]).equal(tree(y[i])) {
				blocks++
			}
		}
		blocks += max(len(x)-len(y), len(y)-len(x))
		break
	}
	lost := []string{}
	inA := map[string]bool{}
	for _, n := range a.names {
		inA[n] = true
		if _, ok := b.files[n]; !ok {
			lost = append(lost, n)
		}
	}
	added := []string{}
	for n := range b.files {
		if !inA[n] {
			added = append(added, n)
		}
	}
	sort.Strings(added)
	fmt.Println("{" +
		`"same": ` + strconv.Itoa(same) + ", " +
		`"total": ` + strconv.Itoa(len(a.names)) + ", " +
		`"changed": ` + pyList(changed) + ", " +
		`"blocks": ` + strconv.Itoa(blocks) + ", " +
		`"lost": ` + pyList(lost) + ", " +
		`"added": ` + pyList(added) + ", " +
		`"problems": ` + pyList(problems(b)) + "}")
}
