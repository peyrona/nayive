package main

// =============================================================================
// /api/shares - read-only sharing between Nayive users.
// =============================================================================
//
//	GET    -> {"mine": [...], "with_me": [...]}
//	POST   -> share one file or folder: {to, root, app, title, mode}
//	DELETE -> ?id=<share id>, owner only
//
// Regular users only. The admin has no home to share from and its paths are
// rooted at the base directory, where "files/x" would mean something else
// entirely - so it is kept out of this completely.
//
// Nothing here writes to anyone's files: a grant is a row in config/shares.json,
// and shares.go + ResolvePath do the rest.

import (
	"net/http"
	"strings"
)

// shareOut is one grant as the apps see it. `id` and `root` are the owner's
// business; the recipient gets the path they must actually use instead.
type shareOut struct {
	ID      string `json:"id"`
	App     string `json:"app"`
	Title   string `json:"title"`
	Mode    string `json:"mode"`
	Created int64  `json:"created"`
	Gone    bool   `json:"gone"`

	// Exactly one of these two halves is filled in.
	To   string `json:"to,omitempty"`
	Root string `json:"root,omitempty"`
	By   string `json:"by,omitempty"`
	Path string `json:"path,omitempty"`
}

func (s *Server) shareOut(g *Grant, mine bool) shareOut {
	mode := g.Mode
	if mode == "" {
		// Old grants written before modes existed have no field: read "ro".
		mode = "ro"
	}
	out := shareOut{
		ID: g.ID, App: g.App, Title: g.Title, Mode: mode,
		Created: g.Created, Gone: s.shares.RootPath(g) == "",
	}
	if mine {
		out.To, out.Root = g.To, g.Root
	} else {
		out.By, out.Path = g.Owner, "shared/"+g.Slug
	}
	return out
}

// shareRequest is the body of POST /api/shares.
type shareRequest struct {
	To    string `json:"to"`
	Root  string `json:"root"`
	App   string `json:"app"`
	Title string `json:"title"`
	Mode  string `json:"mode"`
}

func (s *Server) apiShares(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if sess.Role == "admin" {
		sendError(w, r, http.StatusForbidden, "el administrador no comparte archivos")
		return
	}
	user := sess.User

	switch r.Method {
	case http.MethodGet:
		mine := []shareOut{}
		for _, g := range s.shares.ByOwner(user) {
			grant := g
			mine = append(mine, s.shareOut(&grant, true))
		}
		withMe := []shareOut{}
		for _, g := range s.shares.ForUser(user) {
			grant := g
			withMe = append(withMe, s.shareOut(&grant, false))
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"mine": mine, "with_me": withMe})

	case http.MethodDelete:
		if !s.shares.Revoke(queryValue(r, "id"), user) {
			sendError(w, r, http.StatusNotFound,
				"no existe eso que quieres dejar de compartir")
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"message": "dejado de compartir"})

	case http.MethodPost:
		s.shareCreate(w, r, user, sess.Role)

	default:
		sendError(w, r, http.StatusMethodNotAllowed, "use GET, POST o DELETE")
	}
}

func (s *Server) shareCreate(w http.ResponseWriter, r *http.Request, user, role string) {
	var body shareRequest
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}

	to := NormaliseUsername(body.To)
	root := strings.Trim(strings.TrimSpace(body.Root), "/")
	app := strings.TrimSpace(body.App)
	if app == "" {
		app = "folder"
	}
	title := strings.TrimSpace(body.Title)
	mode := body.Mode
	if mode == "" {
		mode = "ro"
	}

	if to == "" || root == "" {
		sendError(w, r, http.StatusBadRequest, "hacen falta la persona y el archivo")
		return
	}
	if to == user {
		sendError(w, r, http.StatusBadRequest, "no puedes compartir contigo mismo")
		return
	}
	// ListUserNames, NOT ListUsers: the latter measures every home on disk
	// (tens of GB of photos) just to build the same list of names.
	if !contains(s.users.ListUserNames(), to) {
		sendError(w, r, http.StatusBadRequest, "no existe esa persona")
		return
	}

	// THE check that keeps this honest: the path must be one of MY OWN writable
	// paths. That rules out apps/ (read-only), anything under shared/ (also
	// read-only - you cannot pass on what was lent to you), and every path
	// outside my home, all through the one function that already guards the
	// file API.
	//
	// An "add" grant makes a shared folder writable, so `writable` alone no
	// longer means "mine" - ask IsSharedPath explicitly.
	target, writable := s.users.ResolvePath(role, user, root)
	if target == "" || !writable || IsSharedPath(root) {
		sendError(w, r, http.StatusForbidden, "no puedes compartir eso")
		return
	}
	if !pathExists(target) {
		sendError(w, r, http.StatusNotFound, "no existe ese archivo")
		return
	}
	if s.isStructuralDir(role, user, target) {
		sendError(w, r, http.StatusBadRequest,
			"no puedes compartir una carpeta principal entera")
		return
	}

	if title == "" {
		title = lastSegment(root)
	}
	grant := s.shares.Create(user, to, root, app, title, mode)
	if grant == nil {
		sendError(w, r, http.StatusConflict, "ya lo has compartido con esa persona")
		return
	}
	sendJSON(w, r, http.StatusCreated, s.shareOut(grant, true))
}
