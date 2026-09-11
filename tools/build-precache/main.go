// build-precache - regenerate the precache list + version in apps/sw.js.
//
// The Nayive apps have no build step; this is a deploy helper. Run it whenever an
// app's HTML, a vendored lib, an icon or a shared/ file changes, BEFORE ./deploy.sh
// (which runs it anyway):
//
//	go -C tools run ./build-precache
//
// It rewrites the two @generated blocks in apps/sw.js:
//   - PRECACHE      every static asset the phase-1 offline apps need, as paths
//     relative to apps/ (which is the SW scope root)
//   - CACHE_VERSION a short content hash of all those files, so deploying a change
//     makes the service worker replace its old cache on activate.
//
// Scope is deliberately the phase-1 set. Add an app name to offlineApps once it
// has been wired to shared/store.js - or, like games, once it turns out to need
// nothing from the server at all.
//
// The output is byte-for-byte what the Python version (build-precache.py) wrote,
// CACHE_VERSION included: a different hash is not cosmetic, it makes every
// client download the whole precache again.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"nayive/tools/internal/repo"
)

// Apps that have been wired for offline use. Usually that means "wired to
// shared/store.js"; games is here for the other reason - it asks the server for
// nothing at all, so its shell IS the whole app.
var offlineApps = []string{"tasks", "calendar", "contact", "planner", "trips", "write", "split", "habits",
	"games"}

// Files under apps/<app>/ to precache, by glob. lib/ is recursive. *.js catches
// an app's own top-level module (write.js); the other apps keep theirs inline.
var appGlobs = []string{"index.html", "manifest.json", "*.js", "lib/**/*", "icons/*"}

var shared = []string{"shared/theme.css", "shared/app.css", "shared/theme.js", "shared/store.js",
	"shared/gum-api.js", "shared/i18n.js", "shared/ui.js", "shared/menubar.js",
	"shared/ical.js", "shared/media.js",
	"shared/photo.js", "shared/office.js",
	"shared/lib/ical_v2.2.1.esm.min.js",
	"shared/lib/luxon_v3.7.2.min.js", "shared/lib/rrule_v2.8.1.min.js",
	"shared/i18n/es.json", "shared/i18n/en.json", "shared/i18n/pt.json",
	"shared/i18n/fr.json", "shared/i18n/de.json", "shared/i18n/it.json",
	"shared/i18n/la.json"}

// The launcher lives at apps/index.html itself; login.html is the sign-in page.
var rootFiles = []string{"index.html", "login.html", "manifest.json", "icons/*"}

func main() {
	flag.Parse()
	apps := filepath.Join(repo.MustRoot("build-precache"), "client", "apps")
	sw := filepath.Join(apps, "sw.js")

	rels := collect(apps)
	ver, err := version(apps, rels)
	if err != nil {
		fail("%v", err)
	}

	var shell, rest []string
	for _, r := range rels {
		if isShell(r) {
			shell = append(shell, r)
		} else {
			rest = append(rest, r)
		}
	}

	precacheBody := arr("PRECACHE_SHELL", shell) + "\n\n" + arr("PRECACHE_REST", rest)
	versionBody := `var CACHE_VERSION = "` + ver + `";`

	raw, err := os.ReadFile(sw)
	if err != nil {
		fail("%v", err)
	}
	text := replaceBlock(string(raw), "cache-version", versionBody, sw)
	text = replaceBlock(text, "precache", precacheBody, sw)
	if err := os.WriteFile(sw, []byte(text), 0o644); err != nil {
		fail("%v", err)
	}

	fmt.Printf("apps/sw.js: %d shell + %d rest = %d files, %s\n", len(shell), len(rest), len(rels), ver)
	for _, r := range shell {
		fmt.Println("  shell  " + r)
	}
	for _, r := range rest {
		fmt.Println("  rest   " + r)
	}
}

func collect(apps string) []string {
	// java: a map used as a set - each relative path once; the order comes from
	// the final sort.
	rels := map[string]bool{}

	for _, pat := range rootFiles {
		for _, rel := range glob(apps, pat) {
			rels[rel] = true
		}
	}
	for _, name := range shared {
		if isFile(filepath.Join(apps, name)) {
			rels[name] = true
		}
	}
	for _, app := range offlineApps {
		for _, pat := range appGlobs {
			for _, rel := range glob(apps, app+"/"+pat) {
				rels[rel] = true
			}
		}
	}

	// sw.js and data files never belong in the precache
	delete(rels, "sw.js")
	for junk := range rels {
		// java: deleting from a map while ranging over it is allowed in Go.
		if hasAnySuffix(junk, ".ics", ".vcf", ".md") || strings.HasSuffix(junk, "contacts-meta.json") || strings.HasSuffix(junk, "tasks.json") {
			delete(rels, junk)
		}
		// the .gz sidecars build-gzip leaves beside each asset are a server
		// detail (Content-Encoding), never a URL the page fetches
		if strings.HasSuffix(junk, ".gz") {
			delete(rels, junk)
		}

		// write/lib/: precache only the live SuperDoc bundle and the proofing
		// dictionaries. Anything else that ever lands under write/lib/ (e.g. a
		// superseded editor stack kept around for reference) is dead weight in
		// the offline cache.
		if strings.HasPrefix(junk, "write/lib/") &&
			!(strings.HasPrefix(junk, "write/lib/superdoc/") || strings.HasPrefix(junk, "write/lib/proofing/")) {
			delete(rels, junk)
		}
		if strings.HasPrefix(junk, "write/lib/superdoc/") &&
			(strings.HasSuffix(junk, "DOCX-ENGINE-LICENSE.md") || strings.Contains(junk, "/.peer-stub")) {
			delete(rels, junk)
		}
		if strings.HasPrefix(junk, "write/lib/proofing/") && hasAnySuffix(junk, ".LICENSE", ".txt") {
			delete(rels, junk)
		}
	}

	out := make([]string, 0, len(rels))
	for r := range rels {
		out = append(out, r)
	}
	sort.Strings(out) // byte order = code-point order for UTF-8, like Python's sorted()
	return out
}

// glob returns the regular files matching pat under apps, as slash paths
// relative to apps. It understands the two shapes the lists above use, with
// Python pathlib's rules (a `*` also matches names that start with a dot):
//
//	"dir/x*.js"  one folder level, the last part a pattern
//	"dir/**/*"   every file at any depth under dir
func glob(apps, pat string) []string {
	var found []string
	if dir, ok := strings.CutSuffix(pat, "/**/*"); ok {
		filepath.WalkDir(filepath.Join(apps, dir), func(p string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() && isFile(p) {
				found = append(found, relTo(apps, p))
			}
			return nil // a missing folder simply matches nothing
		})
		return found
	}
	dir, base := filepath.Split(pat)
	entries, err := os.ReadDir(filepath.Join(apps, dir))
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if ok, _ := filepath.Match(base, e.Name()); ok {
			p := filepath.Join(apps, dir, e.Name())
			if isFile(p) {
				found = append(found, relTo(apps, p))
			}
		}
	}
	return found
}

// isShell says whether rel belongs to the 'shell': everything a cold page needs
// to render - its HTML, the shared CSS/JS, the launcher icons, an app's own
// top-level module. These are small and get precached in the service worker's
// install step. Everything else - the vendored libraries under lib/, the
// proofing dictionaries, the SuperDoc bundle - is the 'rest', warmed in the
// background after activation so a post-deploy update never starves the page
// that triggered it.
func isShell(rel string) bool {
	if strings.HasSuffix(rel, ".html") || strings.HasSuffix(rel, "manifest.json") {
		return true
	}
	if strings.HasPrefix(rel, "icons/") || strings.Contains(rel, "/icons/") {
		return true
	}
	if strings.HasPrefix(rel, "shared/") && !strings.HasPrefix(rel, "shared/lib/") {
		return true
	}
	// one "/" -> a file directly inside apps/<app>/, e.g. "write/write.js" - the
	// app's own entry module, not a vendored lib.
	if strings.Count(rel, "/") == 1 && strings.HasSuffix(rel, ".js") {
		return true
	}
	return false
}

// version hashes every file's NAME as well as its bytes (with \0 separators),
// so a rename alone changes the hash.
func version(apps string, rels []string) (string, error) {
	h := sha256.New()
	for _, rel := range rels {
		data, err := os.ReadFile(filepath.Join(apps, filepath.FromSlash(rel)))
		if err != nil {
			return "", err
		}
		h.Write([]byte(rel))
		h.Write([]byte{0})
		h.Write(data)
		h.Write([]byte{0})
	}
	return "nayive-" + hex.EncodeToString(h.Sum(nil))[:12], nil
}

func arr(name string, items []string) string {
	lines := make([]string, len(items))
	for i, r := range items {
		lines[i] = `    "` + r + `"`
	}
	return "var " + name + " = [\n" + strings.Join(lines, ",\n") + "\n];"
}

// replaceBlock swaps what sits between `/* @generated:<tag> */` and `/* @end */`
// for body, keeping both markers. (?s) lets `.` span lines; `.*?` is the
// shortest match, so each block ends at its own @end.
func replaceBlock(text, tag, body, sw string) string {
	re := regexp.MustCompile(`(?s)(/\* @generated:` + regexp.QuoteMeta(tag) + ` \*/\n).*?(\n/\* @end \*/)`)
	matches := re.FindAllStringSubmatchIndex(text, -1)
	if matches == nil {
		fail("marker @generated:%s not found in %s", tag, sw)
	}
	// java: built by hand rather than ReplaceAllString, whose "$1" expansion
	// would also rewrite any "$" inside body.
	var b strings.Builder
	last := 0
	for _, m := range matches {
		b.WriteString(text[last:m[0]])
		b.WriteString(text[m[2]:m[3]])
		b.WriteString(body)
		b.WriteString(text[m[4]:m[5]])
		last = m[1]
	}
	b.WriteString(text[last:])
	return b.String()
}

func hasAnySuffix(s string, sfx ...string) bool {
	for _, x := range sfx {
		if strings.HasSuffix(s, x) {
			return true
		}
	}
	return false
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func relTo(base, p string) string {
	rel, _ := filepath.Rel(base, p)
	return filepath.ToSlash(rel)
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
