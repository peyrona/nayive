package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestSweepChatTemps (S2-#45): the chat's own temps left by a crash go at
// boot; a finished media file, a user's look-alike outside data/chat and a
// 0644 file of the same shape stay.
func TestSweepChatTemps(t *testing.T) {
	_, cfg, _ := newTestUsers(t)
	home := filepath.Join(cfg.HomesDir, "ana")
	media := filepath.Join(home, "data", "chat", "conv", "d-x", "media")
	avatars := filepath.Join(home, "data", "chat", "avatars")
	os.MkdirAll(media, 0o755)
	os.MkdirAll(avatars, 0o755)
	os.MkdirAll(filepath.Join(home, "files"), 0o755)

	// Made the way api_chat.go makes them.
	var gone []string
	for _, c := range []struct{ dir, pattern string }{
		{media, ".up-*"}, {media, ".jpg-*"}, {media, ".fw-*"}, {avatars, ".up-*"},
	} {
		f, err := os.CreateTemp(c.dir, c.pattern)
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
		gone = append(gone, f.Name())
	}
	kept := []string{
		filepath.Join(media, "7.jpg"),
		filepath.Join(home, "files", ".up-123"),
		filepath.Join(media, ".fw-456"), // 0644: not ours to judge
	}
	for _, p := range kept {
		os.WriteFile(p, []byte("x"), 0o600)
	}
	os.Chmod(filepath.Join(media, ".fw-456"), 0o644)

	NewFileTree(cfg.BaseDir, cfg.HomesDir, cfg.ConfigDir, nil).SweepStaleTemp()
	for _, p := range gone {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s survived the sweep", p)
		}
	}
	for _, p := range kept {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s was swept", p)
		}
	}
}
