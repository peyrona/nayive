package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"nayive/tools/internal/repo"
)

// The committed icons are what make-icons.py (Pillow 9) wrote. Drawn again
// into an empty folder, every one has the same size and the same pixels; and
// a run over the committed ones changes no file.
func TestSamePixelsAsPillow(t *testing.T) {
	root, err := repo.Root()
	if err != nil {
		t.Fatal(err)
	}
	logo := filepath.Join(root, "tools", "launcher-logo-512.png")
	res := filepath.Join(root, "android", "app", "src", "main", "res")
	tmp := t.TempDir()
	if err := run(logo, tmp); err != nil {
		t.Fatal(err)
	}
	names, _ := filepath.Glob(filepath.Join(tmp, "*", "*.png"))
	if len(names) != 11 {
		t.Fatalf("%d icons written, want 11", len(names))
	}
	for _, p := range names {
		rel, _ := filepath.Rel(tmp, p)
		got, err := loadNRGBA(p)
		if err != nil {
			t.Fatal(err)
		}
		want, err := loadNRGBA(filepath.Join(res, rel))
		if err != nil {
			t.Fatal(err)
		}
		if got.Rect != want.Rect {
			t.Errorf("%s: size %v, want %v", rel, got.Rect, want.Rect)
			continue
		}
		diff, worst := 0, 0
		for i := range got.Pix {
			if d := int(got.Pix[i]) - int(want.Pix[i]); d != 0 {
				diff++
				worst = max(worst, d, -d)
			}
		}
		if diff > 0 {
			t.Errorf("%s: %d bytes differ (worst by %d)", rel, diff, worst)
		}
	}

	// Over a copy of the committed icons: nothing is rewritten.
	cp := t.TempDir()
	before := map[string][]byte{}
	for _, p := range names {
		rel, _ := filepath.Rel(tmp, p)
		data, _ := os.ReadFile(filepath.Join(res, rel))
		before[rel] = data
		os.MkdirAll(filepath.Dir(filepath.Join(cp, rel)), 0o777)
		os.WriteFile(filepath.Join(cp, rel), data, 0o666)
	}
	if err := run(logo, cp); err != nil {
		t.Fatal(err)
	}
	for rel, data := range before {
		now, _ := os.ReadFile(filepath.Join(cp, rel))
		if !bytes.Equal(now, data) {
			t.Errorf("%s was rewritten", rel)
		}
	}
}
