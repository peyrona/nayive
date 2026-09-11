package main

// =============================================================================
// PUT ?file=<path> - streaming an upload to disk.
// =============================================================================
//
// The body is streamed to a temp file next to the target, then moved into
// place: the whole upload is never held in memory, and a reader never sees a
// half-written file.
//
// Content-Encoding: gzip on the REQUEST is unpacked here, chunk by chunk, so a
// compressed upload is never held whole in RAM either. The apps' shared store.js
// gzips every text body it PUTs (a 24 KB calendar.ics goes up as ~4 KB);
// anything without the header is written through untouched, so an older client
// keeps working.

import (
	"compress/gzip"
	"crypto/rand"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// maxGzipOut caps what ONE gzipped PUT may expand to. Content-Length sizes the
// COMPRESSED body, so without this a few KB on the wire could ask us to write
// gigabytes (a "zip bomb"). A quota'd user is capped by their own free space,
// which is tighter; this is the backstop for an admin, who has no quota.
const maxGzipOut = 64 << 20 // 64 MiB

// errTooBig is the sentinel a capped writer returns past its ceiling.
//
// java: a package-level error value compared with errors.Is is the Go way to
// signal one specific condition through an io.Writer that can only return
// `error`. Java would throw a custom exception; here the value IS the type.
var errTooBig = errors.New("upload expands past the allowed size")

func (s *Server) filesWrite(w http.ResponseWriter, r *http.Request,
	role, user, fileRel string, target Resolved) {

	if !target.Writable {
		sendError(w, r, http.StatusForbidden, "read-only")
		return
	}
	if s.isProtectedFile(role, target.Abs) {
		sendError(w, r, http.StatusForbidden, "no se puede cambiar ese archivo")
		return
	}

	// ADD, NEVER REPLACE. An "add" grant is writable so someone can drop their
	// own photos into a shared album; letting a PUT land on a name that already
	// exists would quietly destroy the owner's file, with no trip through the
	// papelera. Their own second upload of the same name gets the same 409 the
	// client already knows how to explain.
	if IsSharedPath(fileRel) && target.Exists() {
		sendError(w, r, http.StatusConflict,
			"ya existe un archivo con ese nombre; en una carpeta compartida sólo puedes añadir")
		return
	}

	var already int64
	if info, err := target.Stat(); err == nil && info.Mode().IsRegular() {
		already = info.Size()
	}

	// The bytes land in whoever's home the FILE is in, not the writer's - on a
	// shared folder those differ. The quota check has to agree with the usage
	// bookkeeping below, or a guest would spend their own quota while filling
	// somebody else's disk.
	payer := s.users.HomeOwner(target.Abs)
	if payer == "" {
		payer = user
	}
	var quota *int64
	if role != "admin" {
		quota = s.users.UserQuotaBytes(payer)
	}

	budget := int64(-1) // -1 = no quota
	if quota != nil {
		// The most this file may grow to and still fit. On a gzipped PUT
		// Content-Length is the COMPRESSED size, so this pre-check can only
		// catch the obvious cases - the ceiling below enforces the real,
		// decompressed byte count as it inflates.
		budget = *quota - (s.users.UserUsageBytes(payer) - already)
		if r.ContentLength > budget {
			sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
			return
		}
	}

	written, err := s.streamToFile(w, r, target, budget)
	if err != nil {
		return // streamToFile already answered
	}

	// Keep the cached usage figure current without a re-walk.
	if owner := s.users.HomeOwner(target.Abs); owner != "" {
		if info, err := target.Stat(); err == nil {
			s.users.AdjustUsage(owner, info.Size()-already)
		} else {
			s.users.ForgetUsage(owner)
		}
	}
	s.log.Info("wrote file", "path", target.Abs, "bytes", written)

	// Drive's "Subir y convertir": hand the video to convert.go's queue. Only a
	// user's own file - never in a shared folder (the job ends by moving the
	// original to the papelera, and nothing is ever taken out of a shared
	// folder) and never the admin's (no devices to tell).
	answer := map[string]string{"message": "saved"}
	if queryValue(r, "convert") == "mp4" && role == "user" && !IsSharedPath(fileRel) &&
		IsConvertible(target.Abs) &&
		s.convert.Enqueue(user, strings.Join(splitPath(unquotePath(fileRel)), "/")) {
		answer["convert"] = "queued"
	}
	sendJSON(w, r, http.StatusOK, answer)
}

// streamToFile is the write itself. It answers the request on every failure and
// returns the byte count on success.
func (s *Server) streamToFile(w http.ResponseWriter, r *http.Request,
	target Resolved, budget int64) (int64, error) {

	// NO Content-Length at all -> refuse, do not treat it as "zero bytes".
	//
	// By the letter of HTTP a missing length with no Transfer-Encoding does mean
	// an empty body, but taking it literally silently REPLACED the target with a
	// 0-byte file and answered "200 saved". The realistic way in is an app
	// calling writeFileBytes(path, undefined) after a failed read: fetch then
	// sends no body and no length, and tasks.json / calendar.ics / contacts.vcf
	// are whole-document single files, so that one request wipes the app. A loud
	// 411 makes the client bug obvious.
	//
	// java: r.ContentLength is -1 for both "absent" and "chunked". Go de-chunks
	// a chunked body correctly - the request-smuggling hazard the Python guards
	// against does not exist here - but a chunked PUT still cannot be sized, so
	// the same 411 is the right answer and the two servers agree.
	if r.ContentLength < 0 {
		w.Header().Set("Connection", "close")
		sendError(w, r, http.StatusLengthRequired, "falta Content-Length")
		return 0, errors.New("no content length")
	}

	// Every step from here - the folder, the temp file, the final rename - goes
	// through the sandbox (see sandbox.go). The handle stays open for the whole
	// upload: one descriptor, however long the body takes to arrive.
	root, err := target.openCreating()
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear la carpeta")
		return 0, err
	}
	defer root.Close()
	dir := filepath.Dir(target.Rel)
	if err := root.MkdirAll(dir, 0o755); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear la carpeta")
		return 0, err
	}

	gzipped := strings.Contains(strings.ToLower(r.Header.Get("Content-Encoding")), "gzip")

	// The ceiling only applies to a gzipped body: a plain one is already sized
	// by Content-Length, which was checked against the quota above.
	ceiling := int64(-1)
	if gzipped {
		ceiling = maxGzipOut
		if budget >= 0 && budget < ceiling {
			ceiling = budget
		}
	}

	tmp, tmpName, err := createUploadTemp(root, dir)
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return 0, err
	}
	// java: this defer runs on EVERY path out of the function, including the
	// happy one - where the file has already been renamed away, so Remove is a
	// harmless no-op. That is cheaper to reason about than removing it by hand
	// on each of the five failure branches.
	defer func() {
		tmp.Close()
		root.Remove(tmpName)
	}()

	var src io.Reader = r.Body
	var zr *gzip.Reader
	if gzipped {
		zr, err = gzip.NewReader(r.Body)
		if err != nil {
			w.Header().Set("Connection", "close")
			sendError(w, r, http.StatusBadRequest, "cuerpo gzip corrupto")
			return 0, err
		}
		src = zr
	}

	written, err := io.Copy(&cappedWriter{w: tmp, ceiling: ceiling}, src)

	switch {
	case errors.Is(err, errTooBig):
		// A gzipped body that expands past what the writer may store. Nothing is
		// moved into place, so the existing file survives untouched.
		w.Header().Set("Connection", "close") // we stopped reading mid-body
		s.log.Warn("gzipped upload expands past the ceiling", "path", target.Abs, "ceiling", ceiling)
		sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
		return 0, err

	case gzipped && err != nil:
		// A GZIP STREAM CUT SHORT IS STILL A VALID PREFIX. The inflater happily
		// returns the bytes it did get; without checking the error a half-sent
		// upload was written out as a half-file and answered "saved" - the very
		// corruption the Content-Length guard exists to prevent. (That guard
		// cannot catch this one: the HTTP body arrived complete, it is the gzip
		// stream inside it that is unfinished.)
		w.Header().Set("Connection", "close")
		s.log.Warn("upload aborted: truncated gzip stream", "path", target.Abs, "err", err)
		sendError(w, r, http.StatusBadRequest, "cuerpo gzip corrupto")
		return 0, err

	case err != nil:
		// The client promised Content-Length bytes and sent fewer - a dropped
		// connection mid-upload. Do NOT move a truncated file over the real one
		// (that silently corrupts e.g. data/tasks.json). Bin the temp and report
		// failure; the existing file is untouched.
		w.Header().Set("Connection", "close")
		s.log.Warn("upload aborted", "path", target.Abs, "got", written,
			"want", r.ContentLength, "err", err)
		sendError(w, r, http.StatusBadRequest, "subida incompleta (conexión interrumpida)")
		return 0, err
	}

	if !gzipped && written != r.ContentLength {
		w.Header().Set("Connection", "close")
		s.log.Warn("upload aborted", "path", target.Abs, "got", written, "want", r.ContentLength)
		sendError(w, r, http.StatusBadRequest, "subida incompleta (conexión interrumpida)")
		return 0, errors.New("short body")
	}

	if err := tmp.Chmod(0o644); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return 0, err
	}
	if err := tmp.Close(); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return 0, err
	}
	// Atomic: readers never see a partial file.
	if err := root.Rename(tmpName, target.Rel); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
		return 0, err
	}
	return written, nil
}

// cappedWriter refuses to write past `ceiling`, so a zip bomb costs us the
// ceiling and an error rather than the disk.
type cappedWriter struct {
	w       io.Writer
	ceiling int64
	written int64
}

func (c *cappedWriter) Write(p []byte) (int, error) {
	if c.ceiling >= 0 && c.written+int64(len(p)) > c.ceiling {
		return 0, errTooBig
	}
	n, err := c.w.Write(p)
	c.written += int64(n)
	return n, err
}

// uploadChars is the alphabet the Python's tempfile uses, and filetree's
// uploadNameRE matches exactly eight of them.
const uploadChars = "abcdefghijklmnopqrstuvwxyz0123456789_"

// createUploadTemp makes ".upload-" + 8 random characters.
//
// java: os.CreateTemp would be the obvious call, but it appends a longer random
// number, and the temp-name regex in filetree.go - which decides what the
// startup sweep may delete and what stays hidden from Drive - matches EXACTLY
// eight of this alphabet. Keeping the shape identical means either server can
// clean up after the other.
//
// It is made THROUGH the root, and its path comes back relative to that root -
// the name the final rename and the cleanup both need.
func createUploadTemp(root *os.Root, dir string) (*os.File, string, error) {
	return createTempNamed(root, dir, ".upload-")
}

// createTempNamed is createUploadTemp with any prefix: convert.go's
// ".convert-" temps have the same shape, for the same reasons.
func createTempNamed(root *os.Root, dir, prefix string) (*os.File, string, error) {
	raw := make([]byte, 8)
	for attempt := 0; attempt < 100; attempt++ {
		rand.Read(raw)
		name := make([]byte, 8)
		for i, b := range raw {
			name[i] = uploadChars[int(b)%len(uploadChars)]
		}
		path := filepath.Join(dir, prefix+string(name))
		f, err := root.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			return f, path, nil
		}
		if !os.IsExist(err) {
			return nil, "", err
		}
	}
	return nil, "", errors.New("could not create a temp file")
}
