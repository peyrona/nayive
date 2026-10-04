package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestBuildSkipsDotFolders: a sidecar beside a served file, none inside a dot
// folder (.bak/, write/lib/.docx-editor-prev/ - never served).
func TestBuildSkipsDotFolders(t *testing.T) {
	apps := t.TempDir()
	big := []byte(strings.Repeat("let x = 1;\n", 400))
	for _, p := range []string{"app/a.js", "app/lib/.docx-editor-prev/b.js", ".bak/c.js"} {
		full := filepath.Join(apps, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, big, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := build(apps); err != nil {
		t.Fatal(err)
	}
	for p, want := range map[string]bool{
		"app/a.js.gz": true, "app/lib/.docx-editor-prev/b.js.gz": false, ".bak/c.js.gz": false,
	} {
		if _, err := os.Stat(filepath.Join(apps, filepath.FromSlash(p))); (err == nil) != want {
			t.Errorf("%s there = %v, want %v", p, err == nil, want)
		}
	}
}
