package main

// =============================================================================
// /api/office - the Microsoft Office twin of a LibreOffice document.
// =============================================================================
//
//	GET  /api/office                          {"available": true}
//	POST /api/office?file=files/x.odt         {"path": "files/x.docx", "converted": true}
//	POST /api/office?file=...&replace=1       convert even when x.docx is there
//
// Without replace an existing twin IS the answer ("converted": false) - that is
// Drive's double-click. Drive's upload sends replace=1: the file it just sent
// must not be answered with an older twin, and it asked about the clash before
// sending. The why and the how: office.go. Go only, like /api/convert.

import (
	"errors"
	"net/http"
	"path"
	"strings"
)

func (s *Server) apiOffice(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	role, user := sess.Role, sess.User

	switch r.Method {
	case http.MethodGet:
		sendJSON(w, r, http.StatusOK, map[string]any{"available": s.office.Available()})
		return
	case http.MethodPost:
	default:
		sendError(w, r, http.StatusMethodNotAllowed, "use GET or POST")
		return
	}

	q := cleanQuery(r)
	if !q.Has("file") {
		sendError(w, r, http.StatusBadRequest, "missing ?file=")
		return
	}
	virt := strings.Join(splitPath(unquotePath(q.Get("file"))), "/")
	twinName, ok := OfficeTwinName(path.Base(virt))
	if !ok {
		sendError(w, r, http.StatusBadRequest, "no es un documento de LibreOffice que se pueda convertir")
		return
	}

	src, ok := s.users.Resolve(role, user, virt)
	if !ok {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}
	if info, err := src.Stat(); err != nil || !info.Mode().IsRegular() {
		sendError(w, r, http.StatusNotFound, "no existe")
		return
	}
	twinVirt := path.Join(path.Dir(virt), twinName)
	dst, ok := s.users.Resolve(role, user, twinVirt)
	if !ok {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}

	// Already converted: the twin is the answer, unless this is an upload.
	var already int64 = -1
	if info, err := dst.Stat(); err == nil {
		if !info.Mode().IsRegular() {
			sendError(w, r, http.StatusConflict, "ya hay una carpeta con ese nombre")
			return
		}
		if !isTrue(q.Get("replace")) {
			sendJSON(w, r, http.StatusOK, map[string]any{"path": twinVirt, "converted": false})
			return
		}
		already = info.Size()
	}

	if !s.office.Available() {
		sendError(w, r, http.StatusServiceUnavailable, "LibreOffice no está instalado en el servidor")
		return
	}
	if !dst.Writable {
		sendError(w, r, http.StatusForbidden, "carpeta de sólo lectura")
		return
	}
	// A shared folder only ever gains files: never replace one there.
	if already >= 0 && IsSharedPath(twinVirt) {
		sendError(w, r, http.StatusConflict,
			"ya existe un archivo con ese nombre; en una carpeta compartida sólo puedes añadir")
		return
	}
	if s.isProtectedFile(role, dst.Abs) {
		sendError(w, r, http.StatusForbidden, "no se puede cambiar ese archivo")
		return
	}

	// The bytes land in whoever's home the folder is in - see filesWrite.
	payer := s.users.HomeOwner(dst.Abs)
	if payer == "" {
		payer = user
	}
	budget := int64(-1)
	if role != "admin" {
		if quota := s.users.UserQuotaBytes(payer); quota != nil {
			budget = *quota - s.users.UserUsageBytes(payer) + max(already, 0)
		}
	}

	size, err := s.office.Convert(r.Context(), path.Base(virt), src, dst, budget)
	switch {
	case r.Context().Err() != nil:
		return // the browser gave up; nobody to answer
	case errors.Is(err, errOfficeQuota):
		sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
		return
	case err != nil:
		s.log.Warn("office: could not convert", "path", src.Abs, "err", err)
		sendError(w, r, http.StatusUnprocessableEntity, "no se pudo convertir")
		return
	}

	if owner := s.users.HomeOwner(dst.Abs); owner != "" {
		s.users.AdjustUsage(owner, size-max(already, 0))
	}
	s.log.Info("office: converted", "user", user, "from", virt, "to", twinVirt, "bytes", size)
	sendJSON(w, r, http.StatusOK, map[string]any{"path": twinVirt, "converted": true})
}
