package main

// =============================================================================
// POST /api/files?from=<path>&new=<path> - Drive's "Copy to...".
// =============================================================================
//
// Drive used to copy in the browser: read every file's bytes, write them back
// under the new name. A big video filled the tab's memory and crashed it. The
// server copies disk to disk instead, one request per picked item.
//
// The rules are move's (filesMove), with two differences:
//
//   - the SOURCE need not be writable: copying out of a read-only share (or a
//     trip's lent extras) is how a guest keeps a photo;
//   - the two paths may sit under different roots (a share -> the own home).
//
// Never over anything (409, as move); never INTO a shared folder, even an
// "add" one (move's rule); never a structural folder, the bin, an account
// file or the Chat/eMail data, at either end. The quota - of whoever's home
// the copy lands in - is checked BEFORE the first byte, and again as it
// writes, so a file that grew meanwhile still cannot pass it.
//
// A copy is a NEW file: new inode (fileid_unix.go), today's date, no grant
// and no chat link follows it. Photo notes (sidecars) are the client's to
// carry, as for a move (NayiveMedia.copyPaths).
//
// Everything goes through os.Root (sandbox.go), both ends. The walk never
// follows a symlink: a link is left out of the copy, whether it points inside
// the home or out of it - the same as Download and Compress (zipSources).

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"
)

// copyEntry is one thing the copy makes, relative to the item's own top.
type copyEntry struct {
	rel string // inside the source root
	sub string // below the top ("" is the top itself)
	dir bool
}

func (s *Server) filesCopy(w http.ResponseWriter, r *http.Request, role, user string, q Query) {
	oldRel, newRel := q.Get("from"), q.Get("new")
	src, srcOK := s.users.Resolve(role, user, oldRel)
	dst, dstOK := s.users.Resolve(role, user, newRel)
	if !srcOK || !dstOK || !dst.Writable {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}
	// Out of a share, yes; into one, never - not even an "add" grant (move's rule).
	if IsSharedPath(newRel) {
		sendError(w, r, http.StatusForbidden, "no se puede copiar dentro de algo compartido")
		return
	}
	if s.isStructuralDir(role, user, src.Abs) || s.isStructuralDir(role, user, dst.Abs) ||
		s.isProtectedFile(role, dst.Abs) {
		sendError(w, r, http.StatusForbidden, "no se puede copiar esa carpeta")
		return
	}
	// A home the admin moved under the request: 503, never 404 (sendMissing).
	info, err := src.Stat()
	if err != nil || !(info.Mode().IsRegular() || info.IsDir()) {
		sendMissing(w, r, err, "source not found")
		return
	}
	// A folder into itself would copy for ever.
	if src.Abs == dst.Abs || isInside(src.Abs, dst.Abs) {
		sendError(w, r, http.StatusBadRequest, "no se puede copiar una carpeta dentro de sí misma")
		return
	}
	if dst.Exists() {
		sendError(w, r, http.StatusConflict,
			"ya existe un archivo o carpeta con ese nombre en el destino")
		return
	}

	srcRoot, err := src.open()
	if err != nil {
		sendMissing(w, r, err, "source not found")
		return
	}
	defer srcRoot.Close()
	entries, need := copyWalk(srcRoot, filepath.ToSlash(src.Rel), info.IsDir())

	// The folders MkdirParent makes go again if the copy is refused or fails:
	// a 507 must not leave an empty "nuevo/deep/" behind.
	made := missingParents(dst)
	done := false
	defer func() {
		if !done {
			for i := len(made) - 1; i >= 0; i-- {
				_ = dst.at(made[i]).Remove() // empty folders only
			}
		}
	}()
	if err := dst.MkdirParent(); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear la carpeta")
		return
	}
	room := s.zipRoom(role, user, dst.at(filepath.Dir(dst.Rel)))
	if need > room {
		sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
		return
	}

	dstRoot, err := dst.open()
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo copiar")
		return
	}
	defer dstRoot.Close()

	cw := &cappedWriter{w: io.Discard, ceiling: room} // counts every byte written, all files
	var files int
	if info.IsDir() {
		files, err = copyFolder(srcRoot, dstRoot, dst.Rel, entries, cw)
	} else {
		err = copyOneFile(srcRoot, dstRoot, src.Rel, dst.Rel, cw)
		files = 1
	}

	owner := s.users.HomeOwner(dst.Abs)
	switch {
	case errors.Is(err, fs.ErrExist):
		sendError(w, r, http.StatusConflict,
			"ya existe un archivo o carpeta con ese nombre en el destino")
		return
	case errors.Is(err, errTooBig):
		sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
		return
	case err != nil:
		if owner != "" {
			s.users.ForgetUsage(owner)
		}
		s.log.Warn("copy failed", "from", src.Abs, "to", dst.Abs, "err", err)
		sendError(w, r, http.StatusInternalServerError, "no se pudo copiar")
		return
	}
	done = true
	if owner != "" {
		s.users.AdjustUsage(owner, cw.written)
	}
	s.log.Info("copied", "user", user, "from", oldRel, "to", newRel, "files", files, "bytes", cw.written)
	sendJSON(w, r, http.StatusOK, map[string]any{"message": "copied", "files": files})
}

// missingParents lists the folders above dst that do not exist yet, outermost
// first - what MkdirParent is about to make.
func missingParents(dst Resolved) []string {
	var out []string
	for dir := filepath.Dir(dst.Rel); dir != "." && dir != "/" && dir != ""; dir = filepath.Dir(dir) {
		if _, err := os.Lstat(dst.at(dir).Abs); err == nil {
			break
		}
		out = append([]string{dir}, out...)
	}
	return out
}

// copyWalk lists what a copy of `rel` makes, and the bytes of its files. A
// folder is walked through its os.Root: no symlink is followed or copied, and
// the bin and half-written temps are left out, as zipSources leaves them.
func copyWalk(root *os.Root, rel string, dir bool) ([]copyEntry, int64) {
	if !dir {
		info, err := root.Stat(rel)
		if err != nil {
			return nil, 0
		}
		return []copyEntry{{rel: rel}}, info.Size()
	}
	var out []copyEntry
	var total int64
	fs.WalkDir(root.FS(), rel, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable folder is left out, never fatal
		}
		if d.IsDir() && d.Name() == ".trash" {
			return fs.SkipDir
		}
		if !d.IsDir() && (!d.Type().IsRegular() || isTempName(d.Name())) {
			return nil // a link, a device, a half-written temp
		}
		sub := zipInner(rel, p)
		if !d.IsDir() {
			if fi, err := d.Info(); err == nil {
				total += fi.Size()
			}
		}
		out = append(out, copyEntry{rel: p, sub: sub, dir: d.IsDir()})
		return nil
	})
	return out, total
}

// madeHere is what ONE job (a folder copy, a zip extract) has made so far, so
// that a failed job takes back exactly that. Never a RemoveAll of its new
// folder: it shows in Drive at once, and during a long job the user may move
// or save a file into it - a RemoveAll deleted that too, for good (G5).
type madeHere struct {
	root  *os.Root
	dirs  []string // in the order made: a folder before what is inside it
	files []madeFile
}

type madeFile struct {
	rel  string
	info os.FileInfo // what was made, so a file put over its name is not taken
}

// mkdir makes one folder and notes it.
func (m *madeHere) mkdir(rel string) error {
	if err := m.root.Mkdir(rel, 0o755); err != nil {
		return err
	}
	m.dirs = append(m.dirs, rel)
	return nil
}

// mkdirAll is MkdirAll from `base` (which exists) down to `rel`, noting each
// folder it makes - and only those: one that was there already is not ours.
func (m *madeHere) mkdirAll(base, rel string) error {
	inner, err := filepath.Rel(base, rel)
	if err != nil || inner == "." {
		return err
	}
	at := base
	for _, part := range strings.Split(inner, string(filepath.Separator)) {
		at = filepath.Join(at, part)
		err := m.mkdir(at)
		if errors.Is(err, fs.ErrExist) {
			if info, lerr := m.root.Lstat(at); lerr == nil && info.IsDir() {
				continue
			}
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// create makes a NEW file (O_EXCL: never over a name) and notes it at once -
// a half-written one must go too if the job fails.
func (m *madeHere) create(rel string) (*os.File, error) {
	out, err := m.root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	if info, err := out.Stat(); err == nil {
		m.files = append(m.files, madeFile{rel, info})
	}
	if hook := testMadeHook.Load(); hook != nil {
		(*hook)(rel)
	}
	return out, nil
}

// testMadeHook is for tests only (nil in the server): it runs each time a
// job notes a file it made (madeHere.create: the path inside its root;
// madePaths.note: the absolute path), so a test can put the user's own file
// into the job's new folder while the job runs - and prove a failed job
// leaves it there.
var testMadeHook atomic.Pointer[func(path string)]

// undo removes what the job made, newest first: each file only while its
// name still holds that same file, each folder only once empty (a folder
// holding something the user put there stays, and so do the folders above
// it). Best effort: what cannot go stays, which is never a loss.
func (m *madeHere) undo() {
	for i := len(m.files) - 1; i >= 0; i-- {
		f := m.files[i]
		if now, err := m.root.Lstat(f.rel); err == nil && os.SameFile(f.info, now) {
			m.root.Remove(f.rel)
		}
	}
	for i := len(m.dirs) - 1; i >= 0; i-- {
		m.root.Remove(m.dirs[i]) // fails on a folder that is not empty
	}
}

// copyFolder makes the folder `dstRel` - it must not exist yet: that is the
// no-overwrite check, done by the kernel - and fills it. On any error what
// it made goes again (madeHere), so a failed copy leaves nothing half-made
// behind - and nothing the user put in the new folder meanwhile is touched.
func copyFolder(srcRoot, dstRoot *os.Root, dstRel string, entries []copyEntry, cw *cappedWriter) (int, error) {
	made := &madeHere{root: dstRoot}
	if err := made.mkdir(dstRel); err != nil {
		return 0, err // fs.ErrExist: something took the name meanwhile - not ours to remove
	}
	files := 0
	for _, e := range entries {
		if e.sub == "" {
			continue // the top: made above
		}
		to := filepath.Join(dstRel, filepath.FromSlash(e.sub))
		var err error
		if e.dir {
			err = made.mkdir(to)
		} else {
			var out *os.File
			if out, err = made.create(to); err == nil {
				err = copyBytes(srcRoot, e.rel, out, cw)
				files++
			}
		}
		if err != nil {
			made.undo()
			return 0, err
		}
	}
	// Every name made durable before "copied" (K1): each new folder once -
	// its files were synced as they were written - and the folder holding
	// the copy's top. Once per folder, never per file: a copy of a thousand
	// photos must not wait a thousand syncs.
	dirs := []string{filepath.Dir(dstRel), dstRel}
	for _, e := range entries {
		if e.dir && e.sub != "" {
			dirs = append(dirs, filepath.Join(dstRel, filepath.FromSlash(e.sub)))
		}
	}
	for _, dir := range dirs {
		if err := syncRootDir(dstRoot, dir); err != nil {
			return 0, err
		}
	}
	return files, nil
}

// copyOneFile copies into a temp beside the target, then LINKS it to the
// name: a link fails when the name is taken, so nothing is ever overwritten,
// and no reader ever sees half a file (writeZip does the same). The temp
// stays 0600 until then, so a crash leaves the startup sweep a temp it knows.
func copyOneFile(srcRoot, dstRoot *os.Root, srcRel, dstRel string, cw *cappedWriter) error {
	tmp, tmpRel, err := createUploadTemp(dstRoot, filepath.Dir(dstRel))
	if err != nil {
		return err
	}
	defer dstRoot.Remove(tmpRel) // once linked, only the temp's own name goes
	if err := copyBytes(srcRoot, srcRel, tmp, cw); err != nil {
		return err
	}
	if err := dstRoot.Link(tmpRel, dstRel); err != nil {
		return err
	}
	if err := dstRoot.Chmod(dstRel, 0o644); err != nil {
		return err
	}
	return syncRootDir(dstRoot, filepath.Dir(dstRel)) // the new name durable (K1)
}

// copyBytes fills `out` with the bytes of `from`, syncs it and closes it.
// What is copied is what was OPENED: a name swapped for something else after
// the walk is refused, not followed.
func copyBytes(srcRoot *os.Root, from string, out *os.File, cw *cappedWriter) error {
	defer out.Close()
	in, err := srcRoot.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	if info, err := in.Stat(); err != nil || !info.Mode().IsRegular() {
		return errors.New("not a regular file: " + path.Base(from))
	}
	// cw counts first and stops at the quota before a byte lands in `out`.
	if _, err := io.Copy(io.MultiWriter(cw, out), in); err != nil {
		return err
	}
	// On disk before it is answered "copied" (S2-#23).
	if err := out.Sync(); err != nil {
		return err
	}
	return out.Close()
}
