package main

// =============================================================================
// search.go - Drive's advanced search (GET /api/files?search=1&...).
// =============================================================================
//
// The plain search box sends a shell glob (?find=). The "Búsqueda avanzada"
// dialog sends its parts instead, every one of them optional:
//
//	name=<op>:<text>   repeated; op is has | not | starts | ends | is, tested on
//	                   the folded basename (fold: no accents, lower case),
//	                   extension included
//	any=1              one name rule is enough (default: every rule must hold)
//	folders=1          folders are wanted (not "dir": that is the listing route)
//	ext=<e>            repeated; files with these extensions are wanted. With
//	                   neither folders nor ext, every kind is.
//	since=<unix s>     modified at or after
//	until=<unix s>     modified before
//
// The extension lists behind "Documentos", "Imágenes"... stay in the client
// (drive/listing.js), which already owns them for the icons and the openers.
// The days behind "Hoy" or "Últimos 7 días" are the client's too: they are the
// user's own midnight, not the server's.

import (
	"errors"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// fold is a name or a searched text made accent- and case-blind: "jose"
// finds "José", "nino" finds "Niño", "strasse" finds "Straße", "oeuvre" finds
// "œuvre", a typed ' finds the typographic ’. It folds exactly like the
// client's NayiveUI.fold (shared/ui.js: marks U+0300-U+036F, then foldMore),
// so both sides agree.
func fold(s string) string {
	var b strings.Builder
	for _, c := range norm.NFD.String(s) {
		if c < 0x300 || c > 0x36f {
			b.WriteRune(c)
		}
	}
	return foldMore.Replace(strings.ToLower(b.String()))
}

var foldMore = strings.NewReplacer("ß", "ss", "œ", "oe", "æ", "ae", "\u2018", "'", "\u2019", "'")

// foldForms is fold(s), plus - when s has an umlaut - s with its umlauts
// spelt the German way, folded: "Müller" -> "muller", "mueller". A search
// tries every form of the name against every form of what was typed, so
// "Mueller" finds "Müller" and back. Only umlauts are spelt out: folding
// every "ue" would make "fue" find "fumar". As the client's foldUmlauts.
func foldForms(s string) []string {
	forms := []string{fold(s)}
	if n := norm.NFC.String(s); strings.ContainsAny(n, "äöüÄÖÜ") {
		forms = append(forms, fold(umlauts.Replace(n)))
	}
	return forms
}

var umlauts = strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "Ä", "Ae", "Ö", "Oe", "Ü", "Ue")

// anyForm is true when test holds for some form of the name and some form of
// the text (foldForms).
func anyForm(names, texts []string, test func(name, text string) bool) bool {
	for _, n := range names {
		for _, t := range texts {
			if test(n, t) {
				return true
			}
		}
	}
	return false
}

// SearchSpec is one parsed ?search= request.
type SearchSpec struct {
	rules        []nameRule
	any          bool
	kinds        bool            // a kind filter is on: only `dirs` and `exts` pass
	dirs         bool            // folders=1
	exts         map[string]bool // lowercased, no dot
	since, until int64           // Unix seconds, 0 = no bound
}

// nameRule is one name=<op>:<text>; texts are the text's foldForms.
type nameRule struct {
	op    string
	texts []string
}

// parseSearchSpec reads the query. A rule with an empty text is dropped; a
// request that is left with nothing to filter on is an error, not the whole
// drive.
func parseSearchSpec(q Query) (SearchSpec, error) {
	sp := SearchSpec{any: q.Get("any") == "1", dirs: q.Get("folders") == "1", exts: map[string]bool{}}

	for _, v := range q["name"] {
		// Cut at the FIRST ":" - the text itself may hold one.
		op, text, ok := strings.Cut(v, ":")
		switch op {
		case "has", "not", "starts", "ends", "is":
		default:
			return sp, errors.New("bad name rule")
		}
		if text = strings.TrimSpace(text); ok && fold(text) != "" {
			sp.rules = append(sp.rules, nameRule{op, foldForms(text)})
		}
	}

	for _, e := range q["ext"] {
		if e = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(e), ".")); e != "" {
			sp.exts[e] = true
		}
	}
	sp.kinds = sp.dirs || len(sp.exts) > 0

	for _, b := range []struct {
		key string
		dst *int64
	}{{"since", &sp.since}, {"until", &sp.until}} {
		if v := q.Get(b.key); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n < 0 {
				return sp, errors.New("bad " + b.key)
			}
			*b.dst = n
		}
	}

	if len(sp.rules) == 0 && !sp.kinds && sp.since == 0 && sp.until == 0 {
		return sp, errors.New("empty search")
	}
	return sp, nil
}

// keep is the SearchBy predicate.
func (sp SearchSpec) keep(name string, d fs.DirEntry) bool {
	if len(sp.rules) > 0 {
		names := foldForms(name)
		hits := 0
		for _, r := range sp.rules {
			if r.match(names) {
				hits++
			}
		}
		if (sp.any && hits == 0) || (!sp.any && hits < len(sp.rules)) {
			return false
		}
	}

	if sp.kinds {
		if d.IsDir() {
			if !sp.dirs {
				return false
			}
		} else if !sp.exts[strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))] {
			return false
		}
	}

	// Folders too: a folder's date is when something in it last came or went.
	if sp.since > 0 || sp.until > 0 {
		info, err := d.Info()
		if err != nil {
			return false
		}
		t := info.ModTime().Unix()
		if (sp.since > 0 && t < sp.since) || (sp.until > 0 && t >= sp.until) {
			return false
		}
	}
	return true
}

// match tests one rule against a basename's foldForms. "not" holds only
// when no form has the text.
func (r nameRule) match(names []string) bool {
	if r.op == "not" {
		return !anyForm(names, r.texts, strings.Contains)
	}
	return anyForm(names, r.texts, func(n, t string) bool {
		switch r.op {
		case "has":
			return strings.Contains(n, t)
		case "starts":
			return strings.HasPrefix(n, t)
		case "ends":
			return strings.HasSuffix(n, t)
		}
		return n == t // "is"
	})
}
