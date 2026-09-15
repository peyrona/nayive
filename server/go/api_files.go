package main

// =============================================================================
// /api/files - the JSON file API.
// =============================================================================
//
// One route, many shapes, exactly as the Python has it. The order below is the
// Python's order, and it matters: a query parameter is tested for PRESENCE, so
// "?trash=list" is answered before anything else even looks at "?file=".
//
//	GET    ?trash=list                 the papelera
//	       ?trash=days                 how long it keeps things
//	       ?tripdays=1                 the trip-reminder lead time
//	       ?stat=disk                  quota / free space / trash size
//	       ?dir=<path>[&recursive=1]   one folder, or its whole subtree
//	       ?tree=dirs                  the folders-only tree
//	       ?find=<glob>                a flat name search
//	       ?file=<path>                the file itself
//	       (nothing)                   the whole tree
//	POST   ?old=&new=                  rename / move
//	       ?trash=restore|empty        undelete / empty
//	PUT    ?type=dir&name=&parent=     mkdir
//	       ?file=<path>                upload
//	DELETE ?paths=a&paths=b            move to the trash
//	       &purge=1                    really delete (a user's data/ only)
//	       ?trash=&ids=a;b             purge from the trash

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// searchLimit caps a ?find= walk. `truncated` in the answer says it stopped early.
const searchLimit = 500

func (s *Server) apiFiles(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	role, user := sess.Role, sess.User
	q := cleanQuery(r)

	// ---- the trash can (papelera) -----------------------------------------
	if q.Has("trash") {
		s.filesTrash(w, r, role, user, q)
		return
	}

	// ---- trip-reminder lead time (read by the Tasks app) ------------------
	if q.Has("tripdays") {
		var def *int
		s.cfg.Read(func(c *ServerConfig) { def = c.TripReminderDays })
		s.daysSetting(w, r, role, user, q, intOr(def, TripDaysDefault),
			func(u string) *int {
				d := s.users.UserTripReminderDays(u)
				return &d
			},
			s.users.SetUserTripReminderDays)
		return
	}

	// ---- GET ?stat=disk ---------------------------------------------------
	if r.Method == http.MethodGet && q.Has("stat") {
		if q.Get("stat") != "disk" {
			sendError(w, r, http.StatusBadRequest, "unknown stat")
			return
		}
		s.filesStat(w, r, role, user)
		return
	}

	// ---- PUT ?type=dir&name=&parent=  -> mkdir ----------------------------
	if r.Method == http.MethodPut && q.Get("type") == "dir" {
		s.filesMkdir(w, r, role, user, q)
		return
	}

	// ---- POST ?old=&new=  -> rename / move --------------------------------
	if r.Method == http.MethodPost && q.Has("old") && q.Has("new") {
		s.filesMove(w, r, role, user, q)
		return
	}

	// ---- DELETE ?paths=  -> the trash, or a real delete -------------------
	if r.Method == http.MethodDelete {
		s.filesDelete(w, r, role, user, q)
		return
	}

	// ---- GET ?dir=<path>  -> ONE level, or the whole subtree --------------
	if r.Method == http.MethodGet && q.Has("dir") {
		s.filesListDir(w, r, role, user, q)
		return
	}

	// ---- GET ?tree=dirs  -> the folders-only tree -------------------------
	if r.Method == http.MethodGet && q.Get("tree") == "dirs" {
		sendJSON(w, r, http.StatusOK, s.tree.DirTree(role, user))
		return
	}

	// ---- GET ?find=<glob>  -> a flat name search --------------------------
	if r.Method == http.MethodGet && q.Has("find") {
		pat := strings.TrimSpace(q.Get("find"))
		if pat == "" {
			sendError(w, r, http.StatusBadRequest, "patrón vacío")
			return
		}
		nodes, truncated := Search(s.searchRoots(role, user), pat, searchLimit)
		sendJSON(w, r, http.StatusOK, map[string]any{
			"pattern": pat, "role": role, "user": user,
			"nodes": nodes, "truncated": truncated,
		})
		return
	}

	// ---- the file itself, or the whole tree -------------------------------
	if !q.Has("file") {
		if r.Method == http.MethodGet {
			sendJSON(w, r, http.StatusOK, s.tree.UserTree(role, user, false))
			return
		}
		sendError(w, r, http.StatusBadRequest, "missing ?file=")
		return
	}
	fileRel := q.Get("file")

	target, ok := s.users.Resolve(role, user, fileRel)
	if !ok {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}

	switch r.Method {
	case http.MethodGet, http.MethodHead:
		s.filesRead(w, r, target, q)
	case http.MethodPut:
		s.filesWrite(w, r, role, user, fileRel, target)
	default:
		sendError(w, r, http.StatusMethodNotAllowed, r.Method+" not allowed")
	}
}

// -----------------------------------------------------------------------------
// reading
// -----------------------------------------------------------------------------

func (s *Server) filesRead(w http.ResponseWriter, r *http.Request, target Resolved, q Query) {
	// Stat BEFORE opening: opening a FIFO or a device could block, or worse.
	info, err := target.Stat()
	if err != nil || !info.Mode().IsRegular() {
		sendError(w, r, http.StatusNotFound, "not found")
		return
	}
	file, err := target.Open()
	if err != nil {
		sendError(w, r, http.StatusNotFound, "not found")
		return
	}
	defer file.Close()
	// What goes out is what was OPENED, whatever the name points at by now.
	if info, err = file.Stat(); err != nil || !info.Mode().IsRegular() {
		sendError(w, r, http.StatusNotFound, "not found")
		return
	}
	// ?immutable=1 -> the CLIENT promises this URL's content never changes (it
	// names files by size+mtime, e.g. the Photos thumbnails), so the browser may
	// cache it for good instead of revalidating on every render.
	if isTrue(q.Get("immutable")) {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	}
	// NO .gz SIDECAR here: a user's own "foo.txt.gz" must stay a file. Only the
	// static apps use sidecars.
	serveFileFrom(w, r, file, ContentType(target.Abs), info)
}

// filesListDir answers ?dir=<path>, and ?dir=<path>&recursive=1.
//
// The recursive GET /api/files still works unchanged; this is the cheap call
// the Drive tree (expand-on-click) and the Photos app should use, so opening one
// folder never ships the whole tree (~700 KB once there are thousands of
// photos).
//
// The recursive form is what the Music app wants: every audio file under the
// chosen folder, subfolders included, in one call. It is NOT offered on the
// virtual root - callers that want the whole root already have plain
// GET /api/files.
func (s *Server) filesListDir(w http.ResponseWriter, r *http.Request, role, user string, q Query) {
	rel := strings.Trim(q.Get("dir"), "/")
	recursive := isTrue(q.Get("recursive"))

	var nodes []Node
	switch {
	case rel == "":
		if recursive {
			sendError(w, r, http.StatusBadRequest,
				"recursive necesita ?dir= distinto de la raíz")
			return
		}
		nodes = s.rootChildren(role, user)

	case rel == "shared" && role != "admin":
		// The "Compartido conmigo" folder exists only in shares.go - there is no
		// such directory on disk for ResolvePath to find.
		if recursive {
			if node := s.tree.SharedNode(user, false); node != nil {
				nodes = node.Nodes
			} else {
				nodes = []Node{}
			}
		} else {
			nodes = s.shares.RootNodes(user)
		}

	default:
		target, _ := s.users.ResolvePath(role, user, rel)
		if target == "" {
			sendError(w, r, http.StatusForbidden, "forbidden")
			return
		}
		info, err := os.Stat(target)
		if err != nil || !info.IsDir() {
			sendError(w, r, http.StatusNotFound, "no such folder")
			return
		}
		if recursive {
			nodes = BuildTree(target, rel, false).Nodes
		} else {
			nodes = ListChildren(target, rel)
		}
	}

	sendJSON(w, r, http.StatusOK, map[string]any{
		"path": rel, "role": role, "user": user, "nodes": nodes,
	})
}

// rootChildren is the virtual root listed ONE level deep: the admin sees the
// base dir's children, a regular user sees their data/ and files/ folders -
// whichever exist - plus the virtual "shared" one.
func (s *Server) rootChildren(role, user string) []Node {
	if role == "admin" {
		return ListChildren(s.cfg.BaseDir, "")
	}
	out := []Node{}
	for _, sub := range []string{"data", "files"} {
		p := filepath.Join(s.cfg.HomesDir, user, sub)
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			out = append(out, Node{Path: sub, Nodes: []Node{}})
		}
	}
	if s.shares.HasAny(user) {
		out = append(out, Node{Path: "shared", Nodes: []Node{}})
	}
	return out
}

// searchRoots are the (directory, prefix) pairs ?find= walks - the same ground
// UserTree covers. The client hides data/ hits, same as it hides the data/ node
// from the tree.
func (s *Server) searchRoots(role, user string) []SearchRoot {
	if role == "admin" {
		return []SearchRoot{{Dir: s.cfg.BaseDir, Prefix: ""}}
	}
	out := []SearchRoot{}
	for _, sub := range []string{"data", "files"} {
		p := filepath.Join(s.cfg.HomesDir, user, sub)
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			out = append(out, SearchRoot{Dir: p, Prefix: sub})
		}
	}
	return out
}

// -----------------------------------------------------------------------------
// disk usage
// -----------------------------------------------------------------------------

// filesStat answers ?stat=disk.
//
// "trash" is the bytes the papelera is holding. They are part of "used", so
// emptying it is the quickest way to make room, and the apps offer exactly that
// when an upload does not fit.
func (s *Server) filesStat(w http.ResponseWriter, r *http.Request, role, user string) {
	held := s.trash.Size(role, user)

	var quota *int64
	if role != "admin" {
		quota = s.users.UserQuotaBytes(user)
	}
	if quota == nil { // admin, or no quota set: the real disk
		total, free := diskUsage(s.cfg.BaseDir)
		sendJSON(w, r, http.StatusOK,
			map[string]any{"total": total, "usable": free, "trash": held})
		return
	}
	used := s.users.UserUsageBytes(user)
	usable := *quota - used
	if usable < 0 {
		usable = 0
	}
	sendJSON(w, r, http.StatusOK,
		map[string]any{"total": *quota, "usable": usable, "trash": held})
}

// diskUsage is shutil.disk_usage: (total bytes, bytes free to a non-root user).
//
// java: syscall.Statfs is Linux-specific, which this server has always been -
// it is deployed to one Ubuntu VPS and run on one Ubuntu laptop. Bavail rather
// than Bfree is the right field: Bfree counts the blocks reserved for root,
// which nobody here can actually use.
func diskUsage(path string) (int64, int64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	return int64(st.Blocks) * st.Bsize, int64(st.Bavail) * st.Bsize
}

// -----------------------------------------------------------------------------
// mkdir, move, delete
// -----------------------------------------------------------------------------

func (s *Server) filesMkdir(w http.ResponseWriter, r *http.Request, role, user string, q Query) {
	name := q.Get("name")
	parent := q.Get("parent")
	rel := name
	if parent != "" {
		rel = strings.Trim(parent+"/"+name, "/")
	}

	target, ok := s.users.Resolve(role, user, rel)
	// "add" lends you the folder to drop files in, not to reshape.
	if !ok || !target.Writable || IsSharedPath(rel) {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}
	if err := target.MkdirAll(); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear la carpeta")
		return
	}
	sendJSON(w, r, http.StatusCreated, map[string]string{"message": "directory created"})
}

func (s *Server) filesMove(w http.ResponseWriter, r *http.Request, role, user string, q Query) {
	oldRel, newRel := q.Get("old"), q.Get("new")
	src, srcOK := s.users.Resolve(role, user, oldRel)
	dst, dstOK := s.users.Resolve(role, user, newRel)
	if !srcOK || !dstOK || !src.Writable || !dst.Writable {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}
	// Nothing shared is ever renamed or moved, in or out: an "add" grant only
	// ever GROWS the folder.
	if IsSharedPath(oldRel) || IsSharedPath(newRel) {
		sendError(w, r, http.StatusForbidden, "no se puede mover nada compartido")
		return
	}
	if s.isStructuralDir(role, user, src.Abs) || s.isStructuralDir(role, user, dst.Abs) {
		sendError(w, r, http.StatusForbidden, "no se puede mover esa carpeta")
		return
	}
	// os.Root renames only inside ONE root. Nothing allowed above can differ -
	// data/ and files/ share the home, the admin has the base - so this only
	// writes the assumption down.
	if src.Root != dst.Root {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}
	if !src.Exists() {
		sendError(w, r, http.StatusNotFound, "source not found")
		return
	}
	// Never let a move land on top of something already there: rename would
	// delete it outright, with no trip through the papelera. (sameResolved
	// guards a pure case-change on a case-insensitive filesystem, where src and
	// dst are the same inode.)
	if dst.Exists() && !sameResolved(src, dst) {
		sendError(w, r, http.StatusConflict,
			"ya existe un archivo o carpeta con ese nombre en el destino")
		return
	}

	dst.MkdirParent()
	if err := renameResolved(src, dst); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo mover")
		return
	}
	if role == "admin" { // may have crossed from one home to another
		for _, owner := range []string{s.users.HomeOwner(src.Abs), s.users.HomeOwner(dst.Abs)} {
			if owner != "" {
				s.users.ForgetUsage(owner)
			}
		}
	}
	sendJSON(w, r, http.StatusOK, map[string]string{"message": "moved"})
}

// filesDelete moves paths to the trash can, or - with &purge=1 - really deletes
// them.
//
// ONE `paths=` PARAMETER PER PATH, never one string joined by a separator: a
// filename may legally contain any character except "/", so any separator we
// picked would eventually appear inside a real name and split it into two bogus
// paths (a ";" in a name used to trash a SIBLING and report success).
//
// &purge=1 is only for a regular user's own data/ tree: the app-owned sidecars
// (scan caches, Photos thumbnails) that Drive never shows and an app can
// rebuild. Trashing those would just fill the papelera with noise.
func (s *Server) filesDelete(w http.ResponseWriter, r *http.Request, role, user string, q Query) {
	targets := q.All("paths")
	if len(targets) == 0 {
		targets = q.All("file") // the legacy ?file=
	}
	if len(targets) == 0 {
		sendError(w, r, http.StatusBadRequest, "no paths")
		return
	}
	purge := isTrue(q.Get("purge"))
	if purge && role != "user" {
		sendError(w, r, http.StatusForbidden, "purge solo para los datos de un usuario")
		return
	}

	// Resolve and vet EVERYTHING first, so one bad path never leaves the batch
	// half-trashed.
	type job struct {
		rel string
		p   Resolved
	}
	resolved := make([]job, 0, len(targets))
	for _, rel := range targets {
		target, ok := s.users.Resolve(role, user, rel)
		if !ok || !target.Writable || s.isStructuralDir(role, user, target.Abs) {
			sendError(w, r, http.StatusForbidden, "forbidden: "+rel)
			return
		}
		// Even on an "add" grant: you put photos in, you never take any out -
		// not your own, and certainly not the owner's. Deleting would also fill
		// THEIR papelera, which they alone can empty.
		if IsSharedPath(rel) {
			sendError(w, r, http.StatusForbidden, "no puedes borrar nada compartido: "+rel)
			return
		}
		if purge {
			parts := splitPath(unquotePath(rel))
			if len(parts) == 0 || parts[0] != "data" {
				sendError(w, r, http.StatusForbidden, "purge solo bajo data/: "+rel)
				return
			}
			// Inside data/, only what an app can make again: the Photos
			// thumbnails, the one thing any app purges. tasks.json,
			// calendar.ics, contacts.vcf and the trips live in data/ too, and
			// one wrong path from an app must never erase them with no
			// papelera. Asked of the RESOLVED path, so a symlink named
			// "thumbs" cannot lead back to them.
			if !isPurgeable(target.Rel) {
				sendError(w, r, http.StatusForbidden, "purge solo para miniaturas: "+rel)
				return
			}
		}
		resolved = append(resolved, job{rel, target})
	}

	done := 0
	for _, j := range resolved {
		info, err := j.p.Lstat()
		if err != nil {
			continue
		}
		owner := s.users.HomeOwner(j.p.Abs)
		var freed int64

		if purge {
			// Files only (a sidecar is always a file); a folder would need a
			// recursive delete and nothing in the apps asks for that.
			if !info.Mode().IsRegular() {
				continue
			}
			freed = info.Size()
			if err := j.p.Remove(); err != nil {
				continue
			}
		} else {
			// Into the papelera. For a regular user that trash sits inside their
			// own home, so the bytes still count and the cached figure stays
			// exactly as it is - only Trash.Purge frees space. The ADMIN trash is
			// <base>/.trash, outside every home, so an admin trashing someone's
			// file really does shrink that home: re-measure it.
			if _, err := s.trash.MoveIn(role, user, j.p, j.rel); err != nil {
				continue
			}
			if role == "admin" && owner != "" {
				s.users.ForgetUsage(owner)
			}
		}
		done++
		if owner != "" && freed > 0 {
			s.users.AdjustUsage(owner, -freed)
		}
	}

	message := "trashed"
	if purge {
		message = "purged"
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"message": message, "count": done})
}

// -----------------------------------------------------------------------------
// the trash routes
// -----------------------------------------------------------------------------

func (s *Server) filesTrash(w http.ResponseWriter, r *http.Request, role, user string, q Query) {
	mode := q.Get("trash")
	// The ids of a trash operation DO travel joined by ";" - unlike ?paths=,
	// because an entryId is server-made and can only be digits, a dash and hex.
	ids := []string{}
	for _, id := range strings.Split(q.Get("ids"), ";") {
		if id != "" {
			ids = append(ids, id)
		}
	}

	switch {
	case r.Method == http.MethodGet && mode == "list":
		sendJSON(w, r, http.StatusOK,
			map[string]any{"items": s.trash.List(role, user)})

	case mode == "days":
		var def *int
		s.cfg.Read(func(c *ServerConfig) { def = c.TrashDays })
		s.daysSetting(w, r, role, user, q, intOr(def, s.cfg.TrashDays),
			s.users.UserTrashDays, s.users.SetUserTrashDays)

	case r.Method == http.MethodPost && mode == "restore":
		renamed := s.trash.Restore(role, user, ids)
		// A user's own trash lives INSIDE their home, so restoring from it moves
		// no total: the bytes already counted. The admin trash is <base>/.trash,
		// outside every home, so a restore from there adds bytes to whichever
		// home the file lands in - and we cannot tell which from here, so drop
		// every cached figure.
		if role == "admin" {
			s.users.ForgetUsage("")
		}
		sendJSON(w, r, http.StatusOK,
			map[string]any{"message": "restored", "renamed": renamed})

	case r.Method == http.MethodPost && mode == "empty":
		sendJSON(w, r, http.StatusOK, map[string]any{
			"message": "emptied", "count": s.trash.Purge(role, user, nil)})

	case r.Method == http.MethodDelete:
		sendJSON(w, r, http.StatusOK, map[string]any{
			"message": "purged", "count": s.trash.Purge(role, user, ids)})

	default:
		sendError(w, r, http.StatusBadRequest, "bad trash request")
	}
}

// daysSetting is the shared body of ?trash=days and ?tripdays=1.
//
// GET answers {"days", "default"} - the admin sees the server-wide default, a
// user their own value or the default when unset. POST &value=N stores it.
//
// java: `getter` and `setter` are FUNCTION VALUES, so the branch logic exists
// once for two settings. Java would need an interface or a pair of lambdas;
// here the call sites pass methods directly.
func (s *Server) daysSetting(w http.ResponseWriter, r *http.Request, role, user string,
	q Query, def int, getter func(string) *int, setter func(string, string, string) (int, bool)) {

	switch r.Method {
	case http.MethodGet:
		days := def
		if role != "admin" {
			if cur := getter(user); cur != nil {
				days = *cur
			}
		}
		sendJSON(w, r, http.StatusOK, map[string]int{"days": days, "default": def})

	case http.MethodPost:
		stored, ok := setter(role, user, q.Get("value"))
		if !ok {
			sendError(w, r, http.StatusBadRequest, "valor no válido")
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"message": "ok", "days": stored})

	default:
		sendError(w, r, http.StatusBadRequest, "use GET o POST")
	}
}

// -----------------------------------------------------------------------------
// the structural-folder guard
// -----------------------------------------------------------------------------

// isStructuralDir reports a path that must NEVER be renamed or trashed through
// the file API: a virtual root (data/ or files/), or - for the admin - the base
// directory, homes/ and every user home, config/ and everything in it, and the
// whole of apps/.
//
// Deleting one of these wipes an account, unlocks the admin panel, or takes the
// apps offline; an admin deletes a user through the admin panel, not the file
// API.
//
// The admin's Drive is rooted at the base directory, so all of this really is
// one click and one Delete away - the guard has to cover the CONTENTS of these
// folders, not just the folders themselves:
//
//	apps/**              arrives only by deploy.sh rsync; no app ever writes
//	                     there. Trashing apps/shared/ui.js breaks all the apps
//	                     at once, Drive included - so nothing could undo it.
//	                     (Only when apps_dir is unset: an install puts the
//	                     apps outside the base dir, out of the Drive.)
//	config/*             server.json holds the admin account; without it the
//	                     admin panel opens with NO login at all. shares.json
//	                     holds every grant.
//	homes/<u>/{data,files}
//	                     one of these IS that account's whole content.
//	homes/<u>/data/config.json
//	                     IS the account: its password and quota. Gone, the
//	                     user cannot sign in - not even to restore it.
//
// The last one is a FILE, and a user is also refused a plain overwrite of it -
// see isProtectedFile. A deliberate difference from the Python.
func (s *Server) isStructuralDir(role, user, target string) bool {
	if target == "" {
		return false
	}
	t, err := resolveExisting(target)
	if err != nil {
		return true // cannot tell -> refuse, the safe default
	}
	if s.isAccountFile(t) {
		return true // for the admin as much as for the user
	}

	if role != "admin" {
		home, err := resolveExisting(filepath.Join(s.cfg.HomesDir, user))
		if err != nil {
			return true
		}
		return t == home ||
			t == filepath.Join(home, "data") ||
			t == filepath.Join(home, "files")
	}

	base, _ := resolveExisting(s.cfg.BaseDir)
	apps, _ := resolveExisting(s.cfg.AppsDir)
	homes, _ := resolveExisting(s.cfg.HomesDir)
	config, _ := resolveExisting(s.cfg.ConfigDir)

	if t == base || t == apps || t == homes || t == config {
		return true
	}
	if apps != "" && isInside(apps, t) {
		return true // anywhere inside apps/, at any depth
	}
	if filepath.Dir(t) == config {
		return true // config/server.json, config/shares.json, config/vapid.json
	}
	parent := filepath.Dir(t)
	if filepath.Dir(parent) == homes {
		if name := filepath.Base(t); name == "data" || name == "files" {
			return true
		}
	}
	// A whole user home - homes/<name>, a DIRECT child of homes/.
	return parent == homes
}

// isAccountFile is homes/<someone>/data/config.json - the file that IS an
// account. `t` must already be resolved.
func (s *Server) isAccountFile(t string) bool {
	homes, err := resolveExisting(s.cfg.HomesDir)
	if err != nil {
		return false
	}
	data := filepath.Dir(t)
	return filepath.Base(t) == "config.json" && filepath.Base(data) == "data" &&
		filepath.Dir(filepath.Dir(data)) == homes
}

// isProtectedFile is a file the file API must not even REPLACE: a user's own
// config.json (a user who could write it could lift their own quota). The
// admin panel is the way to change it. `t` must already be resolved.
func (s *Server) isProtectedFile(role, t string) bool {
	return role != "admin" && s.isAccountFile(t)
}

// purgeable is the one folder whose files may be deleted for good, skipping
// the papelera: derived data an app makes again on its own.
var purgeable = []string{"data", "photos", "thumbs"}

// isPurgeable reports a path (relative to the user's home) strictly inside
// that folder.
func isPurgeable(rel string) bool {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) <= len(purgeable) {
		return false
	}
	for i, seg := range purgeable {
		if parts[i] != seg {
			return false
		}
	}
	return true
}

// -----------------------------------------------------------------------------
// small helpers
// -----------------------------------------------------------------------------

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// isTrue is the "1" / "true" query flag the apps send.
func isTrue(v string) bool { return v == "1" || v == "true" }

func mkdirAll(parts ...string) {
	os.MkdirAll(filepath.Join(parts...), 0o755)
}
