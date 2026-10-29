// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// Drive's shortcuts ("Shortcut only" in Copy to…).
// =============================================================================
//
//	POST /api/files?link=<target>&into=<folder>  -> {"path"}: a shortcut to target in folder
//	GET  /api/files?shortcuts=1                  -> {"links": [{"path", "to"}]}: every one
//	&links=1 on ?dir= / ?find= / ?search=        -> shortcuts listed, with a `link` field
//
// A shortcut is a small file "<name>.nayive-link" beside the user's own
// files, holding {"nayiveLink":1,"to":"files/...","dir":bool,"ino":n}. Being
// a plain file, it moves, renames, goes to the bin and comes back like any
// other, and it costs a hundred bytes, not a second copy. It is NEVER a
// symlink: those stay banned (filetree.go), and nothing here ever follows
// one.
//
// Only Drive sees them: every listing drops them unless it asks with
// &links=1, so a file picker elsewhere never offers one. A shared folder
// never shows one, a zip or a download leaves them out (zipSources), and the
// target is always the user's own: never something lent to them.
//
// THE TARGET MOVES. The path is tried first. When nothing of the right kind is
// there, the target's inode is looked for in the home (one walk); a hit
// counts only when it kept its name (moved) or its folder (renamed) - an
// inode number freed and taken by an unrelated file must not pass. A hit, or
// a path that now holds a file with another inode (a save replaces the
// file), is written back into the shortcut, so the next move is found too.
// That write is the only one besides the create, and it never replaces
// anything but the very shortcut it read (writeLinkFile).

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	linkExt      = ".nayive-link"
	linkMaxBytes = 4096        // a shortcut file bigger than this is not one
	linkListMax  = 5000        // ?shortcuts=1 stops there
	linkMissTTL  = time.Minute // a target looked for and not found is not walked for again before
)

// linkFile is what a shortcut holds.
type linkFile struct {
	V   int    `json:"nayiveLink"`
	To  string `json:"to"`
	Dir bool   `json:"dir"`
	Ino uint64 `json:"ino,omitempty"`
}

// LinkTo is what a listing node of a shortcut carries: where it leads, or
// Broken when the target is gone.
type LinkTo struct {
	To     string `json:"to,omitempty"`
	Dir    bool   `json:"dir"`
	Broken bool   `json:"broken,omitempty"`
}

var errLinkChanged = errors.New("the shortcut changed meanwhile")

// isLinkName: a shortcut's file name.
func isLinkName(name string) bool {
	return len(name) > len(linkExt) && strings.HasSuffix(strings.ToLower(name), linkExt)
}

// dropLinks is `nodes` without any shortcut, at any depth.
func dropLinks(nodes []Node) []Node {
	if nodes == nil {
		return nil
	}
	out := make([]Node, 0, len(nodes))
	for _, n := range nodes {
		if n.Nodes == nil && isLinkName(path.Base(n.Path)) {
			continue
		}
		n.Nodes = dropLinks(n.Nodes)
		out = append(out, n)
	}
	return out
}

// linkable: a path a shortcut may point at or live in - the user's own
// files/ (anything under the base for the admin), never something lent.
func linkable(role, rel string) bool {
	parts := splitPath(rel)
	if len(parts) == 0 || IsSharedPath(rel) {
		return false
	}
	return role == "admin" || parts[0] == "files"
}

// -----------------------------------------------------------------------------
// make one
// -----------------------------------------------------------------------------

// filesLink answers POST ?link=<target>&into=<folder>: a shortcut named after
// the target ("x.docx.nayive-link", "x.docx (2).nayive-link" when taken) in
// the folder. The target is only read.
func (s *Server) filesLink(w http.ResponseWriter, r *http.Request, role, user string, q Query) {
	toRel := strings.Trim(q.Get("link"), "/")
	intoRel := strings.Trim(q.Get("into"), "/")
	if !linkable(role, toRel) || !linkable(role, intoRel) {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}
	target, ok1 := s.users.Resolve(role, user, toRel)
	into, ok2 := s.users.Resolve(role, user, intoRel)
	if !ok1 || !ok2 || !into.Writable || s.isServerData(into.Abs) || s.isStructuralDir(role, user, target.Abs) {
		sendError(w, r, http.StatusForbidden, "forbidden")
		return
	}
	info, err := target.Lstat()
	if err != nil {
		sendMissing(w, r, err, "no existe")
		return
	}
	if !info.IsDir() && (!info.Mode().IsRegular() || isLinkName(info.Name())) {
		sendError(w, r, http.StatusBadRequest, "no se puede enlazar")
		return
	}
	if dinfo, err := into.Stat(); err != nil || !dinfo.IsDir() {
		sendMissing(w, r, err, "no such folder")
		return
	}

	body, _ := json.Marshal(linkFile{V: 1, To: toRel, Dir: info.IsDir(), Ino: fileID(info)})
	if left, limited := s.quotaLeft(role, user, into.Abs); limited && left < int64(len(body)) {
		sendError(w, r, http.StatusInsufficientStorage, "sin espacio")
		return
	}

	root, err := into.openCreating()
	if err != nil {
		sendMissing(w, r, err, "")
		return
	}
	defer root.Close()
	tmpRel, err := linkTemp(root, into.Rel, body)
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear")
		return
	}
	defer root.Remove(tmpRel) // a no-op once it has its name
	// Never over anything: renameNoReplace takes the first free name.
	name, err := claimName(path.Base(toRel), linkExt, 2, 1000, func(name string) error {
		return renameNoReplace(root, tmpRel, filepath.Join(into.Rel, name))
	})
	if err == nil {
		err = syncRootDir(root, into.Rel)
	}
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo crear")
		return
	}
	if owner := s.users.HomeOwner(into.Abs); owner != "" {
		s.users.AdjustUsage(owner, int64(len(body)))
	}
	sendJSON(w, r, http.StatusCreated, map[string]string{"path": intoRel + "/" + name})
}

// linkTemp writes `body` to a fresh temp in `dir` (0644, on disk) and returns
// its path inside the root. The caller renames it, and removes it on failure.
func linkTemp(root *os.Root, dir string, body []byte) (string, error) {
	tmp, tmpRel, err := createUploadTemp(root, dir)
	if err != nil {
		return "", err
	}
	_, err = tmp.Write(body)
	if err == nil {
		err = tmp.Chmod(0o644)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		root.Remove(tmpRel)
		return "", err
	}
	return tmpRel, nil
}

// writeLinkFile puts `lf` in the shortcut at p - only while p is still the
// file `was` read (same file, same time): a shortcut renamed, binned or
// replaced meanwhile is left as it is (errLinkChanged).
func (s *Server) writeLinkFile(p Resolved, lf linkFile, was os.FileInfo) error {
	body, _ := json.Marshal(lf)
	root, err := p.openCreating()
	if err != nil {
		return err
	}
	defer root.Close()
	dir := filepath.Dir(p.Rel)
	tmpRel, err := linkTemp(root, dir, body)
	if err != nil {
		return err
	}
	defer root.Remove(tmpRel) // a no-op once renamed away

	unlock := lockPath(p.Abs) // as an upload's replacing rename
	defer unlock()
	now, err := root.Lstat(p.Rel)
	if err != nil || !now.Mode().IsRegular() || !os.SameFile(was, now) ||
		!now.ModTime().Equal(was.ModTime()) || now.Size() != was.Size() {
		return errLinkChanged
	}
	if err := root.Rename(tmpRel, p.Rel); err != nil {
		return err
	}
	if owner := s.users.HomeOwner(p.Abs); owner != "" {
		s.users.AdjustUsage(owner, int64(len(body))-was.Size())
	}
	return syncRootDir(root, dir)
}

// readLinkFile is the shortcut at p and the file it was read from.
func readLinkFile(p Resolved) (linkFile, os.FileInfo, bool) {
	var lf linkFile
	f, info, err := p.OpenRegular()
	if err != nil {
		return lf, nil, false
	}
	defer f.Close()
	if info.Size() > linkMaxBytes {
		return lf, info, false
	}
	b, err := io.ReadAll(io.LimitReader(f, linkMaxBytes))
	if err != nil || json.Unmarshal(b, &lf) != nil || lf.V != 1 || lf.To == "" {
		return lf, info, false
	}
	return lf, info, true
}

// -----------------------------------------------------------------------------
// where each one leads
// -----------------------------------------------------------------------------

// resolveLinks fills the `link` of every shortcut in `nodes` (one level),
// mending those whose target moved.
func (s *Server) resolveLinks(role, user string, nodes []Node) []Node {
	type miss struct {
		i   int
		p   Resolved
		lf  linkFile
		was os.FileInfo
	}
	var misses []miss

	for i := range nodes {
		n := &nodes[i]
		if n.Nodes != nil || !isLinkName(path.Base(n.Path)) {
			continue
		}
		n.Link = &LinkTo{Broken: true}
		p, ok := s.users.Resolve(role, user, n.Path)
		if !ok {
			continue
		}
		lf, was, ok := readLinkFile(p)
		if !ok {
			continue
		}
		n.Link.Dir = lf.Dir
		if !linkable(role, lf.To) {
			continue
		}
		if t, ok := s.users.Resolve(role, user, lf.To); ok {
			if info, err := t.Lstat(); err == nil && linkKindOK(info, lf.Dir) {
				n.Link = &LinkTo{To: lf.To, Dir: lf.Dir}
				// A save replaces a file, and with it its inode: keep the
				// new one, or the next move of it could not be followed.
				if id := fileID(info); id != 0 && id != lf.Ino {
					lf.Ino = id
					s.writeLinkFile(p, lf, was) // best effort: the path still works today
				}
				continue
			}
		}
		if role != "admin" && lf.Ino != 0 {
			misses = append(misses, miss{i, p, lf, was})
		}
	}
	if len(misses) == 0 {
		return nodes
	}

	home, err := resolveExisting(s.users.homeDir(user))
	if err != nil {
		return nodes
	}
	want := map[uint64]string{}
	for _, m := range misses {
		want[m.lf.Ino] = m.lf.To
	}
	found := findLinkTargets(home, want)
	for _, m := range misses {
		to, ok := found[m.lf.Ino]
		if !ok {
			continue
		}
		m.lf.To = to
		nodes[m.i].Link = &LinkTo{To: to, Dir: m.lf.Dir}
		s.writeLinkFile(m.p, m.lf, m.was) // best effort: found again next time otherwise
	}
	return nodes
}

// linkKindOK: what is at the target's path is what the shortcut leads to.
func linkKindOK(info os.FileInfo, dir bool) bool {
	if dir {
		return info.IsDir()
	}
	return info.Mode().IsRegular()
}

// linkMisses remembers, per home and inode, a walk that found nothing: a
// shortcut whose target is gone must not walk the home at every listing.
var linkMisses = struct {
	sync.Mutex
	m map[string]time.Time
}{m: map[string]time.Time{}}

func linkMissKey(home string, ino uint64) string {
	return home + "\x00" + itoa64(int64(ino))
}

// findLinkTargets walks home/files once for the inodes in `want` (inode ->
// the path the shortcut knew) and answers "files/..." for each found that
// kept its name or its folder. The bin and dot-folders are not looked in, and
// symlinks are never followed (WalkDir does not).
func findLinkTargets(home string, want map[uint64]string) map[uint64]string {
	found := map[uint64]string{}
	now := time.Now()
	linkMisses.Lock()
	for k, at := range linkMisses.m {
		if now.Sub(at) > linkMissTTL {
			delete(linkMisses.m, k)
		}
	}
	left := map[uint64]string{}
	for ino, was := range want {
		if _, recent := linkMisses.m[linkMissKey(home, ino)]; !recent {
			left[ino] = was
		}
	}
	linkMisses.Unlock()
	if len(left) == 0 {
		return found
	}

	seen := 0
	base := filepath.Join(home, "files")
	filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if seen++; seen > chatFindMax || len(found) == len(left) {
			return filepath.SkipAll
		}
		if p != base && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.IsDir() && !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		was, ok := left[fileID(info)]
		if !ok || fileID(info) == 0 {
			return nil
		}
		rel, err := filepath.Rel(home, p)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if path.Base(rel) == path.Base(was) || path.Dir(rel) == path.Dir(was) {
			if _, dup := found[fileID(info)]; !dup {
				found[fileID(info)] = rel
			}
		}
		return nil
	})

	linkMisses.Lock()
	for ino := range left {
		if _, ok := found[ino]; !ok {
			linkMisses.m[linkMissKey(home, ino)] = now
		}
	}
	linkMisses.Unlock()
	return found
}

// -----------------------------------------------------------------------------
// every shortcut (Drive asks before something goes to the bin)
// -----------------------------------------------------------------------------

type linkEntry struct {
	Path string `json:"path"`
	To   string `json:"to"`
}

// linkList answers GET ?shortcuts=1: every shortcut of the user and the path
// it leads to, as last mended. Drive warns with it when what goes to the bin
// has shortcuts left behind.
func (s *Server) linkList(w http.ResponseWriter, r *http.Request, role, user string) {
	out := []linkEntry{}
	nodes, _ := SearchBy(s.searchRoots(role, user), linkListMax, func(name string, d fs.DirEntry) bool {
		return !d.IsDir() && isLinkName(name)
	})
	for _, n := range nodes {
		p, ok := s.users.Resolve(role, user, n.Path)
		if !ok {
			continue
		}
		if lf, _, ok := readLinkFile(p); ok {
			out = append(out, linkEntry{Path: n.Path, To: lf.To})
		}
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"links": out})
}
