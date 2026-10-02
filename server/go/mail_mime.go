package main

// =============================================================================
// eMail: decoding parts, the row's snippet, and cleaning a message's HTML.
// =============================================================================
//
// CLEANING. A message's HTML is shown in a sandboxed iframe with no scripts
// and a strict Content-Security-Policy (email/read.js): that is the real wall.
// This pass is the second one, so a hole in either is not yet a hole: it
// drops the elements that run or embed things (script, iframe, object,
// form...), every on* handler, and javascript:/vbscript: URLs (also written
// with entities, "jav&#x61;script:"), and points "cid:" pictures at the
// attachment route. It is a text filter, not an HTML parser - on purpose it
// errs on the side of deleting too much - and it runs until nothing changes,
// so a tag split by another one ("<scr<iframe>ipt>") cannot re-form.

import (
	"bytes"
	"html"
	"io"
	"mime/quotedprintable"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-message/charset"
)

// b64 maps a base64 character to its value; 0xFF = not one.
var b64 = func() (t [256]byte) {
	for i := range t {
		t[i] = 0xFF
	}
	for i, c := range "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/" {
		t[c] = byte(i)
	}
	return
}()

// decodeBase64 decodes base64 the way mail needs it: characters outside the
// alphabet (line breaks, spaces, junk) are skipped, as RFC 2045 asks, and "="
// padding ends one group, not the lot - some mailers encode chunk by chunk,
// with padding in the middle. A trailing lone character is dropped. It writes
// over its input (4 characters in, at most 3 bytes out): no second copy.
func decodeBase64(b []byte) []byte {
	out := b[:0]
	var q [4]byte
	n := 0
	for _, ch := range b {
		if ch == '=' {
			switch n {
			case 2:
				out = append(out, q[0]<<2|q[1]>>4)
			case 3:
				out = append(out, q[0]<<2|q[1]>>4, q[1]<<4|q[2]>>2)
			}
			n = 0
			continue
		}
		v := b64[ch]
		if v == 0xFF {
			continue
		}
		q[n] = v
		if n++; n == 4 {
			out = append(out, q[0]<<2|q[1]>>4, q[1]<<4|q[2]>>2, q[2]<<6|q[3])
			n = 0
		}
	}
	switch n { // no padding at the end
	case 2:
		out = append(out, q[0]<<2|q[1]>>4)
	case 3:
		out = append(out, q[0]<<2|q[1]>>4, q[1]<<4|q[2]>>2)
	}
	return out
}

// decodeTransfer undoes Content-Transfer-Encoding. truncated: raw is only
// the start of the part (a snippet) - a cut "=" escape at the end is dropped
// instead of failing the lot. base64 is decoded in place.
func decodeTransfer(raw []byte, enc string, truncated bool) []byte {
	switch strings.ToLower(strings.TrimSpace(enc)) {
	case "base64": // a group the cut left short still gives its whole bytes
		return decodeBase64(raw)
	case "quoted-printable":
		if truncated {
			if i := bytes.LastIndexByte(raw, '='); i >= 0 && len(raw)-i < 3 {
				raw = raw[:i]
			}
		}
		out, _ := io.ReadAll(quotedprintable.NewReader(bytes.NewReader(raw)))
		return out
	}
	return raw
}

// decodeMailPart is a text part as UTF-8.
func decodeMailPart(raw []byte, enc, cs string, truncated bool) string {
	return mailText(decodeTransfer(raw, enc, truncated), cs, false)
}

var reMailMetaCharset = regexp.MustCompile(`(?i)<meta\b[^>]*charset\s*=\s*["']?\s*([a-z0-9_.:-]+)`)

// mailText is decoded bytes as UTF-8: the charset the MIME header names;
// with none, for HTML the one its own <meta> names; else UTF-8 when the
// bytes are UTF-8, and windows-1252 (the Latin-1 most old mailers mean) when
// they are not - never a "\uFFFD" for every accent.
func mailText(b []byte, cs string, isHTML bool) string {
	cs = strings.ToLower(strings.TrimSpace(cs))
	if (cs == "" || cs == "us-ascii") && isHTML {
		head := b
		if len(head) > 4096 {
			head = head[:4096]
		}
		if m := reMailMetaCharset.FindSubmatch(head); m != nil {
			cs = strings.ToLower(string(m[1]))
		}
	}
	if (cs == "" || cs == "us-ascii") && !utf8.Valid(b) {
		cs = "windows-1252"
	}
	if cs != "" && cs != "utf-8" && cs != "utf8" && cs != "us-ascii" {
		if r, err := charset.Reader(cs, bytes.NewReader(b)); err == nil {
			if out, err := io.ReadAll(r); err == nil || len(out) > 0 {
				b = out
			}
		}
	}
	return strings.ToValidUTF8(string(b), "\uFFFD")
}

// mailLeafText is a body leaf as text: transfer-decoded, as UTF-8 (mailText),
// and plain "format=flowed" text unwrapped (RFC 3676).
func mailLeafText(raw []byte, sp *imap.BodyStructureSinglePart, truncated bool) string {
	isHTML := sp.MediaType() == "text/html"
	t := mailText(decodeTransfer(raw, sp.Encoding, truncated), sp.Params["charset"], isHTML)
	if !isHTML && strings.EqualFold(sp.Params["format"], "flowed") {
		t = unflowText(t, strings.EqualFold(sp.Params["delsp"], "yes"))
	}
	return t
}

// unflowText joins format=flowed text (RFC 3676): a line ending in a space
// goes on in the next one of the same quote depth; one leading space is
// "stuffing"; with DelSp=yes the joining space itself goes. The signature
// separator "-- " is never flowed.
func unflowText(text string, delsp bool) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var out []string
	cur, depth, open := "", 0, false
	flush := func() {
		if depth > 0 {
			out = append(out, strings.Repeat(">", depth)+" "+cur)
		} else {
			out = append(out, cur)
		}
	}
	for _, ln := range lines {
		d := 0
		for d < len(ln) && ln[d] == '>' {
			d++
		}
		body := strings.TrimPrefix(ln[d:], " ")
		if open && d != depth { // a flowed paragraph never crosses quote depths
			flush()
			open = false
		}
		if open {
			cur += body
		} else {
			cur, depth = body, d
		}
		if body != "-- " && strings.HasSuffix(body, " ") {
			if delsp {
				cur = strings.TrimSuffix(cur, " ")
			}
			open = true
			continue
		}
		flush()
		open = false
	}
	if open {
		flush()
	}
	return strings.Join(out, "\n")
}

var (
	reMailBlockDrop = regexp.MustCompile(`(?is)<(script|style|head|title|noscript|template|svg|math)\b.*?</(script|style|head|title|noscript|template|svg|math)\s*>`)
	reMailComment   = regexp.MustCompile(`(?s)<!--.*?-->`)
	reMailOpenBlock = regexp.MustCompile(`(?is)(<!--|<(script|style|head|title|noscript|template|svg|math)\b).*$`)
	reMailBodyTag   = regexp.MustCompile(`(?is)<body\b[^>]*>`)
	reMailTag       = regexp.MustCompile(`(?s)<[^>]*>`)
	reMailBlockEnd  = regexp.MustCompile(`(?i)<(br|/p|/div|/tr|/li|/h[1-6])\b[^>]*>`)
	reMailSpace     = regexp.MustCompile(`\s+`)
)

// mailSnippet is one line of plain text, ~160 characters, for a list row.
// HTML: from its <body> on; whatever is left of a <head>, <style> or
// comment the cut left open goes, so a row never shows CSS.
func mailSnippet(text string, isHTML bool) string {
	if isHTML {
		if loc := reMailBodyTag.FindStringIndex(text); loc != nil {
			text = text[loc[1]:]
		}
		text = reMailComment.ReplaceAllString(text, " ")
		text = reMailBlockDrop.ReplaceAllString(text, " ")
		text = reMailOpenBlock.ReplaceAllString(text, " ")
		text = reMailBlockEnd.ReplaceAllString(text, " ")
		text = reMailTag.ReplaceAllString(text, "")
		if i := strings.LastIndexByte(text, '<'); i >= 0 && !strings.Contains(text[i:], ">") {
			text = text[:i] // a tag the cut left open
		}
		text = html.UnescapeString(text)
	}
	// quoted replies ("> ...") say nothing new about the message
	var keep []string
	for _, ln := range strings.Split(text, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(ln), ">") {
			keep = append(keep, ln)
		}
	}
	text = strings.TrimSpace(reMailSpace.ReplaceAllString(strings.Join(keep, " "), " "))
	if utf8.RuneCountInString(text) > 160 {
		r := []rune(text)
		text = strings.TrimSpace(string(r[:160])) + "…"
	}
	return text
}

var (
	// whole elements that run, embed or submit things, with their content
	reMailDangerBlock = regexp.MustCompile(`(?is)<(script|iframe|object|embed|applet|frameset|frame|form|noscript|template|svg|math)\b.*?</(script|iframe|object|embed|applet|frameset|frame|form|noscript|template|svg|math)\s*>`)
	// the same elements left open, and the ones that are always void or head-only
	reMailDangerTag = regexp.MustCompile(`(?i)</?(script|iframe|object|embed|applet|frameset|frame|form|input|button|textarea|select|option|noscript|template|svg|math|base|meta|link)\b[^>]*>`)
	reMailOnAttr    = regexp.MustCompile(`(?i)([\s/"'])on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
	reMailAttr      = regexp.MustCompile(`(?i)([\s/"'][a-z][a-z0-9:_.-]*\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)`)
	reMailJSURL     = regexp.MustCompile(`(?i)(javascript|vbscript|livescript)\s*:`)
	reMailDataHTML  = regexp.MustCompile(`(?i)data\s*:\s*(text/html|application/xhtml|image/svg)`)
	reMailCSSExpr   = regexp.MustCompile(`(?i)expression\s*\(|-moz-binding|behavior\s*:`)
	reMailCID       = regexp.MustCompile(`(?i)(["'(\s=])cid:([^"')\s>]+)`)
	reMailCtl       = regexp.MustCompile(`[\x00-\x20]+`)
	// The cleaning pass's tags, read with their quotes - a ">" inside a
	// quoted value (title=">") does not end one, so what follows it is still
	// cleaned - and a <style> element whole, its CSS to its end (or to the end
	// of everything when left open: the browser reads the rest as CSS). A
	// "<style>" inside an attribute's quotes is no element: the tag around it
	// is matched first. reMailTagQOne: one such tag, at the start.
	reMailTagQ    = regexp.MustCompile(`(?is)<style\b(?:[^>"']|"[^"]*"|'[^']*')*>.*?(?:</style\s*>|$)|<(?:[^>"']|"[^"]*"|'[^']*')*>`)
	reMailTagQOne = regexp.MustCompile(`(?s)^<(?:[^>"']|"[^"]*"|'[^']*')*>`)
)

// cleanMailTag cleans the inside of one tag: its on* handlers (repeated:
// "oonnclick"), and any attribute whose value, entities decoded and blanks
// dropped as a browser does, is a script or an HTML data: URL.
func cleanMailTag(tag string) string {
	for {
		t := reMailOnAttr.ReplaceAllString(tag, "${1}data-x-on=${2}")
		if t == tag {
			break
		}
		tag = t
	}
	return reMailAttr.ReplaceAllStringFunc(tag, func(m string) string {
		sub := reMailAttr.FindStringSubmatch(m)
		v := strings.Trim(sub[2], `"'`)
		plain := reMailCtl.ReplaceAllString(html.UnescapeString(v), "")
		if reMailJSURL.MatchString(plain) || reMailDataHTML.MatchString(plain) {
			return sub[1] + `"blocked:"`
		}
		return m
	})
}

// sanitizeMailHTML is the second wall (see the top). cidURL maps a Content-ID
// to the URL of its part; one it does not know becomes "about:blank".
func sanitizeMailHTML(src string, cidURL func(cid string) string) string {
	s := src
	for i := 0; i < 50; i++ { // until a removal re-forms nothing
		t := reMailDangerBlock.ReplaceAllString(s, "")
		t = reMailDangerTag.ReplaceAllString(t, "")
		if t == s {
			break
		}
		s = t
	}
	// Inside tags and <style> CSS only - never in the words between them.
	// Text is text: run over the whole page, these rewrote the user's OWN
	// words in his drafts and in the HTML he sends ("Expected behavior: it
	// saves" became "Expected blocked( it saves"; "JavaScript: the good
	// parts" became "blocked: the good parts") - data-safety I2, mail-chat #4.
	neuter := func(m string) string {
		m = reMailJSURL.ReplaceAllString(m, "blocked:")
		m = reMailDataHTML.ReplaceAllString(m, "blocked:")
		m = reMailCSSExpr.ReplaceAllString(m, "blocked(")
		return reMailCID.ReplaceAllStringFunc(m, func(m string) string {
			sub := reMailCID.FindStringSubmatch(m)
			u := ""
			if cidURL != nil {
				u = cidURL(sub[2])
			}
			if u == "" {
				u = "about:blank"
			}
			return sub[1] + u
		})
	}
	inTag := func(tag string) string { return neuter(cleanMailTag(tag)) }
	s = reMailTagQ.ReplaceAllStringFunc(s, func(m string) string {
		if open := reMailTagQOne.FindString(m); len(open) < len(m) { // a <style> element: its tag, then its CSS
			return inTag(open) + neuter(m[len(open):])
		}
		return inTag(m)
	})
	// ...and once more as plain "<" to ">": a tag whose quote never closes
	// is no match above, but a browser still reads it as one. Done twice is
	// the same; words between tags are still never touched.
	return reMailTag.ReplaceAllStringFunc(s, inTag)
}
