//go:build !unix

package main

import "os"

// hardLinkKey names one file on one disk, whatever its names.
type hardLinkKey struct{ dev, ino uint64 }

// hardLinkOf: no inodes here, so every name counts as its own file.
func hardLinkOf(info os.FileInfo) (hardLinkKey, bool) { return hardLinkKey{}, false }
