package main

// =============================================================================
// Chat text marks (WhatsApp's): *bold*, _italic_, ~strike~ and "- " list
// lines. Messages keep them as typed; the page draws them
// (client/apps/chat/marks.js). Here they are only taken out, for the
// one-line places the server writes: notifications and quotes.
// The rules are marks.js's, line for line - change both together.
// =============================================================================

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	marksURLRe  = regexp.MustCompile(`(?i)\bhttps?://[^\s<>"]+[^\s<>".,;:!?)\]'"]`)
	marksItemRe = regexp.MustCompile(`^[ \t]*- `)
)

const marksTail = `*_~.,;:!?)]'"`

// marksMax: only a text's first runes are stripped (SS1). The scan is slow on
// a long text packed with marks and links, it runs for every quote under the
// hub's lock, and every place that strips clips the line far shorter anyway.
// marks.js's MAX is the same.
const marksMax = 600

type marksSpan struct{ a, b int } // [a, b) in runes

func isMarkChar(r rune) bool { return r == '*' || r == '_' || r == '~' }

// marksRune is s[i], or 0 outside it.
func marksRune(s []rune, i int) rune {
	if i < 0 || i >= len(s) {
		return 0
	}
	return s[i]
}

func marksWord(r rune) bool  { return r != 0 && (unicode.IsLetter(r) || unicode.IsNumber(r)) }
func marksSpace(r rune) bool { return r != 0 && unicode.IsSpace(r) }

// marksLinks: the links of a line. A link never ends in a mark.
func marksLinks(line string) []marksSpan {
	var out []marksSpan
	for _, m := range marksURLRe.FindAllStringIndex(line, -1) {
		a := utf8.RuneCountInString(line[:m[0]])
		r := []rune(line[m[0]:m[1]])
		n := len(r)
		for n > 0 && strings.ContainsRune(marksTail, r[n-1]) {
			n--
		}
		if n > 8 {
			out = append(out, marksSpan{a, a + n})
		}
	}
	return out
}

func marksLinkAt(L []marksSpan, i int) *marksSpan {
	for n := range L {
		if L[n].a <= i && i < L[n].b {
			return &L[n]
		}
	}
	return nil
}

// marksCloser: where the mark at s[i] closes (before b), or -1.
func marksCloser(s []rune, i, b int, L []marksSpan) int {
	c, next := s[i], marksRune(s, i+1)
	if marksWord(marksRune(s, i-1)) || i+1 >= b || marksSpace(next) || next == c {
		return -1
	}
	for j := i + 2; j < b; j++ {
		if k := marksLinkAt(L, j); k != nil {
			j = k.b - 1
			continue
		}
		if s[j] != c {
			continue
		}
		before := s[j-1]
		if !marksSpace(before) && before != c && !marksWord(marksRune(s, j+1)) {
			return j
		}
	}
	return -1
}

// marksInline writes s[a, b) without its marks.
func marksInline(w *strings.Builder, s []rune, a, b int, L []marksSpan) {
	start, i := a, a
	for i < b {
		if k := marksLinkAt(L, i); k != nil {
			i = k.b
			continue
		}
		j := -1
		if isMarkChar(s[i]) {
			j = marksCloser(s, i, b, L)
		}
		if j < 0 {
			i++
			continue
		}
		w.WriteString(string(s[start:i]))
		marksInline(w, s, i+1, j, L)
		i, start = j+1, j+1
	}
	if b > start {
		w.WriteString(string(s[start:b]))
	}
}

// stripMarks: the words without their marks ("*hi*" -> "hi"), list lines
// as "• item". Only the first marksMax runes.
func stripMarks(text string) string {
	if len(text) > marksMax {
		if r := []rune(text); len(r) > marksMax {
			text = string(r[:marksMax])
		}
	}
	lines := strings.Split(text, "\n")
	var w strings.Builder
	for n, line := range lines {
		if n > 0 {
			w.WriteByte('\n')
		}
		s := []rune(line)
		from := 0
		if m := marksItemRe.FindString(line); m != "" {
			w.WriteString("• ")
			from = utf8.RuneCountInString(m)
		}
		marksInline(&w, s, from, len(s), marksLinks(line))
	}
	return w.String()
}
