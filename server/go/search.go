package main

// =============================================================================
// search.go - Drive's advanced search (GET /api/files?search=1&...).
// =============================================================================
//
// The plain search box sends a shell glob (?find=). The "Búsqueda avanzada"
// dialog sends its parts instead, every one of them optional:
//
//	name=<op>:<text>   repeated; op is has | not | starts | ends | is, tested on
//	                   the lowercased basename, extension included
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
)

// SearchSpec is one parsed ?search= request.
type SearchSpec struct {
	rules        []nameRule
	any          bool
	kinds        bool            // a kind filter is on: only `dirs` and `exts` pass
	dirs         bool            // folders=1
	exts         map[string]bool // lowercased, no dot
	since, until int64           // Unix seconds, 0 = no bound
}

type nameRule struct{ op, text string }

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
		if text = strings.ToLower(strings.TrimSpace(text)); ok && text != "" {
			sp.rules = append(sp.rules, nameRule{op, text})
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
		low := strings.ToLower(name)
		hits := 0
		for _, r := range sp.rules {
			if r.match(low) {
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

// match tests one rule against a lowercased basename.
func (r nameRule) match(low string) bool {
	switch r.op {
	case "has":
		return strings.Contains(low, r.text)
	case "not":
		return !strings.Contains(low, r.text)
	case "starts":
		return strings.HasPrefix(low, r.text)
	case "ends":
		return strings.HasSuffix(low, r.text)
	}
	return low == r.text // "is"
}
