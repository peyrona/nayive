package main

// =============================================================================
// Static web sites - plain folders served beside Nayive, not part of it.
// =============================================================================
//
// "sites_dir" in server.json names a folder with one sub-folder per site, so
// <sites_dir>/cv/index.html is https://example.com/cv/ . No session and no
// Nayive code: the files go out as they are on disk.
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
