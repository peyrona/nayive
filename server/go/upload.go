// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

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
	"hash/fnv"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// maxGzipOut caps what ONE gzipped PUT may expand to. Content-Length sizes the
// COMPRESSED body, so without this a few KB on the wire could ask us to write
// gigabytes (a "zip bomb"). A quota'd user is capped by their own free space,
// which is tighter; this is the backstop for an admin, who has no quota.
const maxGzipOut = 64 << 20 // 64 MiB

// emptyRefused are the kinds a 0-byte body may never replace when the file has
// content (see streamToFile). None of them is ever legitimately empty: docx and
// xlsx are zips, and the apps never write an empty .ics, .json or .vcf -
// Contacts' empty list is still "\r\n".
var emptyRefused = map[string]bool{
	".docx": true, ".xlsx": true, ".ics": true, ".json": true, ".vcf": true,
}

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
	// A home the admin renamed or deleted under this request: "try again"
	// (503, sendMissing). The checks below would see no file there and
	// answer an If-Match save 412 - a conflict the page offers to keep as a
	// copy - for a file nobody changed.
	if _, err := target.Lstat(); errors.Is(err, errRootGone) {
		sendMissing(w, r, err, "")
		return
	}

	// ADD, NEVER REPLACE. An "add" grant is writable so someone can drop their
	// own photos into a shared album; letting a PUT land on a name that already
	// exists would quietly destroy the owner's file, with no trip through the
	// papelera. Their own second upload of the same name gets the same 409 the
	// client already knows how to explain. Checked here, so a long body is not
	// sent for nothing, AND again at the end (streamToFile, `clash`): the owner
	// may put a file of that name there while the guest's video streams (D9).
	clash := 0 // 0: this PUT may replace a file; else the answer when the name is taken
	if IsSharedPath(fileRel) {
		clash = http.StatusConflict
	} else if createOnly(r) {
		clash = http.StatusPreconditionFailed
	}
	if clash != 0 && target.Exists() {
		sendError(w, r, clash, clashText(clash))
		return
	}

	// CHANGED SINCE YOU OPENED IT. A page that saves from a version it read
	// sends If-Match = the ETag that version came with (etag.go); a file
	// changed since - by another device, a restore, a move, a server write -
	// answers 412 and is NOT overwritten: the page merges, or offers "save
	// yours as a copy". See staleBase.
	if staleBase(r, target.Stat) {
		sendError(w, r, http.StatusPreconditionFailed, "el archivo ha cambiado desde que lo abriste")
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
	budget := int64(-1) // -1 = no quota
	if left, limited := s.quotaLeft(role, user, target.Abs); limited {
		// The most this file may grow to and still fit. On a gzipped PUT
		// Content-Length is the COMPRESSED size, so this pre-check can only
		// catch the obvious cases - the ceiling below enforces the real,
		// decompressed byte count as it inflates.
		budget = left + already
		if r.ContentLength > budget {
			sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
			return
		}
	}

	written, err := s.streamToFile(w, r, target, budget, clash)
	if err != nil {
		return // streamToFile already answered
	}

	// Keep the cached usage figure current without a re-walk. (The new file's
	// ETag and Last-Modified are already on the answer: streamToFile took them
	// under the path's lock.)
	info, statErr := target.Stat()
	if owner := s.users.HomeOwner(target.Abs); owner != "" {
		if statErr == nil {
			s.users.AdjustUsage(owner, info.Size()-already)
		} else {
			s.users.ForgetUsage(owner)
		}
	}
	s.log.Info("wrote file", "path", target.Abs, "bytes", written)

	// Drive's "Subir y convertir": hand the video to convert.go's queue. Only a
	// user's own file - never in a shared folder (the job ends by moving the
	// original to the papelera, and nothing is ever taken out of a shared
	// folder) and never the admin's (no devices to tell). With the path's
	// epoch: an account renamed while the body streamed queues nothing under
	// its old name (EnqueueAt).
	answer := map[string]string{"message": "saved"}
	if queryValue(r, "convert") == "mp4" && role == "user" && !IsSharedPath(fileRel) &&
		IsConvertible(target.Abs) &&
		s.convert.EnqueueAt(user, strings.Join(splitPath(fileRel), "/"), target.epoch) {
		answer["convert"] = "queued"
	}
	sendJSON(w, r, http.StatusOK, answer)

	// A photo that knows where it was taken can place its owner on a trip with a
	// public link (photo_position.go). After the answer, on its own goroutine:
	// best effort, never in the way of the upload.
	if role == "user" && !IsSharedPath(fileRel) && isJPEGName(target.Abs) {
		go s.photoUploaded(user, strings.Join(splitPath(fileRel), "/"), target)
	}
}

// createOnly: the PUT says "If-None-Match: *" - make the file only if the name
// is free (RFC 9110 13.1.2). An upload the user never confirmed as "Replace"
// sends it, so a file another device put there since the client last looked
// is never written over (data-safety D1-D7, drive-files G1). "*" is the only
// If-None-Match a PUT is judged by: no app sends a tag list there.
func createOnly(r *http.Request) bool {
	return strings.TrimSpace(r.Header.Get("If-None-Match")) == "*"
}

// staleBase reports a PUT made from a version that is no longer the file at
// the path. If-Match decides when the page sent one (etag.go): the tag sees
// every change, a restore or a move of an older file included (B1-B3).
// Otherwise If-Unmodified-Since, exactly as before, for a page loaded before
// the tag: HTTP dates are whole seconds, so the file's time is cut to the
// second too; no header (every other client) or an unreadable one = no check.
//
// `stat` is how the file at the path is looked at: before the body, by the
// path (Resolved.Stat); under the path's lock, through the folder the write
// itself goes into (streamToFile).
func staleBase(r *http.Request, stat func() (os.FileInfo, error)) bool {
	if header, sent := ifMatchHeader(r); sent {
		var now os.FileInfo // nil: no file there
		if info, err := stat(); err == nil {
			now = info
		}
		return !ifMatchPasses(header, now)
	}
	if since, err := http.ParseTime(r.Header.Get("If-Unmodified-Since")); err == nil {
		if info, err := stat(); err == nil && info.ModTime().Truncate(time.Second).After(since) {
			return true
		}
	}
	return false
}

// clashText is the answer to a PUT whose name is taken (see filesWrite).
func clashText(code int) string {
	if code == http.StatusConflict {
		return "ya existe un archivo con ese nombre; en una carpeta compartida sólo puedes añadir"
	}
	return "ya existe un archivo con ese nombre"
}

// quotaLeft is what a write by `user` at `abs` may still add to the quota it
// spends (Users.Payer): limited false for an admin or a payer with no quota.
func (s *Server) quotaLeft(role, user, abs string) (left int64, limited bool) {
	if role == "admin" {
		return 0, false
	}
	return s.users.QuotaLeft(s.users.Payer(abs, user))
}

// streamToFile is the write itself. It answers the request on every failure and
// returns the byte count on success. `clash` 0 lets the file replace one of
// its name; any other value is the status answered when the name is taken -
// checked again under the path's lock, and the file then takes its name
// without ever replacing (renameNoReplace).
func (s *Server) streamToFile(w http.ResponseWriter, r *http.Request,
	target Resolved, budget int64, clash int) (int64, error) {

	// A body that cannot be sized -> 411.
	//
	// java: r.ContentLength is -1 only for a CHUNKED body. A request with NO
	// Content-Length at all arrives here as 0, exactly like "Content-Length: 0"
	// - by the letter of HTTP both mean an empty body - so this check does not
	// see them. The 0-byte guard after the
	// copy below is what keeps an empty body off a document.
	if r.ContentLength < 0 {
		w.Header().Set("Connection", "close")
		sendError(w, r, http.StatusLengthRequired, "falta Content-Length")
		return 0, errors.New("no content length")
	}

	// Every step from here - the folder, the temp file, the final rename - goes
	// through the sandbox (see sandbox.go). The handle stays open for the whole
	// upload: one descriptor, however long the body takes to arrive.
	//
	// THE OPEN FOLDER. Every look at the file from here on - the empty-body
	// guard, the version check, the clash, the old time - goes through this
	// same `root`, never through `target` (which opens the folder again by its
	// name). An admin rename while the body streams moves the home: the write
	// follows the handle into the renamed home, while a look by name finds
	// nothing there and passes - an If-Unmodified-Since save, or an empty
	// body, then replaced a newer file or a whole document (L2).
	root, err := target.openCreating()
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear la carpeta")
		return 0, err
	}
	defer root.Close()
	dir := filepath.Dir(target.Rel)
	// An "add" share (the 409 clash, filesWrite) lends its folders to drop
	// files in, never to make new ones - mkdir refuses them too (B5-17).
	if clash == http.StatusConflict {
		if info, err := root.Stat(dir); err != nil || !info.IsDir() {
			sendError(w, r, http.StatusForbidden, "forbidden")
			return 0, errors.New("no new folders in a shared folder")
		}
	} else if err := root.MkdirAll(dir, 0o755); err != nil {
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

	// ZERO BYTES NEVER REPLACE A DOCUMENT. The realistic way in is an app that
	// lost what it read - writeFileBytes(path, undefined): fetch then sends no
	// body and no length - and tasks.json / calendar.ics / contacts.vcf are
	// whole-document single files, so that one request wipes the app. Counted
	// AFTER the copy, so a gzipped body is judged by what it inflated to (an
	// empty gzip stream is ~20 bytes on the wire). 409, not 400: store.js drops
	// a 409 for good instead of re-sending it forever. Plain text may still be
	// emptied on purpose, and a new or already-empty document may start empty.
	if written == 0 && emptyRefused[strings.ToLower(filepath.Ext(target.Rel))] {
		// Through `root`, like every look from here on: see "THE OPEN FOLDER".
		if info, err := root.Stat(target.Rel); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
			s.log.Warn("0-byte PUT over a document refused", "path", target.Abs, "size", info.Size())
			sendError(w, r, http.StatusConflict, "cuerpo vacío: el documento no se cambia")
			return 0, errors.New("empty body over a document")
		}
	}

	if err := tmp.Chmod(0o644); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return 0, err
	}
	// On disk before it takes the real name: a power cut must never leave an
	// empty file where the old one was (S2-#23).
	if err := tmp.Sync(); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return 0, err
	}
	// This save's own file, to know it again at its new name (below).
	mine, err := tmp.Stat()
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return 0, err
	}
	if err := tmp.Close(); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo escribir")
		return 0, err
	}

	// CHANGED WHILE THE BODY STREAMED? filesWrite checked If-Match (or
	// If-Unmodified-Since) before the body, so a second save sent at the same
	// moment passed it too. The same check again, and the rename, under this
	// path's lock: of two saves from the same base, the later one now gets 412
	// instead of silently winning (S2-#8).
	//
	// The stripe is the path's as it was APPROVED. Should the admin rename the
	// account while the body streams, this write follows the open folder into
	// the renamed home, while a save of the same file sent from the new name
	// takes the new path's stripe: two If-Match saves from one version, one
	// on each side of the rename, could then both pass. Known and left: it
	// needs a save from the old name still streaming when the renamed person,
	// signed in again, saves the same file. Keying the stripe by the file
	// instead would have to change every lockPath caller (the bin, a move,
	// the Office twin...) at once, or this one would stop excluding them.
	unlock := lockPath(target.Abs)
	defer unlock()
	if staleBase(r, func() (os.FileInfo, error) { return root.Stat(target.Rel) }) {
		sendError(w, r, http.StatusPreconditionFailed, "el archivo ha cambiado desde que lo abriste")
		return 0, errors.New("changed while the body streamed")
	}
	// The time the file had, for the whole-second rule below.
	var prev time.Time
	if info, err := root.Stat(target.Rel); err == nil {
		prev = info.ModTime()
	}
	if clash != 0 {
		// NAME TAKEN WHILE THE BODY STREAMED? (D9, G1) The check before the
		// body is minutes old for a video. The lock keeps other uploads out;
		// renameNoReplace keeps out everything else (a move, a restore, the
		// converter), which take no lock.
		if _, err := root.Lstat(target.Rel); err == nil {
			sendError(w, r, clash, clashText(clash))
			return 0, errors.New("name taken while the body streamed")
		}
		err := renameNoReplace(root, tmpName, target.Rel)
		if errors.Is(err, errSourceLeft) {
			// Saved: only the temp's own name stayed. An error here would make
			// a retry meet its own file (412). The deferred remove tries
			// again; the startup sweep takes what is left.
			s.log.Warn("upload saved; its temp name stayed", "path", target.Abs, "err", err)
			err = nil
		}
		if err != nil {
			if errors.Is(err, fs.ErrExist) {
				sendError(w, r, clash, clashText(clash))
			} else {
				sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
			}
			return 0, err
		}
	} else if err := root.Rename(tmpName, target.Rel); err != nil { // atomic: readers never see a partial file
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
		return 0, err
	}
	nextSecond(root, target.Rel, prev)
	// THE VERSION THIS SAVE MADE, for the page's next save (If-Match, or
	// If-Unmodified-Since). Taken here, under the lock: read after it, a save
	// landing in between would be answered as ours, and the page's next save
	// would pass over it. Should the path already hold another file (a writer
	// that takes no lock, in this instant), the tag stays OUR file's: it
	// matches nothing there, so that next save gets 412 instead.
	placed := mine
	if info, err := root.Stat(target.Rel); err == nil && os.SameFile(info, mine) {
		placed = info // with the time nextSecond gave it
	}
	// The new name is durable only once its folder is synced (K1). Until then
	// a power cut brings the old file back - after a 200, when the browser has
	// already dropped its copy. A failure is answered: the browser keeps it.
	if err := syncRootDir(root, filepath.Dir(target.Rel)); err != nil {
		if owner := s.users.HomeOwner(target.Abs); owner != "" {
			s.users.ForgetUsage(owner) // the file did change size
		}
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
		return 0, err
	}
	w.Header().Set("ETag", fileETag(placed))
	w.Header().Set("Last-Modified", placed.ModTime().UTC().Format(http.TimeFormat))
	return written, nil
}

// nextSecond: HTTP dates are whole seconds, so two saves of one file inside
// the same second would carry the same Last-Modified, and a third save based
// on the first would pass If-Unmodified-Since and undo the second. Each save
// therefore moves the file's time on to a new second: when the new time is not
// past the old one's second, it becomes that second + 1. Called under the
// path's lock (lockPath), right after the rename. A burst of saves can put the
// time a few seconds ahead of the clock; the next quiet save is back on it.
// Best effort: a file whose time cannot be set is saved all the same.
func nextSecond(root *os.Root, rel string, prev time.Time) {
	if prev.IsZero() {
		return
	}
	info, err := root.Stat(rel)
	if err != nil {
		return
	}
	floor := prev.Truncate(time.Second)
	if info.ModTime().Truncate(time.Second).After(floor) {
		return
	}
	next := floor.Add(time.Second)
	root.Chtimes(rel, next, next)
}

// pathLocks serialises the final check-and-rename of uploads to one path. A
// fixed set of stripes, picked by a hash of the path: nothing to create or
// forget per file, and two paths sharing a stripe only wait a rename apart.
var pathLocks [64]sync.Mutex

// lockPath takes the stripe of `abs` and returns its unlock.
func lockPath(abs string) func() {
	h := fnv.New32a()
	h.Write([]byte(abs))
	m := &pathLocks[h.Sum32()%uint32(len(pathLocks))]
	m.Lock()
	return m.Unlock
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

// uploadChars is the alphabet of an upload's temp name (tempfile's), and
// filetree's uploadNameRE matches exactly eight of them.
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
