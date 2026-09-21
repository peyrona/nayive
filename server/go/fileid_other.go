//go:build !unix

package main

import "os"

// fileID: no inode here, so a linked file is found by its path only.
func fileID(info os.FileInfo) uint64 { return 0 }
