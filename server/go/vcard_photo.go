package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// THE CONTACTS APP'S PICTURE, SET FROM CHAT. Chat's "new person" picks a card
// of the address book (data/contacts.vcf); a picture chosen for that person
// is the card's too, for ever (his ask, 2026-09-27): it becomes the card's
// PHOTO. Everything else in the file stays byte for byte - other cards,
// other lines, the line ends - the way the Contacts app itself only rewrites
// what an edit changed. The line is written the way the card's own VERSION
// says (3.0, as the Contacts app writes; 2.1 and 4.0 in their forms), and the
// Contacts app reads all three.

var errCardNotFound = errors.New("no such card")

// cardPhotoMu keeps two pictures set at once from writing over each other.
var cardPhotoMu sync.Mutex

// cardPhotoMax caps the picture: the page sends one of 300 x 300 px at most.
const cardPhotoMax = 1 << 20

// setCardPhoto makes `img` (a JPEG or a PNG) the PHOTO of the card whose UID
// is `uid` in the vCard file at `path`: its old PHOTO lines go, the new one
// goes just before its END.
func setCardPhoto(path, uid string, img []byte) error {
	typ := imageKind(img)
	if typ == "" {
		return errors.New("not a JPEG or a PNG")
	}
	cardPhotoMu.Lock()
	defer cardPhotoMu.Unlock()

	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return errCardNotFound
		}
		return err
	}
	out, err := withCardPhoto(raw, uid, typ, img)
	if err != nil {
		return err
	}
	tmp := filepath.Join(filepath.Dir(path), fmt.Sprintf("%s.%d.%d.tmp",
		filepath.Base(path), os.Getpid(), tmpCounter.Add(1)))
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		os.Remove(tmp)
		return err
	}
	// The whole address book on disk before it takes the name, and the name
	// durable after (K1): a power cut must leave either book, never a cut one.
	if err := syncFile(tmp); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return syncDir(filepath.Dir(path))
}

// imageKind is "JPEG" or "PNG" by the bytes' own signature, or "".
func imageKind(b []byte) string {
	switch {
	case len(b) > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "JPEG"
	case len(b) > 8 && bytes.Equal(b[:8], []byte("\x89PNG\r\n\x1a\n")):
		return "PNG"
	}
	return ""
}

// vcfLine is one content line: the physical lines it spans (folds, a 2.1
// QUOTED-PRINTABLE soft break, a blank line after a 2.1 PHOTO), its name
// without a group ("item1.") and its unfolded value.
type vcfLine struct {
	phys  []string
	name  string
	value string
}

// withCardPhoto is setCardPhoto on the file's bytes.
func withCardPhoto(raw []byte, uid, typ string, img []byte) ([]byte, error) {
	text := string(raw)
	nl := "\n"
	if strings.Contains(text, "\r\n") {
		nl = "\r\n"
	}
	phys := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")

	// Physical -> content lines (as the Contacts app's contentLines).
	var lines []vcfLine
	var cur *vcfLine
	var unfolded string
	soft := false
	flush := func() {
		if cur != nil {
			cur.name, cur.value = splitVcfLine(unfolded)
			lines = append(lines, *cur)
		}
	}
	for i, p := range phys {
		last := i == len(phys)-1
		if cur != nil && soft {
			unfolded = unfolded[:len(unfolded)-1] + p
			cur.phys = append(cur.phys, p)
			soft = strings.HasSuffix(p, "=")
			continue
		}
		if cur != nil && !last && (p == "" || p[0] == ' ' || p[0] == '\t') {
			if p != "" {
				unfolded += p[1:]
			}
			cur.phys = append(cur.phys, p)
			continue
		}
		flush()
		cur, unfolded = &vcfLine{phys: []string{p}}, p
		soft = strings.HasSuffix(p, "=") && isQPLine(p)
	}
	flush()

	// The card: from a BEGIN:VCARD to its END:VCARD, holding UID:<uid>.
	begin, end, found := -1, -1, false
	version := ""
	for i, l := range lines {
		switch l.name {
		case "BEGIN":
			if strings.EqualFold(strings.TrimSpace(l.value), "VCARD") {
				begin, found, version = i, false, ""
			}
		case "VERSION":
			version = strings.TrimSpace(l.value)
		case "UID":
			if begin >= 0 && strings.TrimSpace(l.value) == uid {
				found = true
			}
		case "END":
			if begin >= 0 && found && strings.EqualFold(strings.TrimSpace(l.value), "VCARD") {
				end = i
			}
		}
		if end >= 0 {
			break
		}
	}
	if end < 0 || uid == "" {
		return nil, errCardNotFound
	}

	b64 := base64.StdEncoding.EncodeToString(img)
	var photo []string
	switch version {
	case "2.1":
		photo = append(foldVcf("PHOTO;ENCODING=BASE64;TYPE="+typ+":"+b64), "")
	case "4.0":
		photo = foldVcf("PHOTO:data:image/" + strings.ToLower(typ) + ";base64," + b64)
	default:
		photo = foldVcf("PHOTO;ENCODING=b;TYPE=" + typ + ":" + b64)
	}

	var out []string
	for i, l := range lines {
		if i > begin && i < end && l.name == "PHOTO" {
			continue
		}
		if i == end {
			out = append(out, photo...)
		}
		out = append(out, l.phys...)
	}
	return []byte(strings.Join(out, nl)), nil
}

// splitVcfLine is a content line's name (upper case, no "group." prefix) and
// its value (after the first ":" outside quotes).
func splitVcfLine(s string) (string, string) {
	quoted := false
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			quoted = !quoted
		case ':':
			if quoted {
				continue
			}
			left := s[:i]
			if j := strings.IndexByte(left, ';'); j >= 0 {
				left = left[:j]
			}
			if j := strings.LastIndexByte(left, '.'); j >= 0 {
				left = left[j+1:]
			}
			return strings.ToUpper(strings.TrimSpace(left)), s[i+1:]
		}
	}
	return "", ""
}

// isQPLine: the line says QUOTED-PRINTABLE before its value (vCard 2.1).
func isQPLine(s string) bool {
	i := strings.IndexByte(s, ':')
	return i >= 0 && strings.Contains(strings.ToUpper(s[:i]), "QUOTED-PRINTABLE")
}

// foldVcf folds one line (ASCII here: base64) at 75 octets, a space leading
// every line after the first.
func foldVcf(s string) []string {
	out := []string{}
	max := 75
	for len(s) > max {
		out = append(out, s[:max])
		s = " " + s[max:]
		max = 75
	}
	return append(out, s)
}
