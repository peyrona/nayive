//go:build unix

package main

import (
	"os"
	"syscall"
)

// hardLinkKey names one file on one disk, whatever its names (device, inode).
type hardLinkKey struct{ dev, ino uint64 }

// hardLinkOf is the file's key, and whether it has more than one name (a
// hard link): DirSize counts such a file once.
func hardLinkOf(info os.FileInfo) (hardLinkKey, bool) {
	if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Nlink > 1 {
		return hardLinkKey{dev: uint64(st.Dev), ino: uint64(st.Ino)}, true
	}
	return hardLinkKey{}, false
}
