// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// The trash can ("papelera").
// =============================================================================
//
// Deleting in Drive does not remove anything straight away: the file or folder
// is moved (a plain rename, so it is instant and never a copy) into a hidden
// .trash directory, and a small index.json remembers where it came from and
// when it went. From there it can be listed, restored, or permanently removed,
// and anything older than trash_days is swept away on its own.
//
// Layout:
//
//	.trash/
//	    index.json      { "<entryId>": {orig, name, deleted, dir, size}, ... }
//	    <entryId>       the moved file or folder
//
// entryId is "<epoch>-<8 hex>" - unique, so two files with the same name never
// collide inside the trash.
//
// The trash directory lives:
//
//	regular user:  homes/<user>/.trash/
//	admin:         <base_dir>/.trash/
//
// It is never reachable through the normal file API: ResolvePath refuses any
// path with a ".trash" segment, and everything here is driven by validated
// entryIds instead.

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// entryRE is the entryId shape: one-or-more digits, a dash, exactly 8 lowercase
// hex characters. Every public function re-validates the caller-supplied id
// against this before touching a path - defence in depth even though ids are
// server-made.
var entryRE = regexp.MustCompile(`^\d+-[0-9a-f]{8}$`)

// TrashEntry is one row of index.json.
//
// java: Size is a POINTER so it can marshal as `null`, which is what "not
// measured yet" means for a folder - the walk that measures it is done lazily
// by List and then written back.
type TrashEntry struct {
	Orig    string `json:"orig"`
	Name    string `json:"name"`
	Deleted int64  `json:"deleted"`
	Dir     bool   `json:"dir"`
	Size    *int64 `json:"size"`
}

// TrashItem is one row as the Papelera app sees it.
type TrashItem struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Orig    string `json:"orig"`
	Deleted int64  `json:"deleted"`
	Dir     bool   `json:"dir"`
	Size    int64  `json:"size"`
}

// trashIndex is .trash/index.json, KEEPING THE ORDER OF ITS KEYS
// (orderedjson.go).
//
// java: a Go map has no order at all - `for k := range m` is deliberately
// randomised, so two consecutive reads of the same trash can came back in
// different orders whenever two items shared a deletion second, and the
// Papelera list jumped around under the user. The listing must be
// chronological and steady: the key order is captured on read and written
// back out in that order, new entries appended at the end.
type trashIndex = orderedMap[TrashEntry]

func newTrashIndex() *trashIndex {
	return &trashIndex{rows: make(map[string]TrashEntry), kind: "trash index"}
}

// Trash owns every trash can on the box.
//
// java: one mutex for ALL cans. It serialises every index.json read-modify-write; the expensive folder walks
// deliberately happen OUTSIDE it (see List).
type Trash struct {
	mu       sync.Mutex
	baseDir  string
	homesDir string
	users    *Users
	log      Logger
}

func NewTrash(baseDir, homesDir string, users *Users, log Logger) *Trash {
	return &Trash{baseDir: baseDir, homesDir: homesDir, users: users, log: log}
}

// Dir is the .trash directory for this caller.
func (t *Trash) Dir(role, user string) string {
	if role == "admin" {
		return filepath.Join(t.baseDir, ".trash")
	}
	return filepath.Join(t.homesDir, user, ".trash")
}

func indexPath(tdir string) string { return filepath.Join(tdir, "index.json") }

// errTrashDamaged: the can's index.json is there but cannot be read or parsed.
var errTrashDamaged = errors.New("trash: index.json cannot be read")

// loadIndex reads one can's index. A missing index is an empty trash. One that
// is there but cannot be read (EIO, EACCES, EMFILE on a busy server) or does
// not parse is an ERROR, never "empty": every operation saves what it loaded,
// so an empty reading written back would drop every row - the items stay in
// .trash/ but nothing lists or restores them, and the sweep purges them later
// (F2). The caller refuses the operation and the file is left as it is, for
// the admin to repair (the log names it).
func (t *Trash) loadIndex(tdir string) (*trashIndex, error) {
	index := newTrashIndex()
	if _, err := readJSONStrict(indexPath(tdir), index); err != nil {
		t.log.Error("trash: index.json cannot be read - the bin is left as it is", "file", indexPath(tdir), "err", err)
		return nil, fmt.Errorf("%w: %v", errTrashDamaged, err)
	}
	return index, nil
}

// saveIndex writes the can's index into a can that is THERE: it never makes
// the folder. Only moveIn makes a can, through the home's own handle. Made
// here by path, a delete or a restore under way when the admin renamed or
// deleted the account brought back homes/<old name>/.trash - a ghost home
// (L2). A can that is missing now fails the write (ENOENT) instead.
func saveIndex(tdir string, index *trashIndex) error {
	return atomicWriteJSON(indexPath(tdir), index, 2)
}

// newEntryID is "<unix seconds>-<8 hex digits>".
func newEntryID() string {
	raw := make([]byte, 4)
	rand.Read(raw)
	return itoa64(time.Now().Unix()) + "-" + hex.EncodeToString(raw)
}

// -----------------------------------------------------------------------------
// delete -> trash
// -----------------------------------------------------------------------------

// MoveIn moves one already-resolved path into the caller's trash. `origRel` is
// the virtual path the file API used (e.g. "files/a/b.txt"), kept for restore.
//
// CRASH-SAFE ORDERING: the index row is written FIRST, then the file is moved,
// both under the lock. If the process dies between the two, the row points at a
// file still in its ORIGINAL place - the delete just did not happen, nothing is
// lost, and List / SweepExpired drop the stale row on their next run. (The old
// order - move first, index second - could leave a file in .trash that no row
// referenced: invisible forever and still eating disk.)
func (t *Trash) MoveIn(role, user string, p Resolved, origRel string) (string, error) {
	return t.moveIn(role, user, p, origRel, nil)
}

// errNotSameFile: MoveInIfSame found another file at the path.
var errNotSameFile = errors.New("the path holds another file now")

// MoveInIfSame is MoveIn of the file `was` only: when the path holds another
// file by now, nothing moves and errNotSameFile is answered. The look is made
// under the path's stripe, right before the move, so no save can land in
// between and be binned in its place (D11: the converter's original).
func (t *Trash) MoveInIfSame(role, user string, p Resolved, origRel string, was os.FileInfo) (string, error) {
	return t.moveIn(role, user, p, origRel, was)
}

func (t *Trash) moveIn(role, user string, p Resolved, origRel string, was os.FileInfo) (string, error) {
	tdir := t.Dir(role, user)
	// The can sits inside the file's own root - a user's in their home, the
	// admin's in the base - so the move is one rename through the sandbox.
	trashRel, ok := p.relTo(tdir)
	if !ok {
		return "", errCrossRoot
	}
	// Made through that root, never by path: a home the admin renamed or
	// deleted under this request is errRootGone, not a ghost homes/<old>/
	// (L2). The file stays where it is.
	if err := p.at(trashRel).MkdirAll(); err != nil {
		return "", err
	}

	entryID := newEntryID()
	dest := p.at(filepath.Join(trashRel, entryID))

	info, err := p.Lstat()
	if err != nil {
		return "", err
	}
	isDir := info.IsDir()
	// A file's size is one stat, known up front. A folder's needs a full walk,
	// which List does lazily (once) and stores back here.
	var size *int64
	if !isDir {
		size = ptrInt64(info.Size())
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	index, err := t.loadIndex(tdir)
	if err != nil {
		return "", err // the item stays where it is: nothing is lost
	}
	index.Set(entryID, TrashEntry{
		Orig:    origRel,
		Name:    filepath.Base(p.Abs),
		Deleted: time.Now().Unix(),
		Dir:     isDir,
		Size:    size,
	})
	if err := saveIndex(tdir, index); err != nil {
		return "", err
	}

	// The file's upload stripe (lockPath, upload.go), so a save of it cannot
	// land between the link and the unlink of the move and go with it. Order:
	// t.mu, then the stripe - nothing holding a stripe calls into the bin.
	unlock := lockPath(p.Abs)
	err = nil
	if was != nil {
		if now, serr := p.Stat(); serr != nil || !os.SameFile(was, now) {
			err = errNotSameFile
		}
	}
	if err == nil {
		err = moveResolved(p, dest)
	}
	unlock()
	if err != nil {
		// A failed move must never leave a dangling row: roll it back.
		index.Remove(entryID)
		saveIndex(tdir, index)
		return "", err
	}

	t.log.Info("trash: moved in", "orig", origRel, "id", entryID, "who", whoever(user))
	return entryID, nil
}

// -----------------------------------------------------------------------------
// listing
// -----------------------------------------------------------------------------

// List is every trashed item, newest first. Rows whose file has vanished are
// dropped from the index on the way out - only those whose file is really not
// there (fs.ErrNotExist): any other error keeps the row. An index that cannot
// be read is an error (loadIndex), never an empty bin.
func (t *Trash) List(role, user string) ([]TrashItem, error) {
	tdir := t.Dir(role, user)

	type alive struct {
		id    string
		entry TrashEntry
		path  string
	}
	var live []alive

	t.mu.Lock()
	index, err := t.loadIndex(tdir)
	if err != nil {
		t.mu.Unlock()
		return nil, err
	}
	changed := false
	for _, id := range index.keys() { // file order, so ties stay chronological
		entry, _ := index.Get(id)
		p := filepath.Join(tdir, id)
		if !entryRE.MatchString(id) {
			index.Remove(id)
			changed = true
			continue
		}
		if _, err := os.Lstat(p); errors.Is(err, fs.ErrNotExist) {
			index.Remove(id)
			changed = true
			continue
		}
		live = append(live, alive{id, entry, p})
	}
	if changed {
		saveIndex(tdir, index)
	}
	t.mu.Unlock()

	// Measuring a trashed FOLDER means a full directory walk. Do it AFTER
	// releasing the lock: otherwise trashing a folder of thousands of photos
	// and then opening the Papelera freezes every other trash operation - for
	// every user - for the length of that walk. And do it ONCE: a trashed item
	// never changes, so the result is written back into the index and every
	// later listing just reads it.
	items := []TrashItem{}
	learned := make(map[string]int64)
	for _, a := range live {
		var size int64
		if a.entry.Size != nil && *a.entry.Size >= 0 {
			size = *a.entry.Size
		} else {
			info, err := os.Lstat(a.path)
			if err != nil {
				continue // purged between the unlock and here
			}
			if info.IsDir() {
				size = DirSize(a.path)
			} else {
				size = info.Size()
			}
			learned[a.id] = size
		}
		name := a.entry.Name
		if name == "" {
			name = a.id
		}
		items = append(items, TrashItem{
			ID: a.id, Name: name, Orig: a.entry.Orig,
			Deleted: a.entry.Deleted, Dir: a.entry.Dir, Size: size,
		})
	}

	if len(learned) > 0 {
		t.mu.Lock()
		// re-read: it may have changed meanwhile (and a failed read writes nothing)
		if index, err := t.loadIndex(tdir); err == nil {
			for id, size := range learned {
				if entry, found := index.Get(id); found {
					entry.Size = ptrInt64(size)
					index.Set(id, entry)
				}
			}
			saveIndex(tdir, index)
		}
		t.mu.Unlock()
	}

	sort.SliceStable(items, func(i, j int) bool { return items[i].Deleted > items[j].Deleted })
	return items, nil
}

// Size is the total bytes sitting in this caller's trash. It reuses List, so the
// per-item sizes already cached in index.json are not re-measured. A can whose
// index cannot be read counts 0: Drive's disk figure must still answer.
func (t *Trash) Size(role, user string) int64 {
	var total int64
	items, _ := t.List(role, user)
	for _, it := range items {
		total += it.Size
	}
	return total
}

// -----------------------------------------------------------------------------
// restore
// -----------------------------------------------------------------------------

// restoreTarget is where an entry goes back to, or false when it cannot go
// back at all.
func (t *Trash) restoreTarget(role, user, origRel string) (Resolved, bool) {
	if origRel == "" {
		// A corrupted index row: no way to know where it came from - never fall
		// back to a root.
		return Resolved{}, false
	}
	target, ok := t.users.Resolve(role, user, origRel)
	if !ok || !target.Writable {
		return Resolved{}, false
	}
	return target, true
}

// restoredName is the n-th name tried for an item whose original name is
// taken: "a (restaurado <stamp>).txt", then "a (restaurado <stamp> 2).txt"
// and on (a folder, or a name with no extension, keeps its whole name first).
func restoredName(base string, isDir bool, stamp string, n int) string {
	ext := filepath.Ext(base)
	if isDir {
		ext = ""
	}
	tag := " (restaurado " + stamp + ")"
	if n > 1 {
		tag = " (restaurado " + stamp + " " + strconv.Itoa(n) + ")"
	}
	return strings.TrimSuffix(base, ext) + tag + ext
}

// placeRestored moves `from` (the item in the can) back to `target` or, that
// name taken, to the first free restoredName, and answers the new name (""
// when it went back in place). NEVER over anything: two items of one name
// restored in the same second both got the same "(restaurado <second>)" name
// and the second rename replaced the first, already out of the index - gone
// for good (D8). A name taken in the very instant of the move is caught by
// renameNoReplace and the next name is tried.
func placeRestored(from, target Resolved, isDir bool) (string, error) {
	err := moveResolved(from, target)
	if !errors.Is(err, fs.ErrExist) {
		return "", err
	}
	stamp := time.Now().Format("2006-01-02-150405")
	for n := 1; n < 1000; n++ {
		name := restoredName(filepath.Base(target.Rel), isDir, stamp, n)
		err := moveResolved(from, target.at(filepath.Join(filepath.Dir(target.Rel), name)))
		if !errors.Is(err, fs.ErrExist) {
			return name, err
		}
	}
	return "", fs.ErrExist
}

// Restore moves the given entryIds back to where they came from. It returns the
// names that had to be renamed because their original path was occupied, or
// an error when the index cannot be read (nothing moves then).
func (t *Trash) Restore(role, user string, ids []string) ([]string, error) {
	tdir := t.Dir(role, user)
	renamed := []string{}

	t.mu.Lock()
	defer t.mu.Unlock()

	index, err := t.loadIndex(tdir)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if !entryRE.MatchString(id) {
			continue
		}
		entry, found := index.Get(id)
		if !found {
			continue
		}
		src := filepath.Join(tdir, id)
		info, err := os.Lstat(src)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) { // only a row whose item is really gone
				index.Remove(id)
			}
			continue
		}

		dest, ok := t.restoreTarget(role, user, entry.Orig)
		if !ok {
			t.log.Warn("trash: cannot restore (bad orig)", "id", id)
			continue
		}
		// The can sits inside the same root as the place the item goes back
		// to, so this too is one rename through the sandbox.
		trashRel, inside := dest.relTo(tdir)
		if !inside {
			t.log.Warn("trash: cannot restore (outside its root)", "id", id)
			continue
		}
		dest.MkdirParent()
		newName, err := placeRestored(dest.at(filepath.Join(trashRel, id)), dest, info.IsDir())
		if err != nil {
			t.log.Warn("trash: restore failed", "id", id, "err", err)
			continue
		}
		index.Remove(id)
		if newName != "" {
			renamed = append(renamed, newName)
		}
		t.log.Info("trash: restored", "id", id, "to", dest.Abs, "as", newName)
	}
	saveIndex(tdir, index)
	return renamed, nil
}

// -----------------------------------------------------------------------------
// permanent delete
// -----------------------------------------------------------------------------

// Purge really deletes. A nil `ids` empties the whole can. An index that
// cannot be read is an error, and nothing is deleted.
func (t *Trash) Purge(role, user string, ids []string) (int, error) {
	tdir := t.Dir(role, user)
	if info, err := os.Stat(tdir); err != nil || !info.IsDir() {
		return 0, nil
	}

	t.mu.Lock()
	index, err := t.loadIndex(tdir)
	if err != nil {
		t.mu.Unlock()
		return 0, err
	}
	wanted := ids
	if wanted == nil {
		wanted = index.keys()
	}
	n := 0
	for _, id := range wanted {
		if !entryRE.MatchString(id) {
			continue
		}
		p := filepath.Join(tdir, id)
		if _, err := os.Lstat(p); err == nil {
			os.RemoveAll(p) // recursive; a plain file goes the same way
			n++
		}
		index.Remove(id)
	}
	saveIndex(tdir, index)
	t.mu.Unlock()

	if n > 0 && role == "user" {
		// A user's trash sits inside their home, so those bytes counted against
		// the quota until now: the cached figure must be measured again. (The
		// admin trash is outside every home - purging it changes no quota.)
		t.users.ForgetUsage(user)
	}
	t.log.Info("trash: purged", "count", n, "who", whoever(user))
	return n, nil
}

// -----------------------------------------------------------------------------
// auto-expiry
// -----------------------------------------------------------------------------

// SweepExpired purges every trashed item past its retention period across all
// trash cans. Each regular user's period comes from their own config.json; the
// admin trash and anyone without a value use `defaultDays`. Called once a day
// from the background loop.
func (t *Trash) SweepExpired(defaultDays int) {
	// Enforce the 90-day ceiling even if config/server.json was hand-edited
	// higher. A negative default is left alone: it means "keep forever".
	if defaultDays > TrashDaysMax {
		defaultDays = TrashDaysMax
	}

	type can struct {
		dir  string
		days int
	}
	cans := []can{{filepath.Join(t.baseDir, ".trash"), defaultDays}}

	if entries, err := os.ReadDir(t.homesDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			// A config.json that cannot be read says nothing about this
			// person's days - not even "keep for ever" (-1): skip the can
			// rather than purge it by the default.
			if t.users.ConfigDamaged(e.Name()) {
				t.log.Error("trash: config.json cannot be read - the bin is not swept", "user", e.Name())
				continue
			}
			days := defaultDays
			if d := t.users.UserTrashDays(e.Name()); d != nil {
				days = *d
			}
			cans = append(cans, can{filepath.Join(t.homesDir, e.Name(), ".trash"), days})
		}
	}

	now := time.Now()
	freed := false
	for _, c := range cans {
		if info, err := os.Stat(c.dir); err != nil || !info.IsDir() {
			continue
		}
		// A negative value disables the sweep; a hand-edited 0 must not purge
		// the whole can.
		if c.days < 1 {
			continue
		}
		cutoff := now.Add(-time.Duration(c.days) * 24 * time.Hour).Unix()

		t.mu.Lock()
		index, err := t.loadIndex(c.dir)
		if err != nil {
			// Nothing is swept from a can whose index cannot be read: the
			// orphan pass below would take every item it lists (F2).
			t.mu.Unlock()
			continue
		}
		gone := 0
		for _, id := range index.keys() {
			entry, _ := index.Get(id)
			// A row with no timestamp counts as epoch 0 => always expired.
			if entryRE.MatchString(id) && entry.Deleted < cutoff {
				os.RemoveAll(filepath.Join(c.dir, id))
				index.Remove(id)
				gone++
			}
		}
		// Also drop entries whose file is already gone (and only those).
		for _, id := range index.keys() {
			if _, err := os.Lstat(filepath.Join(c.dir, id)); errors.Is(err, fs.ErrNotExist) {
				index.Remove(id)
			}
		}

		// And the mirror of that case: an item ON DISK with no row in
		// index.json - a can whose index was lost, truncated or hand-edited.
		// Nothing lists it, nothing restores it, and until now nothing removed
		// it either: it sat there forever, holding disk against the quota.
		//
		// No row is needed to judge it. The entryId IS the deletion time
		// ("<epoch>-<8 hex>"), so the same cutoff applies - and that is the
		// right clock: how long the item has been in the bin, never the file's
		// own timestamp, which a move into .trash leaves untouched.
		if entries, err := os.ReadDir(c.dir); err == nil {
			for _, e := range entries {
				id := e.Name()
				if !entryRE.MatchString(id) {
					continue // index.json, or something that was never ours
				}
				if _, found := index.Get(id); found {
					continue
				}
				stamp, _, _ := strings.Cut(id, "-")
				// An id whose epoch will not parse is left alone: a stuck file
				// is better than a wrong deletion.
				if epoch, err := strconv.ParseInt(stamp, 10, 64); err == nil && epoch < cutoff {
					os.RemoveAll(filepath.Join(c.dir, id))
					gone++
				}
			}
		}
		saveIndex(c.dir, index)
		t.mu.Unlock()

		if gone > 0 {
			freed = true
			t.log.Info("trash: swept expired items", "count", gone, "can", c.dir)
		}
	}

	if freed {
		// Freed real disk -> every cached usage figure is now too high.
		t.users.ForgetUsage("")
	}
}

// -----------------------------------------------------------------------------
// small helpers
// -----------------------------------------------------------------------------

// moveResolved is moveOrCopy through the sandbox: a rename inside one root,
// and the copy fallback - by path, see sandbox.go - only when that rename has
// to cross two filesystems. It never replaces what is at dst (fs.ErrExist):
// the bin's own new entry is always free, and a restore must never land on a
// file of that name (D8).
func moveResolved(src, dst Resolved) error {
	err := renameResolvedNoReplace(src, dst)
	if err == nil || !isCrossDevice(err) {
		return err
	}
	return moveOrCopy(src.Abs, dst.Abs)
}

// moveOrCopy renames, falling back to copy-then-delete when the two paths sit
// on different filesystems.
//
// java: Go's os.Rename just fails with EXDEV across filesystems, for a file
// and for a whole directory tree, so the fallback is written out here.
//
// It is not a theoretical path: the admin's trash is <base>/.trash while a home
// could sit on its own mount. A rename within one filesystem stays what it
// always was - instant, and never a copy.
//
// Never over anything at dst (D8): the copy starts with a Mkdir / an O_EXCL
// create, which fail on a taken name - and then nothing of it is removed,
// since it is not ours. (moveResolved has already tried the no-replace
// rename; only an EXDEV gets here.)
func moveOrCopy(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		var made madePaths
		if err := copyTree(src, dst, &made); err != nil {
			// A half-copied tree is worse than none: what this copy made goes
			// again and the failure is reported, the original left exactly
			// where it was. ONLY what it made: a restored folder shows in
			// Drive while it copies, and a file put in it meanwhile stays (G5).
			made.undo()
			return err
		}
		return os.RemoveAll(src)
	}
	if err := copyFile(src, dst, info.Mode()); err != nil {
		return err // copyFile removed what it made, and only that
	}
	return os.Remove(src)
}

// madePaths is madeHere (copy.go) by absolute path, for the bin's cross-disk
// copy: everything one copy made, with what it was, to take back on failure.
type madePaths []madeFile

// note records one path the copy has just made (a nil list notes nothing).
func (m *madePaths) note(p string) {
	if m == nil {
		return
	}
	if info, err := os.Lstat(p); err == nil {
		*m = append(*m, madeFile{p, info})
	}
	if hook := testMadeHook.Load(); hook != nil {
		(*hook)(p)
	}
}

// undo removes what was noted, newest first: each only while its path still
// holds that same thing, a folder only once empty.
func (m madePaths) undo() {
	for i := len(m) - 1; i >= 0; i-- {
		if now, err := os.Lstat(m[i].rel); err == nil && os.SameFile(m[i].info, now) {
			os.Remove(m[i].rel) // fails on a folder that is not empty
		}
	}
}

// copyTree copies a directory recursively into dst, which it MAKES (Mkdir: a
// taken name is refused, never merged into). Symlinks are copied AS LINKS,
// never followed - the same rule every listing in this server follows.
// `made` (nil: not kept) notes everything it makes.
func copyTree(src, dst string, made *madePaths) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if err := os.Mkdir(dst, info.Mode().Perm()); err != nil {
		return err
	}
	made.note(dst)
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		from, to := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		entryInfo, err := e.Info()
		if err != nil {
			return err
		}
		switch {
		case entryInfo.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(from)
			if err != nil {
				return err
			}
			if err := os.Symlink(target, to); err != nil {
				return err
			}
			made.note(to)
		case entryInfo.IsDir():
			if err := copyTree(from, to, made); err != nil {
				return err
			}
		case entryInfo.Mode().IsRegular():
			if err := copyFile(from, to, entryInfo.Mode()); err != nil {
				return err // copyFile removed its own half copy
			}
			made.note(to)
		}
		// Anything else - a socket, a device - is not a user's document and is
		// simply not carried across.
	}
	return nil
}

// copyFile makes dst - O_EXCL: a name already taken is refused, never
// written over (D8) - and on a failure removes the half copy it made.
func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode.Perm())
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(dst)
	}
	return err
}

func whoever(user string) string {
	if user == "" {
		return "admin"
	}
	return user
}
