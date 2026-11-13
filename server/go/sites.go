package main

// =============================================================================
// Static web sites - plain folders served beside Nayive, not part of it.
// =============================================================================
//
// "sites_dir" in server.json names a folder with one sub-folder per site, so
// <sites_dir>/cv/index.html is https://example.com/cv/ . No Nayive session and
// no Nayive code: the files go out as they are on disk. A site folder holding
// a ".password" file asks for a name and password first (sites_auth.go).
//
// Only a URL that no Nayive route wants gets here (handleRoot's 404), so a site
// can never hide an app. The names Nayive answers itself are refused outright,
// even where the router lets one through ("/api", "/s").
//
// The folder is looked up and opened per request: a new site, or a new
// "sites_dir" set in the admin panel, works at once with no restart. os.Root
// keeps every open inside it, symlinks too.

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// reservedSites are first path segments that belong to Nayive.
var reservedSites = map[string]bool{
	"nayive": true, "apps": true, "api": true, "s": true, "c": true,
}

// serveSite answers a URL under <sites_dir>/<site>/. It reports false, having
// written nothing, when the URL is not a site - the caller then sends its 404.
func (s *Server) serveSite(w http.ResponseWriter, r *http.Request) bool {
	parts := splitPath(r.URL.Path)
	if len(parts) == 0 || reservedSites[parts[0]] {
		return false
	}
	for _, p := range parts {
		// ".git", ".env", "..": never served, whatever is on disk.
		if strings.HasPrefix(p, ".") {
			return false
		}
	}
	dir := s.cfg.SitesPath()
	if dir == "" {
		return false
	}

	root, err := os.OpenRoot(dir)
	if err != nil {
		return false
	}
	defer root.Close()

	if info, err := root.Stat(parts[0]); err != nil || !info.IsDir() {
		return false
	}

	// From here on the URL belongs to a site, and the site answers it.

	// "/cv" -> "/cv/" BEFORE any password question: a login asked for at "/cv"
	// is one the browser then sends to every URL under "/", Nayive's included.
	if len(parts) == 1 && redirectToSlash(w, r) {
		return true
	}
	// A site with a .password file asks for it first (sites_auth.go).
	if s.siteLocked(w, r, root, parts[0]) {
		return true
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		sendText(w, r, http.StatusMethodNotAllowed, "Method not allowed.\n")
		return true
	}

	name := strings.Join(parts, "/")
	info, err := root.Stat(name)

	if err == nil && info.IsDir() {
		if redirectToSlash(w, r) {
			return true
		}
		name += "/index.html"
		info, err = root.Stat(name)
	}

	// No index.html is a 404, never a listing of the folder.
	if err != nil || !info.Mode().IsRegular() {
		sendText(w, r, http.StatusNotFound, "Not found.\n")
		return true
	}
	file, err := root.Open(name)
	if err != nil {
		sendText(w, r, http.StatusNotFound, "Not found.\n")
		return true
	}
	defer file.Close()
	ctype := ContentType(name)
	// A site lives on Nayive's origin, so its script could call /api/* with the
	// visitor's session. The sandbox runs its pages in an origin of their own:
	// script, forms and links still work; cookies, localStorage and anything of
	// Nayive's do not. From that origin even the site's own fonts and data files
	// are cross-origin, so every file says anyone may read it - they are public
	// anyway, and no cookie ever goes with such a request.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if scriptable(ctype) {
		w.Header().Set("Content-Security-Policy", siteSandbox)
	}
	serveFileFrom(w, r, file, ctype, info)
	return true
}

// siteSandbox is a site page's CSP. Deliberately NO allow-same-origin: with it
// the page would be Nayive's origin again.
const siteSandbox = "sandbox allow-scripts allow-forms allow-popups " +
	"allow-popups-to-escape-sandbox allow-modals allow-downloads"

// adminListDirs lists the sub-folders of one server folder, for the admin
// panel's web sites folder picker. Read-only. "" or "~" is the home of the
// user the server runs as; "~/x" and relative paths resolve as "sites_dir"
// does. Hidden folders are left out. "more" names the ones that hold a
// sub-folder, so the picker draws an arrow only where there is something to open.
func (s *Server) adminListDirs(w http.ResponseWriter, r *http.Request, body *adminRequest) {
	home, _ := os.UserHomeDir()
	raw := strings.TrimSpace(body.Path)
	dir := raw
	switch {
	case raw == "" || raw == "~":
		dir = home
	case strings.HasPrefix(raw, "~/"):
		dir = filepath.Join(home, raw[2:])
	case !filepath.IsAbs(raw):
		dir = filepath.Join(s.cfg.Here, raw)
	}
	dir = filepath.Clean(dir)

	entries, err := os.ReadDir(dir)
	if err != nil {
		sendError(w, r, http.StatusNotFound, "no existe esa carpeta")
		return
	}
	dirs, more := []string{}, []string{}
	for _, e := range entries {
		if isListedDir(dir, e) {
			dirs = append(dirs, e.Name())
			if hasSubDir(filepath.Join(dir, e.Name())) {
				more = append(more, e.Name())
			}
		}
	}
	sort.Strings(dirs)
	sort.Strings(more)
	sendJSON(w, r, http.StatusOK, map[string]any{
		"path": dir,
		"home": home,
		"dirs": dirs,
		"more": more,
	})
}

// isListedDir: a folder the picker shows - not hidden; a symlink to a folder
// counts as a folder.
func isListedDir(dir string, e os.DirEntry) bool {
	if strings.HasPrefix(e.Name(), ".") {
		return false
	}
	info, err := os.Stat(filepath.Join(dir, e.Name()))
	return err == nil && info.IsDir()
}

// hasSubDir reads a folder a few names at a time and stops at the first
// folder it shows, so a huge folder costs little. Unreadable = none.
func hasSubDir(dir string) bool {
	f, err := os.Open(dir)
	if err != nil {
		return false
	}
	defer f.Close()
	for {
		entries, err := f.ReadDir(64)
		for _, e := range entries {
			if isListedDir(dir, e) {
				return true
			}
		}
		if err != nil || len(entries) == 0 {
			return false
		}
	}
}
