package main

// =============================================================================
// GET /api/shares?notes=shared/<slug>/<folder> - the owner's photo notes, lent.
// =============================================================================
//
// A shared album shows the owner's pictures but not what the owner wrote about
// them: the notes live in the OWNER's data/photos/comments.json, which is not
// part of the grant (and must not be - it holds notes on every photo they
// have). The public /s/ link already hands them out one album at a time
// (publicPhotos); this does the same for a signed-in recipient.
//
//	-> {"notes": {"shared/<slug>/<folder>/<photo>": "text", ...}}
//
// Only the notes of files DIRECTLY in the asked folder, and only inside what
// the grant lends: the grant's own root, or - for a shared trip - its photo
// folder ("shared/<slug>/~/files/..."). Keys come back in the recipient's own
// path space, the ids Photos already uses. Read-only: nothing here writes.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// shareNotes answers GET /api/shares?notes=<folder> for `user`.
func (s *Server) shareNotes(w http.ResponseWriter, r *http.Request, user string) {
	asked := queryValue(r, "notes")
	parts := splitPath(asked)
	if len(parts) < 2 || parts[0] != "shared" || hasDotDot(parts) {
		sendError(w, r, http.StatusBadRequest, "carpeta no válida")
		return
	}
	g := s.shares.Find(user, parts[1])
	if g == nil {
		sendError(w, r, http.StatusNotFound, "no está compartido contigo")
		return
	}

	notes := map[string]string{}
	prefix := s.lentNotesPrefix(g, parts[2:])
	if prefix == "" {
		sendJSON(w, r, http.StatusOK, map[string]any{"notes": notes})
		return
	}
	viewer := strings.Join(parts, "/") + "/"
	dir := s.ownerFile(g.Owner, splitPath(prefix)) // the lent folder on disk
	if dir == "" {
		sendJSON(w, r, http.StatusOK, map[string]any{"notes": notes})
		return
	}

	all := readJSONMap(s.ownerFile(g.Owner, []string{"data", "photos", "comments.json"}))
	for key, raw := range all {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		name := key[len(prefix):]
		if name == "" || strings.Contains(name, "/") {
			continue // a sub-folder's note: that folder asks for its own
		}
		var text string
		if json.Unmarshal(raw, &text) != nil || text == "" {
			continue // a note that is not a string is simply not shown
		}
		// Only for a photo still in the folder: a note left behind by a move
		// the client did not rekey must not describe some other file.
		if info, err := os.Stat(filepath.Join(dir, name)); err != nil || info.IsDir() {
			continue
		}
		notes[viewer+name] = text
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"notes": notes})
}

// lentNotesPrefix is the owner's path of the asked folder plus "/", the prefix
// its notes' keys start with - or "" when the grant does not lend that folder
// (or no longer points anywhere).
func (s *Server) lentNotesPrefix(g *Grant, rest []string) string {
	if s.shares.RootPath(g) == "" {
		return ""
	}
	// A shared trip's photo folder: "~/<the owner's own path>".
	if len(rest) > 0 && rest[0] == ExtraSeg {
		if s.shares.ExtraPath(g, rest[1:]) == "" {
			return ""
		}
		return strings.Join(cleanSegments(rest[1:]), "/") + "/"
	}
	root := splitPath(g.Root)
	if len(root) == 0 || hasDotDot(root) {
		return ""
	}
	return strings.Join(append(root, rest...), "/") + "/"
}
