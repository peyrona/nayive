//go:build unix

package main

import (
	"os"
	"syscall"
)

// fileID is the file's inode number: it stays the same when the file is
// renamed or moved inside the same disk, so a link to it can find it again.
// 0 = unknown.
func fileID(info os.FileInfo) uint64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Ino)
	}
	return 0
}
