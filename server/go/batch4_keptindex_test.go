package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestFindKeptIndexed (S2-#16): one walk answers every moved photo of a burst,
// an answer is re-checked against the disk, and a file moved after the walk
// is still found once the index is not brand new.
func TestFindKeptIndexed(t *testing.T) {
	home := t.TempDir()
	files := filepath.Join(home, "files")
	os.MkdirAll(filepath.Join(files, "a"), 0o755)
	os.MkdirAll(filepath.Join(files, "b"), 0o755)
	idOf := func(rel string) keptID {
		t.Helper()
		info, err := os.Stat(filepath.Join(home, rel))
		if err != nil {
			t.Fatal(err)
		}
		return keptIDOf(info)
	}
	os.WriteFile(filepath.Join(files, "a", "1.jpg"), []byte("uno"), 0o644)
	os.WriteFile(filepath.Join(files, "a", "2.jpg"), []byte("dos!"), 0o644)
	id1, id2 := idOf("files/a/1.jpg"), idOf("files/a/2.jpg")
	if id1.Ino == 0 {
		t.Skip("no inodes here")
	}
	os.Rename(filepath.Join(files, "a"), filepath.Join(files, "album"))

	if got := findKeptIndexed(home, id1); got != "files/album/1.jpg" {
		t.Fatalf("first lookup = %q", got)
	}
	built := keptIndexes.m[home].built
	if got := findKeptIndexed(home, id2); got != "files/album/2.jpg" {
		t.Fatalf("second lookup = %q", got)
	}
	if keptIndexes.m[home].built != built {
		t.Error("the second photo of the burst walked the home again")
	}

	// Moved again after the walk: the stale answer is caught and re-walked.
	os.Rename(filepath.Join(files, "album", "2.jpg"), filepath.Join(files, "b", "2.jpg"))
	if got := findKeptIndexed(home, id2); got != "files/b/2.jpg" {
		t.Errorf("after a second move = %q, want files/b/2.jpg", got)
	}

	// A file the index never saw, once the index is past keptIndexFresh.
	os.WriteFile(filepath.Join(files, "b", "3.jpg"), []byte("tres"), 0o644)
	id3 := idOf("files/b/3.jpg")
	keptIndexes.m[home].built = time.Now().Add(-keptIndexFresh - time.Second)
	if got := findKeptIndexed(home, id3); got != "files/b/3.jpg" {
		t.Errorf("a file newer than the index = %q", got)
	}
	if got := findKeptIndexed(home, keptID{Ino: 1, Size: 1}); got != "" {
		t.Errorf("an unknown id = %q, want \"\"", got)
	}
}
