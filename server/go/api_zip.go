package main

// =============================================================================
// /api/zip - what is inside a .zip, "Extract here", and "Compress".
// =============================================================================
//
//	GET  /api/zip?file=files/x.zip           what is inside - nothing is unpacked
//	POST /api/zip?file=files/x.zip           unpack it beside itself -> {"path", "files", "skipped"}
//	POST /api/zip?paths=files/a&paths=...    pack them into ONE new .zip -> {"path", "files", "size"}
//
// The last one is Drive's "Compress" - see COMPRESS at the end of this file.
//
// Drive's double-click on a .zip opens the list of what is inside, with an
// "Extract here" button; its right-click menu has the same "Extract here".
// Both land here: the SERVER unpacks, so the zip never travels to a phone and
// back one file at a time.
//
// WHERE IT GOES. A new folder beside the zip, named after it: "Fotos.zip" ->
// "Fotos/". When everything in the zip already sits in ONE folder (a zipped
// folder - Drive's own "Download" makes those), that folder is the one made,
// so "Fotos.zip" holding "Fotos/..." gives "Fotos/", never "Fotos/Fotos/". A
// name that is taken gets " (2)", " (3)"... Nothing already there is ever
// written over: every folder and file is created, never opened.
//
// REFUSED, before anything is written:
//
//	423  a password-protected zip - asking for the password is not built
//	415  a compression other than "stored" and "deflate"
//	413  more than zipMaxEntries entries
//	507  more bytes than there is room for: the quota, or - for the admin and a
//	     user without one - the disk's free space less zipDiskMargin
//	403  a read-only or shared folder (an "add" grant never makes folders)
//	422  not a zip, empty, or an entry that does not inflate cleanly
//
// SKIPPED, left out of the list and counted in the answer:
//   - a name that climbs out ("../x") or has a ".trash" segment - the
//     sandbox's own rules. "/etc/x" is kept, as "etc/x" inside the folder;
//   - a link, a device, a pipe: only files and folders are made. Nothing in the
//     file API may create a symlink (sandbox.go), and a zip is no exception;
//   - a second copy of a name the zip already gave (a zip may hold two).
//
// macOS's "__MACOSX/" and ".DS_Store" litter is left out too, and not counted.
//
// THE BYTES ARE COUNTED AS THEY INFLATE. The sizes a zip declares are checked
// up front; Go's reader refuses an entry that inflates past its own declared
// size, and one cappedWriter shared by every entry stops the whole job at the
// room there is - a zip bomb costs that and an error, never the disk.
//
// A job that fails half way (room, a damaged entry, the browser gone) takes its
// folder away again: this request made it, so nothing else is in it.
//
// Every write goes through ONE os.Root on the folder the zip is in
// (sandbox.go), so whatever a name inside the zip says, the kernel keeps the
// write inside.
//
// Old names: a zip made by an old Windows tool stores "año.txt" in the DOS code
// page, without the UTF-8 flag. A name that is not valid UTF-8 is read as code
// page 850 (Western Europe - the same á é í ó ú ñ ü ¿ ¡ as 437).

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	zipMaxEntries = 50000     // more is refused (413)
	zipListMax    = 2000      // the most entries the list sends back
	zipDiskMargin = 512 << 20 // left free on the disk when there is no quota
)

// zipItem is one entry worth unpacking: its cleaned path, and the entry.
type zipItem struct {
	parts []string
	dir   bool
	f     *zip.File
}

// zipPlan is what a zip holds once the unsafe entries and the litter are out.
type zipPlan struct {
	items       []zipItem
	skipped     int    // unsafe entries left out
	files       int    // files to make
	dirs        int    // distinct folders, including those only implied by a path
	size        int64  // the declared bytes of every file
	locked      bool   // a file needs a password
	unsupported bool   // a file uses a compression Go cannot read
	strip       string // the one top folder everything sits in, or ""
}

func (s *Server) apiZip(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	role, user := sess.Role, sess.User

	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		sendError(w, r, http.StatusMethodNotAllowed, "use GET or POST")
		return
	}
	q := cleanQuery(r)
	if r.Method == http.MethodPost && q.Has("paths") {
		s.zipCompress(w, r, role, user, q.All("paths"))
		return
	}
	if !q.Has("file") {
		sendError(w, r, http.StatusBadRequest, "missing ?file=")
		return
	}
	virt := strings.Join(splitPath(unquotePath(q.Get("file"))), "/")

	src, ok := s.users.Resolve(role, user, virt)
	if !ok {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}
	info, err := src.Stat()
	if err != nil || !info.Mode().IsRegular() {
		sendError(w, r, http.StatusNotFound, "no existe")
		return
	}
	f, err := src.Open()
	if err != nil {
		sendError(w, r, http.StatusNotFound, "no existe")
		return
	}
	defer f.Close()

	zr, err := zip.NewReader(f, info.Size())
	if err != nil {
		sendError(w, r, http.StatusUnprocessableEntity, "no es un .zip válido")
		return
	}
	if len(zr.File) > zipMaxEntries {
		sendError(w, r, http.StatusRequestEntityTooLarge, "el .zip tiene demasiados archivos")
		return
	}
	plan := planZip(zr)

	// The folder the zip is in is where it unpacks. A shared single file has
	// no folder of ours ("shared" alone does not resolve), and an "add" grant
	// lends a folder to drop files in, never to make folders in - see
	// filesMkdir. Chat's own data is written by chat.go alone.
	dirVirt := path.Dir(virt)
	parent, ok := s.users.Resolve(role, user, dirVirt)
	canWrite := ok && parent.Writable && !IsSharedPath(virt) && !s.isServerData(parent.Abs)

	if r.Method == http.MethodGet {
		s.zipList(w, r, plan, parent, canWrite, path.Base(virt))
		return
	}

	switch {
	case !canWrite:
		sendError(w, r, http.StatusForbidden, "carpeta de sólo lectura")
		return
	case plan.locked:
		sendError(w, r, http.StatusLocked, "el .zip tiene contraseña")
		return
	case plan.unsupported:
		sendError(w, r, http.StatusUnsupportedMediaType, "el .zip usa una compresión que no se puede leer")
		return
	case plan.files == 0 && plan.dirs == 0:
		sendError(w, r, http.StatusUnprocessableEntity, "el .zip está vacío")
		return
	}

	room := s.zipRoom(role, user, parent)
	if plan.size > room {
		sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
		return
	}

	root, err := parent.open()
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo abrir la carpeta")
		return
	}
	defer root.Close()

	name, err := claimFolder(root, parent.Rel, zipFolderName(plan, path.Base(virt)))
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear la carpeta")
		return
	}
	destRel := filepath.Join(parent.Rel, name)
	destVirt := path.Join(dirVirt, name)

	written, files, skipped, err := unzipInto(r.Context(), root, destRel, plan, room)
	if err != nil {
		root.RemoveAll(destRel)
		if owner := s.users.HomeOwner(parent.Abs); owner != "" {
			s.users.ForgetUsage(owner)
		}
		switch {
		case r.Context().Err() != nil:
			return // the browser gave up; nobody to answer
		case errors.Is(err, errTooBig):
			sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
		default:
			s.log.Warn("zip: could not extract", "path", src.Abs, "err", err)
			sendError(w, r, http.StatusUnprocessableEntity, "el .zip está dañado")
		}
		return
	}

	if owner := s.users.HomeOwner(parent.Abs); owner != "" {
		s.users.AdjustUsage(owner, written)
	}
	s.log.Info("zip: extracted", "user", user, "from", virt, "to", destVirt,
		"files", files, "bytes", written)
	sendJSON(w, r, http.StatusOK, map[string]any{
		"path": destVirt, "files": files, "skipped": plan.skipped + skipped,
	})
}

// zipRoom is how many bytes may still be written into `parent`: what is left of
// the quota of whoever's home it is in (see filesWrite), or - for the admin
// and a user without a quota - the disk's free space less zipDiskMargin.
func (s *Server) zipRoom(role, user string, parent Resolved) int64 {
	payer := s.users.HomeOwner(parent.Abs)
	if payer == "" {
		payer = user
	}
	var quota *int64
	if role != "admin" {
		quota = s.users.UserQuotaBytes(payer)
	}
	var room int64
	if quota != nil {
		room = *quota - s.users.UserUsageBytes(payer)
	} else {
		_, free := diskUsage(parent.Abs)
		room = free - zipDiskMargin
	}
	return max(room, 0) // cappedWriter reads a negative ceiling as "no limit"
}

// zipList is the GET: the files inside (folders are implied by their paths),
// sorted by name, and what "Extract here" would do. "into" is the folder it
// would make now, "" when it cannot extract here.
func (s *Server) zipList(w http.ResponseWriter, r *http.Request, plan zipPlan,
	parent Resolved, canWrite bool, zipName string) {

	files := make([]zipItem, 0, plan.files)
	for _, it := range plan.items {
		if !it.dir {
			files = append(files, it)
		}
	}
	sort.SliceStable(files, func(i, j int) bool {
		return strings.ToLower(strings.Join(files[i].parts, "/")) <
			strings.ToLower(strings.Join(files[j].parts, "/"))
	})

	entries := make([]map[string]any, 0, min(len(files), zipListMax))
	for _, it := range files[:min(len(files), zipListMax)] {
		entries = append(entries, map[string]any{
			"name": strings.Join(it.parts, "/"),
			"size": it.f.UncompressedSize64,
		})
	}

	into := ""
	if canWrite {
		if root, err := parent.open(); err == nil {
			into = freeFolderName(root, parent.Rel, zipFolderName(plan, zipName))
			root.Close()
		}
	}
	sendJSON(w, r, http.StatusOK, map[string]any{
		"entries": entries, "truncated": len(files) > zipListMax,
		"files": plan.files, "dirs": plan.dirs, "size": plan.size,
		"locked": plan.locked, "unsupported": plan.unsupported,
		"into": into,
	})
}

// planZip reads the central directory - nothing is inflated - and decides what
// "Extract here" would make.
func planZip(zr *zip.Reader) zipPlan {
	var p zipPlan
	folders := map[string]bool{}
	tops := map[string]bool{}
	topFile := false

	for _, f := range zr.File {
		parts, dir, kind := zipEntryPath(f)
		switch kind {
		case zipLitter:
			continue
		case zipUnsafe:
			p.skipped++
			continue
		}
		p.items = append(p.items, zipItem{parts: parts, dir: dir, f: f})
		tops[parts[0]] = true

		last := len(parts)
		if !dir {
			last--
			topFile = topFile || len(parts) == 1
		}
		for i := 1; i <= last; i++ {
			folders[strings.Join(parts[:i], "/")] = true
		}
		if dir {
			continue
		}

		p.files++
		// A declared size past 2^62 is a lie, and would wrap the sum negative.
		p.size = min(p.size+int64(min(f.UncompressedSize64, 1<<62)), 1<<62)
		if f.Flags&0x1 != 0 {
			p.locked = true // bit 0: encrypted (AES entries set it too)
		}
		if f.Method != zip.Store && f.Method != zip.Deflate {
			p.unsupported = true
		}
	}
	p.dirs = len(folders)

	if len(tops) == 1 && !topFile {
		for t := range tops {
			p.strip = t
		}
	}
	return p
}

// What zipEntryPath makes of one entry.
type zipKind int

const (
	zipKeep   zipKind = iota
	zipLitter         // macOS's leftovers: dropped, not counted
	zipUnsafe         // climbs out, or not a file or folder: skipped and counted
)

// zipEntryPath is an entry's name as path segments, and whether it is a folder.
func zipEntryPath(f *zip.File) ([]string, bool, zipKind) {
	name := f.Name
	if !utf8.ValidString(name) {
		name = decodeCP850(name)
	}
	name = strings.ReplaceAll(name, "\\", "/") // Windows tools write "a\b.txt"
	mode := f.Mode()
	dir := strings.HasSuffix(name, "/") || mode.IsDir()
	parts := splitPath(name)

	switch {
	case len(parts) == 0:
		return nil, false, zipLitter // "/" or "./": nothing to make
	case parts[0] == "__MACOSX" || parts[len(parts)-1] == ".DS_Store":
		return nil, false, zipLitter
	case hasDotDot(parts) || hasSegment(parts, ".trash") || strings.ContainsRune(name, 0):
		return nil, false, zipUnsafe
	case !dir && !mode.IsRegular():
		return nil, false, zipUnsafe // a link, a device, a pipe
	}
	return parts, dir, zipKeep
}

// zipFolderName is the name "Extract here" wants: the one top folder, or the
// zip's own name less its extension.
func zipFolderName(p zipPlan, zipName string) string {
	if p.strip != "" {
		return p.strip
	}
	if base := strings.TrimSuffix(zipName, path.Ext(zipName)); base != "" {
		return base
	}
	return zipName
}

// zipCandidate is the i-th try at a free name: "Fotos", "Fotos (2)", ...
func zipCandidate(base string, i int) string {
	if i == 1 {
		return base
	}
	return fmt.Sprintf("%s (%d)", base, i)
}

// freeFolderName is the first candidate nothing in parentRel holds yet - what
// claimFolder would take right now. For the list only: claimFolder decides.
func freeFolderName(root *os.Root, parentRel, base string) string {
	for i := 1; i < 1000; i++ {
		name := zipCandidate(base, i)
		if _, err := root.Lstat(filepath.Join(parentRel, name)); errors.Is(err, fs.ErrNotExist) {
			return name
		}
	}
	return ""
}

// claimFolder MAKES the first free candidate and returns its name. Mkdir fails
// on a name that exists, so two extractions at once can never share a folder.
func claimFolder(root *os.Root, parentRel, base string) (string, error) {
	for i := 1; ; i++ {
		name := zipCandidate(base, i)
		err := root.Mkdir(filepath.Join(parentRel, name), 0o755)
		if err == nil {
			return name, nil
		}
		if !errors.Is(err, fs.ErrExist) || i >= 1000 {
			return "", err
		}
	}
}

// unzipInto makes every item of the plan under destRel, which exists and is
// empty. A name it cannot make (the zip's second copy of a name, a file where
// the zip wants a folder) is skipped; failing to READ an entry, or running
// past `room`, ends the job with an error.
func unzipInto(ctx context.Context, root *os.Root, destRel string, plan zipPlan,
	room int64) (written int64, files, skipped int, err error) {

	cw := &cappedWriter{ceiling: room}
	for _, it := range plan.items {
		if err := ctx.Err(); err != nil {
			return cw.written, files, skipped, err
		}
		parts := it.parts
		if plan.strip != "" {
			parts = parts[1:] // the folder claimFolder made stands for it
		}
		if len(parts) == 0 {
			continue
		}
		rel := filepath.Join(append([]string{destRel}, parts...)...)

		if it.dir {
			if root.MkdirAll(rel, 0o755) != nil {
				skipped++
			}
			continue
		}
		if root.MkdirAll(filepath.Dir(rel), 0o755) != nil {
			skipped++
			continue
		}
		out, err := root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			skipped++
			continue
		}
		err = inflateEntry(it.f, out, cw)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return cw.written, files, skipped, err
		}
		if !it.f.Modified.IsZero() {
			root.Chtimes(rel, it.f.Modified, it.f.Modified) // a photo keeps its date
		}
		files++
	}
	return cw.written, files, skipped, nil
}

// inflateEntry copies one entry into out through the shared byte count.
func inflateEntry(f *zip.File, out io.Writer, cw *cappedWriter) error {
	in, err := f.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	cw.w = out
	_, err = io.Copy(cw, in)
	return err
}

// cp850High is code page 850's bytes 0x80-0xFF, in order.
const cp850High = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒ" +
	"áíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐" +
	"└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀" +
	"ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ "

var cp850Runes = []rune(cp850High)

// decodeCP850 reads a legacy DOS name. Bytes below 0x80 are ASCII.
func decodeCP850(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x80 {
			b.WriteByte(c)
		} else {
			b.WriteRune(cp850Runes[c-0x80])
		}
	}
	return b.String()
}

// =============================================================================
// COMPRESS - one or more files and folders into ONE new .zip.
// =============================================================================
//
// The .zip lands in the folder the FIRST path is in - beside what was picked -
// named after that item: "Fotos" -> "Fotos.zip", "informe.pdf" ->
// "informe.zip", a taken name -> "Fotos (2).zip". Several items keep their own
// names at the top of the zip; a folder keeps its name as the zip's top folder,
// the shape Drive's "Download" and every desktop tool make.
//
// Only files and folders go in: a link, a device or a half-written temp is
// left out, and so is a .trash can. Every read goes through the os.Root of the
// path it came from, every write through the one of the folder it lands in.
//
// The zip is written as a ".convert-" temp (0600, the startup sweep's shape),
// then hard-LINKED to the first free name: a link fails on a name that exists,
// so nothing is ever written over, even by two requests at once. Photos,
// videos, music and other zips are STORED - deflating them again costs the
// one core time and saves nothing.
//
// Refused before a byte is written: 403 a read-only or shared folder, 404 a
// path that is not there, 413 more than zipMaxEntries entries, 507 more bytes
// than zipRoom. The bytes written are counted too, so a file that grew since
// it was measured still cannot pass the room.

// zipSource is one entry to write: where it is read from, and its name inside.
type zipSource struct {
	root  *os.Root // the root of the path it came from
	rel   string   // its slash path inside that root
	name  string   // its name in the zip; a folder's ends in "/"
	dir   bool
	size  int64
	mtime time.Time
}

// zipStored are the extensions written as they are, not deflated again.
var zipStored = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".heic": true, ".avif": true,
	".mp4": true, ".m4v": true, ".mov": true, ".mkv": true, ".webm": true, ".avi": true,
	".mp3": true, ".m4a": true, ".aac": true, ".ogg": true, ".opus": true, ".flac": true,
	".zip": true, ".rar": true, ".7z": true, ".gz": true, ".tgz": true, ".bz2": true, ".xz": true,
	".docx": true, ".xlsx": true, ".pptx": true, ".odt": true, ".ods": true, ".odp": true,
}

var errTooMany = errors.New("too many entries")

func (s *Server) zipCompress(w http.ResponseWriter, r *http.Request, role, user string, paths []string) {
	virts := zipVirts(paths)
	if len(virts) == 0 {
		sendError(w, r, http.StatusBadRequest, "missing ?paths=")
		return
	}

	dirVirt := path.Dir(virts[0])
	parent, ok := s.users.Resolve(role, user, dirVirt)
	if !ok || !parent.Writable || IsSharedPath(virts[0]) || s.isServerData(parent.Abs) {
		sendError(w, r, http.StatusForbidden, "carpeta de sólo lectura")
		return
	}

	items, total, firstDir, roots, status, msg := s.zipSources(role, user, virts)
	defer closeRoots(roots)
	if status != 0 {
		sendError(w, r, status, msg)
		return
	}

	room := s.zipRoom(role, user, parent)
	if total > room {
		sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
		return
	}

	root, err := parent.open()
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo abrir la carpeta")
		return
	}
	defer root.Close()

	base := path.Base(virts[0])
	if !firstDir {
		if b := strings.TrimSuffix(base, path.Ext(base)); b != "" {
			base = b
		}
	}

	name, size, files, err := writeZip(r.Context(), root, parent.Rel, base, items, room)
	switch {
	case r.Context().Err() != nil:
		return // the browser gave up; writeZip took its temp away
	case errors.Is(err, errTooBig):
		sendError(w, r, http.StatusInsufficientStorage, "cuota de disco superada")
		return
	case err != nil:
		s.log.Warn("zip: could not compress", "path", parent.Abs, "err", err)
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear el .zip")
		return
	}

	if owner := s.users.HomeOwner(parent.Abs); owner != "" {
		s.users.AdjustUsage(owner, size)
	}
	destVirt := path.Join(dirVirt, name)
	s.log.Info("zip: compressed", "user", user, "to", destVirt, "files", files, "bytes", size)
	sendJSON(w, r, http.StatusOK, map[string]any{"path": destVirt, "files": files, "size": size})
}

// zipVirts is the picked paths, cleaned; the same path twice goes in once.
func zipVirts(paths []string) []string {
	var virts []string
	seen := map[string]bool{}
	for _, p := range paths {
		v := strings.Join(splitPath(unquotePath(p)), "/")
		if v != "" && !seen[v] {
			seen[v] = true
			virts = append(virts, v)
		}
	}
	return virts
}

// zipSources resolves the picked paths and walks the folders among them: every
// entry of the zip they make, the bytes of its files, and whether the first
// one is a folder. A status other than 0 is a refusal, with its message. The
// roots it opened are the caller's to close - on a refusal too (closeRoots).
// Compress and Download (api_download.go) both start here.
func (s *Server) zipSources(role, user string, virts []string) (items []zipSource, total int64,
	firstDir bool, roots []*os.Root, status int, msg string) {

	taken := map[string]bool{}

	for i, v := range virts {
		src, ok := s.users.Resolve(role, user, v)
		if !ok {
			return items, total, firstDir, roots, http.StatusForbidden, "forbidden"
		}
		info, err := src.Stat()
		if err != nil || !(info.Mode().IsRegular() || info.IsDir()) {
			return items, total, firstDir, roots, http.StatusNotFound, "no existe"
		}
		rt, err := src.open()
		if err != nil {
			return items, total, firstDir, roots, http.StatusNotFound, "no existe"
		}
		roots = append(roots, rt)
		if i == 0 {
			firstDir = info.IsDir()
		}
		top := zipTopName(path.Base(v), info.IsDir(), taken)
		rel := filepath.ToSlash(src.Rel)

		if !info.IsDir() {
			items = append(items, zipSource{root: rt, rel: rel, name: top,
				size: info.Size(), mtime: info.ModTime()})
			total += info.Size()
			continue
		}
		err = fs.WalkDir(rt.FS(), rel, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // an unreadable folder is left out, never fatal
			}
			if d.IsDir() && d.Name() == ".trash" {
				return fs.SkipDir
			}
			isDir := d.IsDir()
			if !isDir && (!d.Type().IsRegular() || isTempName(d.Name())) {
				return nil // a link, a device, a half-written temp
			}
			fi, err := d.Info()
			if err != nil {
				return nil
			}
			name := top
			if inner := zipInner(rel, p); inner != "" {
				name += "/" + inner
			}
			if isDir {
				name += "/"
			} else {
				total += fi.Size()
			}
			items = append(items, zipSource{root: rt, rel: p, name: name, dir: isDir,
				size: fi.Size(), mtime: fi.ModTime()})
			if len(items) > zipMaxEntries {
				return errTooMany
			}
			return nil
		})
		if err != nil {
			return items, total, firstDir, roots, http.StatusRequestEntityTooLarge, "demasiados archivos para un .zip"
		}
	}
	return items, total, firstDir, roots, 0, ""
}

// closeRoots closes what zipSources opened.
func closeRoots(roots []*os.Root) {
	for _, rt := range roots {
		rt.Close()
	}
}

// zipTopName is an item's name at the top of the zip, made unique: two picked
// "notas.txt" (a search can hold both) become "notas.txt" and "notas (2).txt".
func zipTopName(name string, dir bool, taken map[string]bool) string {
	base, ext := name, ""
	if !dir {
		if e := path.Ext(name); e != "" && e != name {
			base, ext = strings.TrimSuffix(name, e), e
		}
	}
	for i := 1; ; i++ {
		cand := zipCandidate(base, i) + ext
		if !taken[cand] {
			taken[cand] = true
			return cand
		}
	}
}

// zipInner is p's path below the walk's start `rel` ("" for the start itself).
func zipInner(rel, p string) string {
	if rel == "." {
		if p == "." {
			return ""
		}
		return p
	}
	return strings.TrimPrefix(strings.TrimPrefix(p, rel), "/")
}

// writeZip writes the items into a temp in dirRel, links it to the first free
// "<base>.zip", "<base> (2).zip"... and answers that name, the zip's size and
// the files in it. On any error the temp is gone and no name was taken.
func writeZip(ctx context.Context, root *os.Root, dirRel, base string, items []zipSource,
	room int64) (name string, size int64, files int, err error) {

	tmp, tmpRel, err := createTempNamed(root, dirRel, ".convert-")
	if err != nil {
		return "", 0, 0, err
	}
	defer root.Remove(tmpRel) // once linked, only the temp's own name goes

	cw := &cappedWriter{w: tmp, ceiling: room}
	zw := zip.NewWriter(cw)
	for _, it := range items {
		if err = ctx.Err(); err != nil {
			break
		}
		if err = addToZip(zw, it, nil); err != nil {
			break
		}
		if !it.dir {
			files++
		}
	}
	if err == nil {
		err = zw.Close()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", 0, 0, err
	}

	for i := 1; i < 1000; i++ {
		name = zipCandidate(base, i) + ".zip"
		final := filepath.Join(dirRel, name)
		err = root.Link(tmpRel, final)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", 0, 0, err
		}
		// Readable like an upload; while it was a temp it stayed 0600, so a
		// crash before this line leaves the sweep something it recognises.
		root.Chmod(final, 0o644)
		return name, cw.written, files, nil
	}
	return "", 0, 0, fs.ErrExist
}

// addToZip writes one entry: a folder as its name alone, a file read through
// its own root - and through wrap, when there is one (Download counts there).
func addToZip(zw *zip.Writer, it zipSource, wrap func(io.Reader) io.Reader) error {
	fh := &zip.FileHeader{Name: it.name, Modified: it.mtime, Method: zip.Deflate}
	if it.dir {
		fh.SetMode(fs.ModeDir | 0o755)
		_, err := zw.CreateHeader(fh)
		return err
	}
	fh.SetMode(0o644)
	if zipStored[strings.ToLower(path.Ext(it.name))] {
		fh.Method = zip.Store
	}
	in, err := it.root.Open(filepath.FromSlash(it.rel))
	if err != nil {
		return err
	}
	defer in.Close()
	w, err := zw.CreateHeader(fh)
	if err != nil {
		return err
	}
	var from io.Reader = in
	if wrap != nil {
		from = wrap(in)
	}
	_, err = io.Copy(w, from)
	return err
}
