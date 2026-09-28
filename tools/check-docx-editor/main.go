// check-docx-editor - guard the vendored docx-editor.dev engine.
//
// tools/build-docx-editor.sh writes lib/docx-editor/ and, beside it,
// docx-editor.lock.json: the versions, the file names and a sha256 of every
// file it ships. This tool is what makes that lock file mean something, so it
// answers four questions before every deploy:
//
//  1. is the build there at all?        (a half-copied or hand-deleted folder)
//  2. does it match the lock file?      (right bytes, nothing extra left over)
//  3. does index.html link THIS build's stylesheet?
//  4. does write.js import THIS build's bundle?
//
// A missing index.html or write.js fails too: an engine no page loads is not
// a working Write. The app folder is found the same way the build script finds
// it (see appDir): client/apps/write/.
//
// Without this, the first person to notice a mismatch is a user whose editor
// never opens. It runs as a PREBUILD_STEP in deploy.sh:
//
//	go -C tools run ./check-docx-editor
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"nayive/tools/internal/repo"
)

// lock is docx-editor.lock.json, as written by tools/build-docx-editor.sh.
type lock struct {
	Core    string            `json:"core"`
	Bundle  string            `json:"bundle"`
	CSS     string            `json:"css"`
	Wasm    string            `json:"wasm"`
	FontDir string            `json:"fontDir"`
	Files   map[string]string `json:"files"` // path inside lib/docx-editor/ -> "sha256-<hex>"
}

// Any reference to a build of the engine, whichever version it names.
var ref = regexp.MustCompile(`lib/docx-editor/docx-editor_v[0-9A-Za-z.+-]*?\.(?:min\.js|css)`)

const rebuild = "  Run:  tools/build-docx-editor.sh"

func main() {
	flag.Parse()
	apps := filepath.Join(repo.MustRoot("check-docx-editor"), "client", "apps")
	os.Exit(run(apps))
}

// appDir is the app the engine is vendored into. One folder since the swap
// (docs/write-docx-editor-plan.md, Phase 9); kept as a function so a future
// second host is one line.
func appDir(apps string) string {
	_ = apps
	return "write"
}

func run(apps string) int {
	var (
		app    = appDir(apps)
		dir    = filepath.Join(apps, app, "lib", "docx-editor")
		lockAt = filepath.Join(dir, "docx-editor.lock.json")
		bad    []string
	)

	raw, err := os.ReadFile(lockAt)
	if err != nil {
		fmt.Printf("check-docx-editor: no %s/lib/docx-editor/docx-editor.lock.json - the engine is not built.\n", app)
		fmt.Println(rebuild)
		return 1
	}

	var lk lock
	if err := json.Unmarshal(raw, &lk); err != nil {
		fmt.Printf("check-docx-editor: docx-editor.lock.json is not readable JSON: %v\n", err)
		return 1
	}
	if lk.Core == "" || lk.Bundle == "" || lk.CSS == "" || lk.Wasm == "" || lk.FontDir == "" || len(lk.Files) == 0 {
		fmt.Println("check-docx-editor: docx-editor.lock.json is missing core, bundle, css, wasm, fontDir or files.")
		fmt.Println(rebuild)
		return 1
	}

	// The names carry the version: that is what the year-long immutable
	// header on lib/ relies on. A lock that says otherwise was hand-edited.
	v := lk.Core
	for _, want := range [][2]string{
		{lk.Bundle, "docx-editor_v" + v + ".min.js"},
		{lk.CSS, "docx-editor_v" + v + ".css"},
		{lk.Wasm, "harfbuzz_v" + v + ".wasm"},
		{lk.FontDir, "fonts_v" + v},
	} {
		if want[0] != want[1] {
			bad = append(bad, fmt.Sprintf("the lock file names %s, version %s means %s", want[0], v, want[1]))
		}
	}
	for _, name := range []string{lk.Bundle, lk.CSS, lk.Wasm} {
		if _, ok := lk.Files[name]; !ok {
			bad = append(bad, "the lock file does not hash "+name)
		}
	}

	// 1 + 2. Every locked file present, with the locked bytes.
	names := make([]string, 0, len(lk.Files))
	for name := range lk.Files {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		got, err := hashFile(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			bad = append(bad, fmt.Sprintf("missing: %s", name))
			continue
		}
		if got != lk.Files[name] {
			bad = append(bad, fmt.Sprintf("changed: %s\n      locked %s\n      on disk %s", name, lk.Files[name], got))
		}
	}

	// 2b. Nothing extra: a leftover from a previous version would still be
	// served, precached and deployed.
	for _, extra := range unlocked(dir, lk.Files) {
		bad = append(bad, fmt.Sprintf("not in the lock file (left over from another build?): %s", extra))
	}

	// 3 + 4. The page is there and points at this build and no other.
	for _, page := range []struct{ file, want string }{
		{"index.html", "lib/docx-editor/" + lk.CSS},
		{"write.js", "lib/docx-editor/" + lk.Bundle},
	} {
		text, err := os.ReadFile(filepath.Join(apps, app, page.file))
		if err != nil {
			bad = append(bad, fmt.Sprintf("missing: %s/%s", app, page.file))
			continue
		}
		if !strings.Contains(string(text), page.want) {
			bad = append(bad, fmt.Sprintf("%s/%s does not reference %s", app, page.file, page.want))
		}
		for _, r := range ref.FindAllString(string(text), -1) {
			if r != "lib/docx-editor/"+lk.CSS && r != "lib/docx-editor/"+lk.Bundle {
				bad = append(bad, fmt.Sprintf("%s/%s still references %s", app, page.file, r))
			}
		}
	}

	if len(bad) > 0 {
		fmt.Printf("check-docx-editor: the engine and the repo disagree (%s, docx-editor.dev %s)\n", app, v)
		for _, b := range bad {
			fmt.Println("  - " + b)
		}
		fmt.Println(rebuild)
		return 1
	}

	fmt.Printf("check-docx-editor: OK - %s, docx-editor.dev %s, %d files\n", app, v, len(lk.Files))
	return 0
}

// unlocked lists the files under dir that the lock file does not name. Three
// kinds are not leftovers: the lock file itself, BUILD.md (ours, hand-edited)
// and the .gz sidecars build-gzip leaves beside the assets.
func unlocked(dir string, locked map[string]string) []string {
	var extra []string

	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		if rel == "docx-editor.lock.json" || rel == "BUILD.md" || strings.HasSuffix(rel, ".gz") {
			return nil
		}
		if _, ok := locked[rel]; !ok {
			extra = append(extra, rel)
		}
		return nil
	})

	sort.Strings(extra)
	return extra
}

func hashFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return "sha256-" + hex.EncodeToString(h.Sum(nil)), nil
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
