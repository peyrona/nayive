package main

// =============================================================================
// The file tree and disk-size helpers.
// =============================================================================
//
// What the apps parse from GET /api/files, plus the byte counters the quota
// checks and the admin panel use.
//
// SYMLINKS ARE NEVER FOLLOWED here. A link to "/" or to another user's home
// must be treated as the link itself, never walked into. That is a security
// boundary, not an optimisation - which is why every walk below uses Lstat and
// os.ReadDir's DirEntry type rather than Stat.

import (
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// maxDepth stops a pathologically nested tree from blowing the stack.
const maxDepth = 40

// Node is one entry of the tree the apps parse.
//
// java: the pointer fields are the ones that must be able to say `null` in
// JSON, and the browser really does test for it: `nodes: null` is how a FILE is
// told apart from an empty FOLDER, and `size: null` in the trash index means
// "not measured yet". A plain []Node would marshal to `null` when nil and `[]`
// when empty, which is the distinction we want - but Size and MTime are
// numbers, so they need explicit pointers.
type Node struct {
	Path   string    `json:"path"`
	Nodes  []Node    `json:"nodes"`
	Size   *int64    `json:"size,omitempty"`
	MTime  *int64    `json:"mtime,omitempty"`
	Shared *SharedBy `json:"shared,omitempty"`

	// User and Role only appear on the ROOT node of a whole-tree answer.
	User string `json:"user,omitempty"`
	Role string `json:"role,omitempty"`
}

// SharedBy are the extra fields a shared node carries: the plain file API has
// no such thing, and the apps use them for "Compartido por ana".
type SharedBy struct {
	By    string `json:"by"`
	Title string `json:"title"`
	App   string `json:"app"`
}

// The EXACT shapes the server itself writes - nothing looser.
//
//	atomicWriteJSON -> "<name>.<pid>.<counter>.tmp"
//	writeUpload     -> ".upload-" + 8 chars of [a-z0-9_]
//
// Matched on those exact shapes, NOT on a bare ".tmp" suffix or ".upload-"
// prefix. A user's own "notes.tmp" is a real file of theirs: the loose test hid
// it from Drive and then deleted it at the next restart.
var (
	tmpNameRE    = regexp.MustCompile(`^.+\.\d+\.\d+\.tmp$`)
	uploadNameRE = regexp.MustCompile(`^\.upload-[a-z0-9_]{8}$`)
	// convert.go's ffmpeg output while it is being written. Same shape and
	// same 0600-until-done rule as an upload's temp.
	convertNameRE = regexp.MustCompile(`^\.convert-[a-z0-9_]{8}$`)
)

// isTempName reports a leftover from an atomic write or a streamed upload.
// Hidden from every listing and swept at startup.
//
// Callers must only ask this about FILES. The server never writes a temp
// DIRECTORY, so a folder named ".upload-drafts" is the user's own - the loose
// test made such a folder invisible in Drive for good while it went on filling
// their quota.
func isTempName(name string) bool {
	return tmpNameRE.MatchString(name) || uploadNameRE.MatchString(name) ||
		convertNameRE.MatchString(name)
}

// FileTree owns the paths the listings are rooted at.
type FileTree struct {
	baseDir  string
	homesDir string
	shares   *Shares
}

func NewFileTree(baseDir, homesDir string, shares *Shares) *FileTree {
	return &FileTree{baseDir: baseDir, homesDir: homesDir, shares: shares}
}

// SweepStaleTemp deletes orphaned temp files. A `kill -9` during a write can
// strand one and nothing else removes it. Called once from main() at boot -
// safe there because no write is in flight.
//
// It deletes FOR GOOD, with no trip through the papelera, so it only takes
// what can only be the server's own leftover - never a user's file that just
// happens to have a temp-like name ("notas.2024.05.tmp" is a perfectly good
// name for a file):
//
//	"<name>.<pid>.<n>.tmp"   atomicWriteJSON's temp. Looked for ONLY directly
//	                         inside the folders it writes to: config/, every
//	                         homes/<u>/data/, and the .trash cans. Never in
//	                         files/ or deeper in data/, where only users write.
//	".upload-<8 chars>"      a streamed upload's temp. It can be anywhere, so
//	                         it must also still carry the 0600 mode it was
//	                         created with: both servers chmod a finished upload
//	                         to 0644 before it takes its real name, so a user's
//	                         own file never has it.
//	".convert-<8 chars>"     convert.go's ffmpeg output. Same rules as
//	                         ".upload-": anywhere, and only while still 0600.
//
// This is a deliberate difference from the Python, which sweeps both shapes
// everywhere - see docs/go-port.md, "Deliberate differences".
func (t *FileTree) SweepStaleTemp() int {
	n := 0
	remove := func(path string) {
		if os.Remove(path) == nil {
			n++
		}
	}

	jsonDirs := []string{filepath.Join(t.baseDir, "config"), filepath.Join(t.baseDir, ".trash")}
	if homes, err := os.ReadDir(t.homesDir); err == nil {
		for _, h := range homes {
			if h.IsDir() {
				home := filepath.Join(t.homesDir, h.Name())
				jsonDirs = append(jsonDirs, filepath.Join(home, "data"), filepath.Join(home, ".trash"))
			}
		}
	}
	for _, dir := range jsonDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.Type().IsRegular() && tmpNameRE.MatchString(e.Name()) {
				remove(filepath.Join(dir, e.Name()))
			}
		}
	}

	for _, root := range []string{t.homesDir, filepath.Join(t.baseDir, "config")} {
		if info, err := os.Stat(root); err != nil || !info.IsDir() {
			continue
		}
		filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // an unreadable directory is skipped, never fatal
			}
			isTemp := uploadNameRE.MatchString(d.Name()) || convertNameRE.MatchString(d.Name())
			if !d.Type().IsRegular() || !isTemp {
				return nil
			}
			if info, err := d.Info(); err == nil && info.Mode().Perm()&0o077 == 0 {
				remove(path)
			}
			return nil
		})
	}
	return n
}

// scanned is one entry of a directory worth listing.
type scanned struct {
	name    string
	path    string // the absolute path
	relPath string // the path as the API addresses it
	isDir   bool
	info    os.FileInfo
}

// scan is the one directory-reading loop BuildTree and ListChildren share: the
// entries of `fsDir` worth listing - sorted by lowercased name, skipping the
// trash can and half-written temp files, never following symlinks. An
// unreadable directory yields nothing.
func scan(fsDir, relPrefix string) []scanned {
	entries, err := os.ReadDir(fsDir)
	if err != nil {
		return nil
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})

	out := make([]scanned, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if name == ".trash" {
			continue
		}
		full := filepath.Join(fsDir, name)
		// java: Lstat, not Stat: a symlink must be seen as the link itself.
		// os.ReadDir's DirEntry already reports the link's own type, but its
		// Info() is what carries size and mtime, and that is an Lstat too.
		info, err := e.Info()
		if err != nil {
			continue // vanished mid-walk
		}
		rel := name
		if relPrefix != "" {
			rel = relPrefix + "/" + name
		}
		switch {
		case info.IsDir():
			out = append(out, scanned{name, full, rel, true, info})
		case info.Mode().IsRegular():
			if isTempName(name) { // a half-written file
				continue
			}
			out = append(out, scanned{name, full, rel, false, info})
		}
		// Anything else - a symlink, a socket, a device - is simply not listed.
	}
	return out
}

// fileNode is a file's tree node: {path, nodes:null, size, mtime}.
func fileNode(e scanned) Node {
	return Node{
		Path:  e.relPath,
		Nodes: nil, // marshals as `null`: that is how the apps spot a file
		Size:  ptrInt64(e.info.Size()),
		MTime: ptrInt64(e.info.ModTime().Unix()),
	}
}

// BuildTree is the recursive listing. `nodes` is a list for a directory and
// null for a file; `mtime` is UNIX seconds; `path` is relative to the caller's
// virtual root.
//
// dirsOnly drops every file node and keeps only the folder skeleton - the Drive
// left pane wants this: it stays a few KB no matter how many thousands of
// photos a folder holds.
func BuildTree(fsDir, relPrefix string, dirsOnly bool) Node {
	return buildTree(fsDir, relPrefix, dirsOnly, 0)
}

func buildTree(fsDir, relPrefix string, dirsOnly bool, depth int) Node {
	node := Node{Path: relPrefix, Nodes: []Node{}}
	if depth >= maxDepth {
		return node
	}
	for _, e := range scan(fsDir, relPrefix) {
		if e.isDir {
			node.Nodes = append(node.Nodes, buildTree(e.path, e.relPath, dirsOnly, depth+1))
		} else if !dirsOnly {
			node.Nodes = append(node.Nodes, fileNode(e))
		}
	}
	return node
}

// ListChildren is ONE level only: the immediate files AND sub-folders of
// `fsDir`, as tree nodes - files carry {size, mtime}, a sub-folder gets {mtime}
// plus an empty `nodes` list and is NOT recursed into.
//
// This is the lazy counterpart of BuildTree: the Drive tree expands a folder on
// click and the Photos app wants just one folder's contents, neither needs the
// whole recursive tree (which is ~700 KB once there are thousands of photos).
//
// (BuildTree still omits a folder's own mtime; only this one-level listing,
// which the Drive file pane renders directly, adds it.)
func ListChildren(fsDir, relPrefix string) []Node {
	out := []Node{}
	for _, e := range scan(fsDir, relPrefix) {
		if e.isDir {
			out = append(out, Node{
				Path:  e.relPath,
				Nodes: []Node{},
				MTime: ptrInt64(e.info.ModTime().Unix()),
			})
		} else {
			out = append(out, fileNode(e))
		}
	}
	return out
}

// DirSize is the total size in bytes of every file under `path` (symlinks not
// followed).
//
// `skipNames` are directory names to prune anywhere in the walk - e.g.
// DirSize(home, ".thumbs") to leave a cache out. A user's quota uses the plain
// DirSize(home): .trash included, because a trashed file still occupies the
// disk until the trash is emptied.
func DirSize(path string, skipNames ...string) int64 {
	var total int64
	filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != path && contains(skipNames, d.Name()) {
				// java: returning fs.SkipDir from the callback is how you stop
				// the walk descending - the equivalent of Python's in-place
				// `dirs[:] = [...]` trick on os.walk.
				return fs.SkipDir
			}
			return nil
		}
		if info, err := d.Info(); err == nil && info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total
}

// SharedNode is the virtual "shared" folder - everything OTHER users shared
// with `user`, as one tree node whose children are their real (read-only)
// contents. nil when nothing is shared with them, so the node simply does not
// appear.
//
// There is no `shared` directory on disk: this node is assembled here from the
// grants. Each child keeps the owner's real folder contents but is addressed as
// "shared/<slug>/...", which ResolvePath maps back.
//
// dirsOnly is Drive's left pane, and there it holds only the grants shared AS
// FOLDERS: a trip or an album is a directory on disk but one document to the
// reader. The node itself is still returned whenever ANY grant resolves, even
// with no children at all - it is the only way into the shared area from Drive,
// and the right pane (Shares.RootNodes) lists everything.
func (t *FileTree) SharedNode(user string, dirsOnly bool) *Node {
	kids := []Node{}
	live := 0 // grants whose target still exists

	for _, g := range t.shares.ForUser(user) {
		grant := g
		target := t.shares.RootPath(&grant)
		if target == "" {
			continue
		}
		live++
		rel := "shared/" + grant.Slug

		// A trip or a photo album IS a directory on disk, but to the person
		// reading it it is one document that opens in Trips / Photos - it must
		// not show up as a browsable folder in Drive's left pane. Only a grant
		// shared AS a folder belongs in the folders tree.
		if dirsOnly && grant.App != "folder" {
			continue
		}
		info, err := os.Stat(target)
		if err != nil {
			continue
		}

		var node Node
		switch {
		case info.IsDir():
			node = BuildTree(target, rel, dirsOnly)
		case dirsOnly:
			continue // a shared single file is not a folder
		default:
			node = Node{Path: rel, Nodes: nil,
				Size: ptrInt64(info.Size()), MTime: ptrInt64(info.ModTime().Unix())}
		}
		node.Shared = &SharedBy{By: grant.Owner, Title: grant.Title, App: grant.App}
		kids = append(kids, node)
	}

	// The FOLDERS-ONLY tree (Drive's left pane) must keep the "Compartido
	// conmigo" row even when every grant is a single file and `kids` came out
	// empty: that row is the only way into the shared area from Drive, and
	// clicking it lists the files in the right pane. It just has nothing to
	// expand. The full tree keeps the old rule - no children, no node.
	if len(kids) > 0 || (dirsOnly && live > 0) {
		return &Node{Path: "shared", Nodes: kids}
	}
	return nil
}

// UserTree is the whole virtual root, recursively.
func (t *FileTree) UserTree(role, user string, dirsOnly bool) Node {
	var root Node
	if role == "admin" {
		root = BuildTree(t.baseDir, "", dirsOnly)
	} else {
		home := filepath.Join(t.homesDir, user)
		root = Node{Path: "", Nodes: []Node{}}
		for _, sub := range []string{"data", "files"} {
			d := filepath.Join(home, sub)
			if info, err := os.Stat(d); err == nil && info.IsDir() {
				root.Nodes = append(root.Nodes, BuildTree(d, sub, dirsOnly))
			}
		}
		if shared := t.SharedNode(user, dirsOnly); shared != nil {
			root.Nodes = append(root.Nodes, *shared)
		}
	}
	root.User = user
	root.Role = role
	return root
}

// DirTree is the whole virtual root as a FOLDERS-ONLY recursive tree (no file
// nodes) - what the Drive left pane loads instead of UserTree. Same wrapper
// shape, so the client walks it exactly as before; it just never carries the
// thousands of file nodes a photo library would add.
func (t *FileTree) DirTree(role, user string) Node {
	return t.UserTree(role, user, true)
}

// SearchRoot is one (directory, virtual prefix) pair Search walks.
type SearchRoot struct {
	Dir    string
	Prefix string
}

// Search is a flat name search across one or more roots. It returns the same
// node shape every other listing uses, and whether the hit count reached
// `limit` and the walk stopped early.
//
// Matching is shell-style (`*`, `?`, `[seq]`) on the BASENAME only,
// case-insensitive. Dot-directories (.trash, .bak, ...), half-written temp
// files and symlinks are skipped - the same things every other listing hides.
func Search(roots []SearchRoot, pattern string, limit int) ([]Node, bool) {
	pat := strings.ToLower(pattern)
	out := []Node{}

	for _, root := range roots {
		base, err := filepath.Abs(root.Dir)
		if err != nil {
			continue
		}
		truncated := false

		filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if len(out) >= limit {
				truncated = true
				return filepath.SkipAll
			}
			if p == base {
				return nil
			}
			name := d.Name()

			// Dot-folders and symlinked folders are never descended into. No
			// temp-name test on directories: the server only ever writes temp
			// FILES, so such a name on a folder is the user's own.
			if d.IsDir() {
				if strings.HasPrefix(name, ".") || isSymlink(p) {
					return fs.SkipDir
				}
			} else {
				if strings.HasPrefix(name, ".") || isTempName(name) || isSymlink(p) {
					return nil
				}
			}

			if !fnmatch(strings.ToLower(name), pat) {
				return nil
			}
			rel := virtualPath(base, p, root.Prefix)
			if d.IsDir() {
				out = append(out, Node{Path: rel, Nodes: []Node{}})
			} else {
				info, err := d.Info()
				if err != nil {
					return nil
				}
				out = append(out, fileNode(scanned{name, p, rel, false, info}))
			}
			if len(out) >= limit {
				truncated = true
				return filepath.SkipAll
			}
			return nil
		})

		if truncated {
			return out, true
		}
	}
	return out, false
}

// virtualPath turns an absolute path back into the path the API addresses.
func virtualPath(base, full, prefix string) string {
	rel, err := filepath.Rel(base, full)
	if err != nil {
		return prefix
	}
	rel = filepath.ToSlash(rel)
	if prefix == "" {
		return rel
	}
	return prefix + "/" + rel
}

func isSymlink(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink != 0
}

// -----------------------------------------------------------------------------
// Content types
// -----------------------------------------------------------------------------

// mimeOverrides are the content types Go's table gets wrong, misses, or
// decorates - the same list lib/config.py keeps, for the same reasons.
//
// java: mime.TypeByExtension reads /etc/mime.types on Linux, so the SAME BINARY
// can answer differently on two machines, and it appends "; charset=utf-8" to
// text types where Python's mimetypes does not. Neither is acceptable for a
// server that must behave identically everywhere, so this map wins and
// TypeByExtension is only the fallback.
var mimeOverrides = map[string]string{
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".html":        "text/html; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".ics":         "text/calendar; charset=utf-8",
	".vcf":         "text/vcard; charset=utf-8",
	".svg":         "image/svg+xml",
	".wasm":        "application/wasm",
	".webmanifest": "application/manifest+json",
	".woff2":       "font/woff2",
	// Audio - the Music app's <audio> element needs a real audio/* type to play
	// a file at all.
	".mp3":  "audio/mpeg",
	".m4a":  "audio/mp4",
	".flac": "audio/flac",
	".ogg":  "audio/ogg",
	".oga":  "audio/ogg",
	".opus": "audio/ogg",
	".wav":  "audio/wav",
	".aac":  "audio/aac",
	".weba": "audio/webm",
	// Video - same story for the Movies app's <video> element, plus the .vtt /
	// .srt subtitle sidecars it loads as a <track>.
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".webm": "video/webm",
	".ogv":  "video/ogg",
	".mov":  "video/quicktime",
	".mkv":  "video/x-matroska",
	".vtt":  "text/vtt; charset=utf-8",
	".srt":  "text/plain; charset=utf-8",
}

// ContentType picks the Content-Type for a file name.
func ContentType(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if ct, found := mimeOverrides[ext]; found {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		// java: Go APPENDS "; charset=utf-8" to every text type it guesses;
		// Python's mimetypes never does. Stripping it keeps the two servers
		// sending the same Content-Type for, say, a plain .txt - and the
		// browser sniffs UTF-8 correctly either way.
		if i := strings.Index(ct, ";"); i >= 0 && strings.HasPrefix(ct, "text/") {
			return strings.TrimSpace(ct[:i])
		}
		return ct
	}
	return "application/octet-stream"
}
