package main

// =============================================================================
// The file API's sandbox, enforced by the kernel.
// =============================================================================
//
// ResolvePath decides WHETHER a path is allowed: it follows every symlink and
// checks the result is still inside the caller's root. On its own that check
// has a gap - between the check and the use, another
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
// check approved - a symlink that stays inside the home still works, and
// renaming one moves the file it points at - so os.Root only ADDS a refusal.
//
// Trust: the root itself (a user's home, a shared folder, apps/, the base
// directory) is opened by its plain path. The server makes those and the file
// API never moves a home or the base (isStructuralDir refuses), and nothing in
// the API can create a symlink - so the part that needs the kernel's help is
// the part INSIDE the root, the part a user names. Only the admin panel moves
// a home (rename, delete): open() then refuses a root that is no longer the
// folder the path was approved in.
//
// NOT covered, by choice: the directory listings (filetree.go) still walk by
// path - they are read-only and would need os.Root threaded through every
// walk - and moveOrCopy's copy fallback, taken only when a rename crosses two
// filesystems.

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
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

	// rootID is the folder that WAS at Root when the path was approved (nil:
	// there was none), and epoch the account's counter then (Users.Resolve).
	// open() refuses any other folder, and any after the counter moved - see
	// errRootGone.
	rootID os.FileInfo
	epoch  accountEpoch
}

// accountEpoch is an account's counter (Users.EndRequests) as it was when a
// path in its home was approved. The admin panel moves it on BEFORE it
// creates, renames or deletes a home, so a path approved before never opens
// after - even when a new person's home has the old one's name, and even
// when the disk gave it the old folder's inode number back.
type accountEpoch struct {
	n  *atomic.Uint64 // nil: the root is no account's home (the admin's base, apps/)
	at uint64
}

// moved: the account's home changed hands since the path was approved.
func (e accountEpoch) moved() bool { return e.n != nil && e.n.Load() != e.at }

// errRootGone: the folder a path was approved in is not there any more, or
// another one now has its name - an account the admin renamed or deleted
// while one of its requests was under way, maybe already given to a new
// person. Opening it by name would re-create the old home (a ghost nobody
// sees: the save is lost from view) or write into the new person's (L2), so
// the request fails instead; a save then stays queued in the browser. It
// counts as "not there", as a vanished folder always did - but a handler
// answers it 503, never 404 (sendMissing).
var errRootGone = fmt.Errorf("the folder this path was approved in moved or went: %w", fs.ErrNotExist)

// sendMissing answers a path that is not there: 404 - unless its account's
// home moved or went under the request (errRootGone). That is 503, "try
// again": the browser's store reads a 404 as "no file yet, first run" and
// could then save an empty start over the renamed person's real file. By the
// retry the session is gone (the admin signs the account out first): 401.
func sendMissing(w http.ResponseWriter, r *http.Request, err error, msg string) {
	if errors.Is(err, errRootGone) {
		sendError(w, r, http.StatusServiceUnavailable, "la cuenta acaba de cambiar: vuelve a intentarlo")
		return
	}
	sendError(w, r, http.StatusNotFound, msg)
}

// mkdirInHome makes `dir`, a folder inside homes/<user>/ named by its path,
// through a handle on that home - and NEVER the home itself. A home that is
// missing was renamed or deleted by the admin while this write was under
// way; a plain os.MkdirAll would bring it back as a ghost homes/<old name>/
// that nobody signs in to, and what is saved there is lost from view (L2).
// errRootGone then. A home renamed after the handle opened gets the folder in
// its new place, which is harmless: the caller's write, by the old path,
// then fails.
func mkdirInHome(homesDir, dir string) error {
	rel, err := filepath.Rel(homesDir, dir)
	user, inside, _ := strings.Cut(filepath.ToSlash(rel), "/")
	if err != nil || user == "" || user == "." || user == ".." || inside == "" {
		return fmt.Errorf("%s is not a folder inside a home", dir)
	}
	root, err := os.OpenRoot(filepath.Join(homesDir, user))
	if errors.Is(err, fs.ErrNotExist) {
		return errRootGone
	}
	if err != nil {
		return err
	}
	defer root.Close()
	return root.MkdirAll(filepath.FromSlash(inside), 0o755)
}

// newResolved splits an approved target into its root and the part inside.
//
// A shared SINGLE FILE is its own root, and os.Root opens only folders, so the
// root moves up to its parent. Nothing widens: Rel comes from a target that
// already passed the containment check, so it can only name that one file.
func newResolved(root, target string, writable bool) (Resolved, bool) {
	info, err := os.Stat(root)
	if err == nil && !info.IsDir() {
		root = filepath.Dir(root)
		info, err = os.Stat(root)
	}
	var id os.FileInfo
	if err == nil {
		id = info
	}
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return Resolved{}, false
	}
	return Resolved{Root: root, Rel: rel, Abs: target, Writable: writable, rootID: id}, true
}

// at is another path under the SAME root - the trash can next to a file, the
// restored name beside the original.
func (p Resolved) at(rel string) Resolved {
	rel = filepath.Clean(rel)
	return Resolved{Root: p.Root, Rel: rel, Abs: filepath.Join(p.Root, rel), Writable: p.Writable,
		rootID: p.rootID, epoch: p.epoch}
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
//
// Only the very folder the path was approved in: one missing then, missing
// now, or another folder under its name, is errRootGone (L2) - and so is any
// folder once the account's counter moved. The counter is read AFTER the
// open: unmoved then, the handle is the old folder. Once open, the handle
// follows the folder - a write under way when the admin renames the account
// lands in the renamed home, where it belongs.
func (p Resolved) open() (*os.Root, error) {
	if p.rootID == nil {
		return nil, errRootGone
	}
	root, err := os.OpenRoot(p.Root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errRootGone
	}
	if err != nil {
		return nil, err
	}
	if now, err := root.Stat("."); err != nil || !os.SameFile(p.rootID, now) || p.epoch.moved() {
		root.Close()
		return nil, errRootGone
	}
	return root, nil
}

// openCreating is open() for a write. It NEVER makes the root itself: a home
// that is missing was renamed or deleted by the admin since this request was
// let in, and making it again would put the save in a ghost homes/<old name>/
// (L2, server-writes #5). What a write needs below the root, it makes inside
// it (root.MkdirAll).
func (p Resolved) openCreating() (*os.Root, error) {
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

// renameResolved is os.Rename, inside one root. It REPLACES what is at dst:
// only for a case-only rename of one file (sameResolved). Every other move
// goes through renameResolvedNoReplace.
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

// renameResolvedNoReplace is renameNoReplace through the sandbox.
func renameResolvedNoReplace(src, dst Resolved) error {
	if src.Root != dst.Root {
		return errCrossRoot
	}
	root, err := src.open()
	if err != nil {
		return err
	}
	defer root.Close()
	return renameNoReplace(root, src.Rel, dst.Rel)
}

// testPlaceHook is for tests only (nil in the server). renameNoReplace calls
// it just before the link (linked false: a test puts a file at `to`) and just
// after it (linked true: a test saves a new file at `from`) - the instants no
// earlier check can see - to prove neither file is lost.
var testPlaceHook atomic.Pointer[func(root *os.Root, from, to string, linked bool)]

// renameNoReplace moves `from` to `to` and NEVER replaces what is at `to`: a
// taken name answers fs.ErrExist and nothing moves. A plain rename destroys
// the file at `to` with no trip through the papelera, and a "free?" check
// before it leaves a window in which a save, an upload or a phone's photo
// lands there and is lost (data-safety D10).
//
// A file (or a link) goes by hard link + unlink: link fails on a taken name,
// in the kernel, with no window; the inode stays the same, as with a rename
// (a kept Chat photo still finds it). Should the unlink fail, both names
// stay - a duplicate, never a loss - and errSourceLeft says so: the file IS
// in place.
//
// The two steps are not one, as a rename is: a save that lands at `from`
// between them (an upload's rename, a server write) is a NEW file there, and
// unlinking it would lose it. So `from` goes only while it is still the file
// that was linked - else it stays, as if saved just after a rename. That
// check and the unlink are two steps too; what closes the last instant is
// the path's lockPath stripe, held by the callers that move a user's own
// path (filesMove, Trash.MoveIn) and by every writer that renames over one:
// uploads, the Office twin, setCardPhoto, a trip's positions.json. The
// server's other own files (a device's last position, the reminders' sent
// keys, Bookmarks' icons) take no stripe: Drive does not move or bin them
// while they are written, short of a user doing so by hand that instant.
//
// The rest goes the old way, a check and then the rename: a folder (no hard
// links to folders), and a disk that refuses hard links (FAT external
// storage, a cross-disk pair - the caller still sees EXDEV). For a folder the
// rename itself fails onto a folder with something in it (ENOTEMPTY, which
// errors.Is counts as fs.ErrExist) or onto a file; the one case left in the
// window is an EMPTY folder made there meanwhile, which nothing is lost with.
func renameNoReplace(root *os.Root, from, to string) error {
	info, err := root.Lstat(from)
	if err != nil {
		return err
	}
	hook := testPlaceHook.Load()
	test := func(linked bool) {
		if hook != nil {
			(*hook)(root, from, to, linked)
		}
	}
	if !info.IsDir() {
		test(false)
		err := root.Link(from, to)
		if err == nil {
			test(true)
			if now, err := root.Lstat(from); err != nil || !os.SameFile(info, now) {
				return nil // moved; what is at `from` now is a newer file
			}
			if err := root.Remove(from); err != nil {
				return fmt.Errorf("%w: %v", errSourceLeft, err)
			}
			return nil
		}
		if errors.Is(err, fs.ErrExist) {
			return err
		}
		// No hard links here: the check-then-rename below.
	}
	if _, err := root.Lstat(to); err == nil {
		return fs.ErrExist
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if info.IsDir() {
		test(false) // a folder's window: after the look, before the rename
	}
	err = root.Rename(from, to)
	if errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.EISDIR) {
		// A folder onto a FILE made there since the look (or the reverse):
		// the name is taken, as the caller is told for any other clash.
		if _, lerr := root.Lstat(to); lerr == nil {
			return fs.ErrExist
		}
	}
	return err
}

// errSourceLeft: renameNoReplace put the file at its new name, but its old
// name could not be removed - both hold it. For a temp or a part (an upload,
// the mp4, the Office twin, a phone's photo) that is a success: the file is
// saved, and the temp's name goes later (the deferred remove, or the startup
// sweep: a temp with a second name is only that). For a user's own path it
// stays an error: the file shows in both places.
var errSourceLeft = errors.New("placed, but the old name could not be removed")

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
