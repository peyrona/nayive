package main

// =============================================================================
// eMail: writing - a message built from what the app sends, and the address
// book the "To" field suggests from.
// =============================================================================
//
// THE MESSAGE. Plain text (UTF-8, quoted-printable) - or, when the app sends
// HTML too (the editor's formatting), multipart/alternative with both, plain
// first; the HTML is cleaned here too (sanitizeMailHTML) - and, when there are
// attachments, multipart/mixed with that body as part 1 and the files as
// parts 2, 3... in the order given - so after a draft is saved the app knows
// each file's part id without asking (mailDraftParts). Bcc goes into a draft
// (so reopening it keeps it) and never into a message sent.
//
// ATTACHMENTS come three ways and end up the same: uploaded with the request,
// a file of the user's own Drive ("files/..." or "shared/..."), or a part of
// another message ("keep": a draft's own files when it is saved again, the
// original's files when forwarding). Together at most mailMaxAttach bytes -
// Gmail's own limit for attachments.
//
// THE ADDRESS BOOK is data/contacts.vcf, the Contacts app's file: every
// EMAIL of every card, with the card's name.

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"mime"
	"mime/quotedprintable"
	netmail "net/mail"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	gomail "github.com/emersion/go-message/mail"
)

const mailMaxAttach = 25 << 20

var (
	errMailNoRcpt  = errors.New("mail: nobody to send it to")
	errMailBadAddr = errors.New("mail: an address is not valid")
	errMailTooBig  = errors.New("mail: the attachments are too big")
)

// MailOut is a message being written, as the app sends it.
type MailOut struct {
	To         string        `json:"to"` // as typed: "Ana <a@x.es>, b@y.com"
	Cc         string        `json:"cc"`
	Bcc        string        `json:"bcc"`
	Subject    string        `json:"subject"`
	Text       string        `json:"text"`
	HTML       string        `json:"html"`       // the same words, formatted (the editor's); empty: plain text only
	InReplyTo  string        `json:"inReplyTo"`  // a Message-ID, no brackets
	References []string      `json:"references"` // the thread so far
	MID        string        `json:"mid"`        // a draft keeps its Message-ID across saves
	DraftRef   string        `json:"draftRef"`   // the draft this one replaces (or, sent, deletes)
	Keep       []mailKeepRef `json:"keep"`
	Drive      []string      `json:"drive"`
}

type mailKeepRef struct {
	Acct string `json:"acct"`
	Ref  string `json:"ref"`
	Part string `json:"part"`
}

type mailOutFile struct {
	Name, Type string
	Data       []byte
}

// parseAddrs reads a typed list: commas or semicolons between addresses,
// "Name <a@b>" or bare "a@b". Empty is no error. A comma or semicolon inside
// a quoted name ("Pérez; Ana" <a@b>) is part of the name.
func parseAddrs(s string) ([]*netmail.Address, error) {
	var out []*netmail.Address
	for _, one := range splitAddrs(s) {
		a, err := netmail.ParseAddress(one)
		if err != nil {
			return nil, errMailBadAddr
		}
		out = append(out, a)
	}
	return out, nil
}

// splitAddrs cuts a typed list at the commas and semicolons outside quotes
// and angle brackets; empty pieces (a trailing comma) are left out.
func splitAddrs(s string) []string {
	var out []string
	var cur strings.Builder
	quoted, angle, esc := false, false, false
	flush := func() {
		if one := strings.TrimSpace(cur.String()); one != "" {
			out = append(out, one)
		}
		cur.Reset()
	}
	for _, r := range s {
		switch {
		case esc:
			esc = false
		case quoted && r == '\\':
			esc = true
		case r == '"':
			quoted = !quoted
		case !quoted && r == '<':
			angle = true
		case !quoted && r == '>':
			angle = false
		case !quoted && !angle && (r == ',' || r == ';'):
			flush()
			continue
		}
		cur.WriteRune(r)
	}
	flush()
	return out
}

// buildMail writes the message. draft: keep Bcc in it.
func buildMail(from *netmail.Address, m MailOut, files []mailOutFile, mid string, draft bool) ([]byte, []*netmail.Address, error) {
	to, err := parseAddrs(m.To)
	if err != nil {
		return nil, nil, err
	}
	cc, err := parseAddrs(m.Cc)
	if err != nil {
		return nil, nil, err
	}
	bcc, err := parseAddrs(m.Bcc)
	if err != nil {
		return nil, nil, err
	}
	rcpts := append(append(append([]*netmail.Address{}, to...), cc...), bcc...)

	var h gomail.Header
	h.SetDate(time.Now())
	h.SetAddressList("From", []*gomail.Address{from})
	if len(to) > 0 {
		h.SetAddressList("To", to)
	}
	if len(cc) > 0 {
		h.SetAddressList("Cc", cc)
	}
	if draft && len(bcc) > 0 {
		h.SetAddressList("Bcc", bcc)
	}
	h.SetSubject(strings.TrimSpace(m.Subject))
	h.SetMessageID(mid)
	if m.InReplyTo != "" {
		h.SetMsgIDList("In-Reply-To", []string{strings.Trim(m.InReplyTo, "<> ")})
	}
	if len(m.References) > 0 {
		var refs []string
		for _, r := range m.References {
			if r = strings.Trim(r, "<> "); r != "" {
				refs = append(refs, r)
			}
		}
		h.SetMsgIDList("References", refs)
	}

	text := strings.ReplaceAll(m.Text, "\r\n", "\n")
	htmlDoc := ""
	if body := strings.TrimSpace(m.HTML); body != "" {
		htmlDoc = mailHTMLDoc(sanitizeMailHTML(body, nil))
	}
	var th, hh gomail.InlineHeader
	th.Set("Content-Type", "text/plain; charset=utf-8")
	hh.Set("Content-Type", "text/html; charset=utf-8")
	// the body: the plain text alone, or it and the HTML side by side
	// (multipart/alternative, plain first: a reader shows the last it can)
	alternative := func(iw *gomail.InlineWriter) error {
		for _, p := range []struct {
			h    gomail.InlineHeader
			body string
		}{{th, text}, {hh, htmlDoc}} {
			pw, err := iw.CreatePart(p.h)
			if err != nil {
				return err
			}
			io.WriteString(pw, p.body)
			if err := pw.Close(); err != nil {
				return err
			}
		}
		return iw.Close()
	}
	var buf bytes.Buffer
	if len(files) == 0 {
		if htmlDoc != "" {
			iw, err := gomail.CreateInlineWriter(&buf, h)
			if err != nil {
				return nil, nil, err
			}
			if err := alternative(iw); err != nil {
				return nil, nil, err
			}
			return buf.Bytes(), rcpts, nil
		}
		h.Set("Content-Type", "text/plain; charset=utf-8")
		w, err := gomail.CreateSingleInlineWriter(&buf, h)
		if err != nil {
			return nil, nil, err
		}
		io.WriteString(w, text)
		if err := w.Close(); err != nil {
			return nil, nil, err
		}
		return buf.Bytes(), rcpts, nil
	}
	mw, err := gomail.CreateWriter(&buf, h)
	if err != nil {
		return nil, nil, err
	}
	if htmlDoc != "" {
		iw, err := mw.CreateInline()
		if err != nil {
			return nil, nil, err
		}
		if err := alternative(iw); err != nil {
			return nil, nil, err
		}
	} else {
		tw, err := mw.CreateSingleInline(th)
		if err != nil {
			return nil, nil, err
		}
		io.WriteString(tw, text)
		tw.Close()
	}
	for _, f := range files {
		var ah gomail.AttachmentHeader
		ah.Set("Content-Type", mailFileType(f))
		ah.SetFilename(f.Name)
		aw, err := mw.CreateAttachment(ah)
		if err != nil {
			return nil, nil, err
		}
		aw.Write(f.Data)
		aw.Close()
	}
	if err := mw.Close(); err != nil {
		return nil, nil, err
	}
	return buf.Bytes(), rcpts, nil
}

// mailHTMLDoc is the HTML part: what the app wrote, in a page of its own
// that names its charset (some readers guess otherwise), with a quote drawn
// as the usual line down its left.
func mailHTMLDoc(body string) string {
	return "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\">" +
		"<style>blockquote{margin:0 0 0 .8ex;padding-left:1ex;border-left:1px solid #ccc}</style>" +
		"</head><body>" + body + "</body></html>\n"
}

// mailFileType is the Content-Type a file goes out with: the one given,
// else its extension's, else plain bytes.
func mailFileType(f mailOutFile) string {
	ct := f.Type
	if ct == "" || !strings.Contains(ct, "/") {
		ct = mime.TypeByExtension(strings.ToLower(filepath.Ext(f.Name)))
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	return ct
}

// mailDraftParts is the parts a message built with these files has - with
// the type each was written with (a Drive file comes with none).
func mailDraftParts(files []mailOutFile) []MailPart {
	out := []MailPart{}
	for i, f := range files {
		ct := mailFileType(f)
		if mt, _, err := mime.ParseMediaType(ct); err == nil {
			ct = mt
		}
		out = append(out, MailPart{ID: itoa(i + 2), Name: f.Name, Type: ct, Size: int64(len(f.Data))})
	}
	return out
}

// newMailID is a fresh Message-ID on the sender's own domain.
func newMailID(from string) string {
	var h gomail.Header
	host := "nayive.local"
	if at := strings.LastIndexByte(from, '@'); at >= 0 && at < len(from)-1 {
		host = from[at+1:]
	}
	if err := h.GenerateMessageIDWithHostname(host); err != nil {
		return ""
	}
	id, _ := h.MessageID()
	return id
}

// -----------------------------------------------------------------------------
// the address book
// -----------------------------------------------------------------------------

type MailContact struct {
	Name  string `json:"name,omitempty"`
	Email string `json:"email"`
}

// Contacts reads the user's contacts.vcf: every card's addresses.
func (h *MailHub) Contacts(user string) []MailContact {
	out := []MailContact{}
	f, err := os.Open(filepath.Join(h.cfg.HomesDir, user, "data", "contacts.vcf"))
	if err != nil {
		return out
	}
	defer f.Close()
	// the logical lines: a folded line (a space or tab first) goes on with
	// the one before; so does the line after a QUOTED-PRINTABLE value that
	// ends in "=" (vCard 2.1's soft break, Android's exports)
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	qpOpen := false
	for sc.Scan() {
		l := strings.TrimRight(sc.Text(), "\r")
		switch {
		case qpOpen && len(lines) > 0:
			last := lines[len(lines)-1]
			lines[len(lines)-1] = last[:len(last)-1] + strings.TrimLeft(l, " \t")
		case (strings.HasPrefix(l, " ") || strings.HasPrefix(l, "\t")) && len(lines) > 0:
			lines[len(lines)-1] += l[1:]
		default:
			lines = append(lines, l)
		}
		last := lines[len(lines)-1]
		key, _, _ := strings.Cut(last, ":")
		qpOpen = strings.Contains(strings.ToUpper(key), "QUOTED-PRINTABLE") && strings.HasSuffix(last, "=")
	}
	seen := map[string]bool{}
	name := ""
	var emails []string
	flush := func() {
		for _, e := range emails {
			key := strings.ToLower(e)
			if !seen[key] {
				seen[key] = true
				out = append(out, MailContact{Name: name, Email: e})
			}
		}
		name, emails = "", nil
	}
	for _, l := range lines {
		key, val, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		params := strings.Split(strings.ToUpper(key), ";")
		prop := params[0]
		if i := strings.IndexByte(prop, '.'); i >= 0 { // "item1.EMAIL"
			prop = prop[i+1:]
		}
		switch prop {
		case "BEGIN":
			name, emails = "", nil
		case "FN":
			name = vcardUnescape(vcardDecode(val, params[1:], strings.Split(key, ";")[1:]))
		case "EMAIL":
			if e := strings.TrimSpace(vcardUnescape(vcardDecode(val, params[1:], strings.Split(key, ";")[1:]))); strings.Contains(e, "@") {
				emails = append(emails, e)
			}
		case "END":
			flush()
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

// vcardDecode undoes a vCard 2.1 value's ENCODING=QUOTED-PRINTABLE (or the
// bare QUOTED-PRINTABLE parameter) and CHARSET=... - upper: the parameters
// upper-cased, raw: as written (the charset's name).
func vcardDecode(val string, upper, raw []string) string {
	qp, cs := false, ""
	for i, p := range upper {
		switch {
		case p == "QUOTED-PRINTABLE" || p == "ENCODING=QUOTED-PRINTABLE":
			qp = true
		case strings.HasPrefix(p, "CHARSET="):
			cs = strings.ToLower(strings.TrimSpace(raw[i][len("CHARSET="):]))
		}
	}
	b := []byte(val)
	if qp {
		if out, err := io.ReadAll(quotedprintable.NewReader(strings.NewReader(val))); err == nil || len(out) > 0 {
			b = out
		}
	}
	if cs == "" && !utf8.Valid(b) {
		cs = "windows-1252"
	}
	return mailText(b, cs, false)
}

func vcardUnescape(s string) string {
	r := strings.NewReplacer(`\,`, ",", `\;`, ";", `\n`, " ", `\N`, " ", `\\`, `\`)
	return strings.TrimSpace(r.Replace(s))
}
