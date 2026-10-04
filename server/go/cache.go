package main

// trimCache: the one sweep of a server cache folder (Bookmarks' icons,
// Culture's copies). Each caller keeps its own lock and its own age rules.

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// cacheFate is what trimCache does with one file of the folder.
type cacheFate int

const (
	cacheLeave cacheFate = iota // neither dropped nor counted
	cacheDrop                   // deleted now
	cacheCount                  // counted towards the cap; the oldest go first
)

// trimCache keeps `dir` in bounds: a half-written ".part" older than a minute
// goes, every other regular file is dropped, counted or left as `fate` says
// (by its name and age), and when the counted files pass `max` the oldest go
// until they are back under nine tenths of it.
func trimCache(dir string, max int64, fate func(name string, age time.Duration) cacheFate) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type kept struct {
		path string
		size int64
		mod  time.Time
	}
	var all []kept
	var total int64
	now := time.Now()
	for _, e := range entries {
		fi, err := e.Info()
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		p, age := filepath.Join(dir, e.Name()), now.Sub(fi.ModTime())
		if strings.HasSuffix(e.Name(), ".part") {
			if age > time.Minute {
				_ = os.Remove(p)
			}
			continue
		}
		switch fate(e.Name(), age) {
		case cacheDrop:
			_ = os.Remove(p)
		case cacheCount:
			all = append(all, kept{p, fi.Size(), fi.ModTime()})
			total += fi.Size()
		}
	}
	if total <= max {
		return
	}
	sort.Slice(all, func(i, j int) bool { return all[i].mod.Before(all[j].mod) })
	for _, k := range all {
		if total <= max/10*9 {
			break
		}
		if os.Remove(k.path) == nil {
			total -= k.size
		}
	}
}
