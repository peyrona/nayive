package main

// =============================================================================
// The file API's sandbox, enforced by the kernel.
// =============================================================================
//
// ResolvePath decides WHETHER a path is allowed: it follows every symlink and
// checks the result is still inside the caller's root. That is the Python's
// check, and on its own it has a gap - between the check and the use, another
// process could swap a folder for a symlink pointing out of the root, and a
// plain os.Open would follow it.
//
// So every operation on an approved path goes through os.Root instead: the root
// is opened as a directory handle and the kernel resolves the path INSIDE it,
// refusing any step (a "..", an absolute link, a link out) that would leave.
// The check and the use can no longer disagree.
//
// The path handed to os.Root is the ALREADY-RESOLVED one, relative to the
// resolved root. That keeps every operation landing on exactly the file the
// Python would touch - a symlink that stays inside the home still works, and
// renaming one moves the file it points at - so os.Root only ADDS a refusal.
//
// Trust: the root itself (a user's home, a shared folder, apps/, the base
// directory) is opened by its plain path. The server makes those and the file
// API never moves a home or the base (isStructuralDir refuses), and nothing in
// the API can create a symlink - so the part that needs the kernel's help is
// the part INSIDE the root, the part a user names.
//
// NOT covered, by choice: the directory listings (filetree.go) still walk by
// path - they are read-only and would need os.Root threaded through every
// walk - and moveOrCopy's copy fallback, taken only when a rename crosses two
// filesystems.

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// errCrossRoot is a rename whose two ends sit under different roots. os.Root
// cannot do that in one step, and nothing the file API allows ever asks for it.
var errCrossRoot = errors.New("the two paths are in different sandboxes")

// Resolved is a path the sandbox approved.
//
// java: a small VALUE type, passed by copy. Abs is there for logs, for
// comparisons (isStructuralDir, HomeOwner) and for the usage bookkeeping -
// never to open anything; every open goes through Root + Rel.
type Resolved struct {
	Root     string // the folder os.Root is opened on; absolute, symlinks resolved
	Rel      string // the path inside Root; "." is Root itself
	Abs      string // Root joined with Rel
	Writable bool
}

// newResolved splits an approved target into its root and the part inside.
//
// A shared SINGLE FILE is its own root, and os.Root opens only folders, so the
// root moves up to its parent. Nothing widens: Rel comes from a target that
// already passed the containment check, so it can only name that one file.
func newResolved(root, target string, writable bool) (Resolved, bool) {
	if info, err := os.Stat(root); err == nil && !info.IsDir() {
		root = filepath.Dir(root)
	}
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return Resolved{}, false
	}
	return Resolved{Root: root, Rel: rel, Abs: target, Writable: writable}, true
}

// at is another path under the SAME root - the trash can next to a file, the
// restored name beside the original.
func (p Resolved) at(rel string) Resolved {
	rel = filepath.Clean(rel)
	return Resolved{Root: p.Root, Rel: rel, Abs: filepath.Join(p.Root, rel), Writable: p.Writable}
}

// relTo is where an absolute path sits inside p's root, or false when it does
// not sit there at all.
func (p Resolved) relTo(abs string) (string, bool) {
	real, err := resolveExisting(abs)
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(p.Root, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return rel, true
}

// open opens the root. The caller closes it; a file opened through it stays
// valid after that.
func (p Resolved) open() (*os.Root, error) { return os.OpenRoot(p.Root) }

// openCreating is open() for a write: a home that is somehow missing is made
// first, as the plain os.MkdirAll this replaces used to do on its way down.
func (p Resolved) openCreating() (*os.Root, error) {
	if err := os.MkdirAll(p.Root, 0o755); err != nil {
		return nil, err
	}
	return p.open()
}

func (p Resolved) Stat() (os.FileInfo, error) {
	root, err := p.open()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return root.Stat(p.Rel)
}

func (p Resolved) Lstat() (os.FileInfo, error) {
	root, err := p.open()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return root.Lstat(p.Rel)
}

func (p Resolved) Exists() bool {
	_, err := p.Lstat()
	return err == nil
}

func (p Resolved) Open() (*os.File, error) {
	root, err := p.open()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return root.Open(p.Rel)
}

func (p Resolved) MkdirAll() error {
	root, err := p.openCreating()
	if err != nil {
		return err
	}
	defer root.Close()
	return root.MkdirAll(p.Rel, 0o755)
}

// MkdirParent makes the folder p will land in.
func (p Resolved) MkdirParent() error { return p.at(filepath.Dir(p.Rel)).MkdirAll() }

func (p Resolved) Remove() error {
	root, err := p.open()
	if err != nil {
		return err
	}
	defer root.Close()
	return root.Remove(p.Rel)
}

// renameResolved is os.Rename, inside one root.
func renameResolved(src, dst Resolved) error {
	if src.Root != dst.Root {
		return errCrossRoot
	}
	root, err := src.open()
	if err != nil {
		return err
	}
	defer root.Close()
	return root.Rename(src.Rel, dst.Rel)
}

// sameResolved is sameFile through the sandbox: a pure case-change on a
// case-insensitive filesystem, where a "move" would delete the source.
func sameResolved(a, b Resolved) bool {
	ai, err := a.Lstat()
	if err != nil {
		return false
	}
	bi, err := b.Lstat()
	if err != nil {
		return false
	}
	return os.SameFile(ai, bi)
}
