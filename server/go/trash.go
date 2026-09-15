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
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
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

// trashIndex is .trash/index.json, KEEPING THE ORDER OF ITS KEYS.
//
// java: a Go map has no order at all - `for k := range m` is deliberately
// randomised, so two consecutive reads of the same trash can came back in
// different orders whenever two items shared a deletion second, and the
// Papelera list jumped around under the user. Python's dict keeps insertion
// order and its sort is stable, so its listing is chronological and steady.
//
// This type is the smallest thing that buys the same: the key order is captured
// on read and written back out in that order, new entries appended at the end.
type trashIndex struct {
	order []string
	rows  map[string]TrashEntry
}

func newTrashIndex() *trashIndex {
	return &trashIndex{rows: make(map[string]TrashEntry)}
}

func (ix *trashIndex) get(id string) (TrashEntry, bool) {
	row, found := ix.rows[id]
	return row, found
}

func (ix *trashIndex) set(id string, row TrashEntry) {
	if _, found := ix.rows[id]; !found {
		ix.order = append(ix.order, id)
	}
	ix.rows[id] = row
}

func (ix *trashIndex) remove(id string) {
	if _, found := ix.rows[id]; !found {
		return
	}
	delete(ix.rows, id)
	kept := ix.order[:0]
	for _, k := range ix.order {
		if k != id {
			kept = append(kept, k)
		}
	}
	ix.order = kept
}

// keys is the ids in file order - the one safe way to iterate this type.
func (ix *trashIndex) keys() []string {
	out := make([]string, len(ix.order))
	copy(out, ix.order)
	return out
}

// UnmarshalJSON captures the order the keys appear in the file.
//
// java: a Decoder reading TOKEN BY TOKEN is how you see the raw key sequence;
// unmarshalling straight into a map throws it away before you can look.
func (ix *trashIndex) UnmarshalJSON(data []byte) error {
	ix.order = nil
	ix.rows = make(map[string]TrashEntry)

	dec := json.NewDecoder(bytes.NewReader(data))
	open, err := dec.Token()
	if err != nil {
		return err
	}
	if delim, ok := open.(json.Delim); !ok || delim != '{' {
		return errors.New("the trash index is not a JSON object")
	}
	for dec.More() {
		keyToken, err := dec.Token()
		if err != nil {
			return err
		}
		key, ok := keyToken.(string)
		if !ok {
			return errors.New("a trash index key is not a string")
		}
		var row TrashEntry
		if err := dec.Decode(&row); err != nil {
			return err
		}
		ix.set(key, row)
	}
	_, err = dec.Token() // the closing brace
	return err
}

// MarshalJSON writes the entries back in that same order.
func (ix trashIndex) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, id := range ix.order {
		if i > 0 {
			buf.WriteByte(',')
		}
		key, err := json.Marshal(id)
		if err != nil {
			return nil, err
		}
		buf.Write(key)
		buf.WriteByte(':')
		row, err := json.Marshal(ix.rows[id])
		if err != nil {
			return nil, err
		}
		buf.Write(row)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// Trash owns every trash can on the box.
//
// java: one mutex for ALL cans, exactly like the Python's module-level _LOCK.
// It serialises every index.json read-modify-write; the expensive folder walks
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

// loadIndex reads one can's index. A missing or corrupt index reads as "empty
// trash".
func loadIndex(tdir string) *trashIndex {
	index := newTrashIndex()
	raw, err := os.ReadFile(indexPath(tdir))
	if err != nil {
		return index // a missing index is an empty trash
	}
	if err := json.Unmarshal(raw, index); err != nil {
		return newTrashIndex() // a corrupt one is too
	}
	return index
}

func saveIndex(tdir string, index *trashIndex) error {
	if err := os.MkdirAll(tdir, 0o755); err != nil {
		return err
	}
	return atomicWriteJSON(indexPath(tdir), index, 2)
}

// newEntryID mirrors Python's f"{int(time.time())}-{secrets.token_hex(4)}".
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
	tdir := t.Dir(role, user)
	if err := os.MkdirAll(tdir, 0o755); err != nil {
		return "", err
	}
	// The can sits inside the file's own root - a user's in their home, the
	// admin's in the base - so the move is one rename through the sandbox.
	trashRel, ok := p.relTo(tdir)
	if !ok {
		return "", errCrossRoot
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

	index := loadIndex(tdir)
	index.set(entryID, TrashEntry{
		Orig:    origRel,
		Name:    filepath.Base(p.Abs),
		Deleted: time.Now().Unix(),
		Dir:     isDir,
		Size:    size,
	})
	if err := saveIndex(tdir, index); err != nil {
		return "", err
	}

	if err := moveResolved(p, dest); err != nil {
		// A failed move must never leave a dangling row: roll it back.
		index.remove(entryID)
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
// dropped from the index on the way out.
func (t *Trash) List(role, user string) []TrashItem {
	tdir := t.Dir(role, user)

	type alive struct {
		id    string
		entry TrashEntry
		path  string
	}
	var live []alive

	t.mu.Lock()
	index := loadIndex(tdir)
	changed := false
	for _, id := range index.keys() { // file order, so ties stay chronological
		entry, _ := index.get(id)
		p := filepath.Join(tdir, id)
		if !entryRE.MatchString(id) {
			index.remove(id)
			changed = true
			continue
		}
		if _, err := os.Lstat(p); err != nil {
			index.remove(id)
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
		index := loadIndex(tdir) // re-read: it may have changed meanwhile
		for id, size := range learned {
			if entry, found := index.get(id); found {
				entry.Size = ptrInt64(size)
				index.set(id, entry)
			}
		}
		saveIndex(tdir, index)
		t.mu.Unlock()
	}

	sort.SliceStable(items, func(i, j int) bool { return items[i].Deleted > items[j].Deleted })
	return items
}

// Size is the total bytes sitting in this caller's trash. It reuses List, so the
// per-item sizes already cached in index.json are not re-measured.
func (t *Trash) Size(role, user string) int64 {
	var total int64
	for _, it := range t.List(role, user) {
		total += it.Size
	}
	return total
}

// -----------------------------------------------------------------------------
// restore
// -----------------------------------------------------------------------------

// freeTarget is where an entry should be restored to, the new name when the
// original path was taken, and false when it cannot go back at all.
func (t *Trash) freeTarget(role, user, origRel string) (Resolved, string, bool) {
	if origRel == "" {
		// A corrupted index row: no way to know where it came from - never fall
		// back to a root.
		return Resolved{}, "", false
	}
	target, ok := t.users.Resolve(role, user, origRel)
	if !ok || !target.Writable {
		return Resolved{}, "", false
	}
	info, err := target.Lstat()
	if err != nil {
		return target, "", true // the original slot is free - restore in place
	}

	stamp := time.Now().Format("2006-01-02-150405")
	base := filepath.Base(target.Abs)
	ext := filepath.Ext(base)
	var newName string
	if info.IsDir() || ext == "" {
		newName = base + " (restaurado " + stamp + ")"
	} else {
		newName = strings.TrimSuffix(base, ext) + " (restaurado " + stamp + ")" + ext
	}
	return target.at(filepath.Join(filepath.Dir(target.Rel), newName)), newName, true
}

// Restore moves the given entryIds back to where they came from. It returns the
// names that had to be renamed because their original path was occupied.
func (t *Trash) Restore(role, user string, ids []string) []string {
	tdir := t.Dir(role, user)
	renamed := []string{}

	t.mu.Lock()
	defer t.mu.Unlock()

	index := loadIndex(tdir)
	for _, id := range ids {
		if !entryRE.MatchString(id) {
			continue
		}
		entry, found := index.get(id)
		if !found {
			continue
		}
		src := filepath.Join(tdir, id)
		if _, err := os.Lstat(src); err != nil {
			index.remove(id)
			continue
		}

		dest, newName, ok := t.freeTarget(role, user, entry.Orig)
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
		if err := moveResolved(dest.at(filepath.Join(trashRel, id)), dest); err != nil {
			t.log.Warn("trash: restore failed", "id", id, "err", err)
			continue
		}
		index.remove(id)
		if newName != "" {
			renamed = append(renamed, newName)
		}
		t.log.Info("trash: restored", "id", id, "to", dest.Abs)
	}
	saveIndex(tdir, index)
	return renamed
}

// -----------------------------------------------------------------------------
// permanent delete
// -----------------------------------------------------------------------------

// Purge really deletes. A nil `ids` empties the whole can.
func (t *Trash) Purge(role, user string, ids []string) int {
	tdir := t.Dir(role, user)
	if info, err := os.Stat(tdir); err != nil || !info.IsDir() {
		return 0
	}

	t.mu.Lock()
	index := loadIndex(tdir)
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
		index.remove(id)
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
	return n
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
		index := loadIndex(c.dir)
		gone := 0
		for _, id := range index.keys() {
			entry, _ := index.get(id)
			// A row with no timestamp counts as epoch 0 => always expired.
			if entryRE.MatchString(id) && entry.Deleted < cutoff {
				os.RemoveAll(filepath.Join(c.dir, id))
				index.remove(id)
				gone++
			}
		}
		// Also drop entries whose file is already gone.
		for _, id := range index.keys() {
			if _, err := os.Lstat(filepath.Join(c.dir, id)); err != nil {
				index.remove(id)
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
				if _, found := index.get(id); found {
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
// to cross two filesystems.
func moveResolved(src, dst Resolved) error {
	err := renameResolved(src, dst)
	if err == nil || !isCrossDevice(err) {
		return err
	}
	return moveOrCopy(src.Abs, dst.Abs)
}

// moveOrCopy renames, falling back to copy-then-delete when the two paths sit
// on different filesystems.
//
// java: Python reaches for shutil.move, which handles that case for a file AND
// for a whole directory tree. Go's os.Rename just fails with EXDEV, so the
// fallback is written out here.
//
// It is not a theoretical path: the admin's trash is <base>/.trash while a home
// could sit on its own mount, and the external-storage setting in the admin
// panel is heading exactly there. A rename within one filesystem stays what it
// always was - instant, and never a copy.
func moveOrCopy(src, dst string) error {
	err := os.Rename(src, dst)
	if err == nil || !isCrossDevice(err) {
		return err
	}

	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err := copyTree(src, dst); err != nil {
			// A half-copied tree is worse than none: bin it and report the
			// failure, leaving the original exactly where it was.
			os.RemoveAll(dst)
			return err
		}
		return os.RemoveAll(src)
	}
	if err := copyFile(src, dst, info.Mode()); err != nil {
		os.Remove(dst)
		return err
	}
	return os.Remove(src)
}

// copyTree copies a directory recursively. Symlinks are copied AS LINKS, never
// followed - the same rule every listing in this server follows.
func copyTree(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dst, info.Mode().Perm()); err != nil {
		return err
	}
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
		case entryInfo.IsDir():
			if err := copyTree(from, to); err != nil {
				return err
			}
		case entryInfo.Mode().IsRegular():
			if err := copyFile(from, to, entryInfo.Mode()); err != nil {
				return err
			}
		}
		// Anything else - a socket, a device - is not a user's document and is
		// simply not carried across.
	}
	return nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode.Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func whoever(user string) string {
	if user == "" {
		return "admin"
	}
	return user
}
