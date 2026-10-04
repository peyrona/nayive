package main

// =============================================================================
// findKept's index: one walk of a home answers a whole album of moved photos.
// =============================================================================
//
// A kept chat photo that its owner moved is found again by its inode
// (chat.go, findKept). That used to be one walk of the home - up to 200 000
// entries - per photo, under the chat hub's lock: opening an album of moved
// photos froze every chat for as many walks (S2-#16). Now one walk builds an
// inode -> path index of the home, and the next lookups within keptIndexTTL
// read it. An answer is checked against the disk before it is given, and a
// miss in an index more than keptIndexFresh old walks again, so a file moved
// a moment ago is still found.
//
// The walk runs with the hub's lock let go (OL2): under it, keptWalk says a
// walk is needed, the handler walks with no lock held (inKept, api_chat.go),
// then takes the lock again and asks the fresh index. Only a caller that
// skipped that step (or an index gone stale meanwhile) still walks under it.

import (
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	keptIndexTTL   = 30 * time.Second // how long one walk answers
	keptIndexFresh = 2 * time.Second  // younger than this, a miss is believed
)

type keptIndex struct {
	from  time.Time         // when its walk started
	built time.Time         // when its walk ended
	byID  map[keptID]string // "files/..." by inode + size
}

// keptIndexes is one index per home, guarded by its own lock (never h.mu).
var keptIndexes = struct {
	sync.Mutex
	m map[string]*keptIndex
}{m: map[string]*keptIndex{}}

// keptWalks is one walk lock per home: many pages asking at once (a guest's
// thumbnails of an album of moved photos) make a walk or two, not one each.
var keptWalks = struct {
	sync.Mutex
	m map[string]*sync.Mutex
}{m: map[string]*sync.Mutex{}}

// findKeptIndexed is the owner's file known by `id`, as "files/...", or "".
func findKeptIndexed(home string, id keptID) string {
	if rel, walk := keptIndexLookup(home, id); !walk {
		return rel
	}
	return refreshKeptIndex(home).byID[id]
}

// keptIndexLookup is findKeptIndexed without the walk: the answer, or walk
// true when only a new walk of the home can give it.
func keptIndexLookup(home string, id keptID) (rel string, walk bool) {
	now := time.Now()
	keptIndexes.Lock()
	for k, idx := range keptIndexes.m { // forget the stale ones, whoever's
		if now.Sub(idx.built) > keptIndexTTL {
			delete(keptIndexes.m, k)
		}
	}
	idx := keptIndexes.m[home]
	keptIndexes.Unlock()

	if idx == nil {
		return "", true
	}
	rel, ok := idx.byID[id]
	if ok && keptStillAt(home, rel, id) {
		return rel, false
	}
	if !ok && now.Sub(idx.built) < keptIndexFresh {
		return "", false
	}
	return "", true
}

// refreshKeptIndex walks the home and keeps the index it makes - one walk at
// a time per home: an index whose walk started after this was asked for, made
// while it waited, is taken as it is.
func refreshKeptIndex(home string) *keptIndex {
	asked := time.Now()
	keptWalks.Lock()
	walk := keptWalks.m[home]
	if walk == nil {
		walk = &sync.Mutex{}
		keptWalks.m[home] = walk
	}
	keptWalks.Unlock()
	walk.Lock()
	defer walk.Unlock()

	keptIndexes.Lock()
	idx := keptIndexes.m[home]
	keptIndexes.Unlock()
	if idx != nil && !idx.from.Before(asked) {
		return idx
	}
	idx = buildKeptIndex(home)
	keptIndexes.Lock()
	keptIndexes.m[home] = idx
	keptIndexes.Unlock()
	return idx
}

// keptStillAt: the file at `rel` is still the one known by `id`.
func keptStillAt(home, rel string, id keptID) bool {
	info, err := os.Lstat(filepath.Join(home, filepath.FromSlash(rel)))
	return err == nil && info.Mode().IsRegular() && keptIDOf(info) == id
}

// buildKeptIndex walks home/files once (at most chatFindMax entries). The bin
// is not looked in: a binned photo is gone until it is restored. Its time is
// when the walk ENDS: a big home can take longer than keptIndexFresh, and a
// miss read just after a walk made outside the lock must be believed (OL2).
func buildKeptIndex(home string) *keptIndex {
	idx := &keptIndex{from: time.Now(), byID: map[keptID]string{}}
	seen := 0
	filepath.WalkDir(filepath.Join(home, "files"), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if seen++; seen > chatFindMax {
			return filepath.SkipAll
		}
		if d.IsDir() {
			if d.Name() == ".trash" {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			if id := keptIDOf(info); id.Ino != 0 {
				_, dup := idx.byID[id] // a hard link: the first path, as the walk meets them
				if rel, err := filepath.Rel(home, path); err == nil && !dup {
					idx.byID[id] = filepath.ToSlash(rel)
				}
			}
		}
		return nil
	})
	idx.built = time.Now()
	return idx
}
