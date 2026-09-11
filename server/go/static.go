package main

// =============================================================================
// The static apps under /nayive/, with pre-built .gz sidecars.
// =============================================================================
//
// This is where Go pays for itself. handler.py hand-rolls Range parsing,
// If-Modified-Since, 206 responses and 64 KiB streaming - about 90 lines.
// http.ServeContent does all of it.
//
// What is still ours, because it is this project's policy and not HTTP's: the
// path sandbox, which files are readable with NO session, the Cache-Control
// tiers, and swapping in a pre-built "<file>.gz" sidecar.

import (
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// publicStatic are the files served WITHOUT a session: the login page and just
// enough to paint it.
var publicStatic = map[string]bool{
	"login.html":  true,
	"admin.html":  true,
	"favicon.ico": true,
	// The service worker holds only a list of asset paths - nothing private -
	// and it must stay reachable without a session: a 401 makes every update
	// check fail, so while a session is out the cached shell keeps painting the
	// OLD build with no way to learn a new one exists until the user signs in
	// again.
	"sw.js":            true,
	"shared/theme.css": true,
	"shared/app.css":   true,
	"shared/theme.js":  true,
	"shared/ui.js":     true,
	// The interface language: the sign-in screen is translated too, so the
	// engine and every dictionary must be reachable with no session.
	"shared/i18n.js":      true,
	"shared/i18n/es.json": true,
	"shared/i18n/en.json": true,
	"shared/i18n/pt.json": true,
	"shared/i18n/fr.json": true,
	"shared/i18n/de.json": true,
	"shared/i18n/it.json": true,
	"shared/i18n/la.json": true,
}

// publicStaticNames are served without a session wherever they sit under apps/,
// matched by FILE NAME instead of full path.
//
// A web app manifest is fetched by the browser with credentials OMITTED unless
// the <link> says crossorigin="use-credentials", so a session cookie never
// reaches it: behind a 401 the per-app manifests made "install as app" fail
// everywhere but the launcher (whose manifest sits at the root and so matched
// publicStatic by accident). A manifest holds only the app's name, colours and
// icon list - nothing private - same reasoning as sw.js above.
var publicStaticNames = map[string]bool{
	"manifest.json": true,
}

// immutableCache is for URLs whose content can never change: a version is baked
// into the file name, or it lives in a vendored lib/ or icons/ folder. One
// year, and "immutable" so the browser does not even revalidate on reload.
const immutableCache = "public, max-age=31536000, immutable"

// StaticFiles serves the apps directory, sandboxed to it.
type StaticFiles struct {
	root *os.Root
	dir  string
	log  Logger
}

// NewStaticFiles opens `dir` as a kernel-enforced sandbox.
//
// java: os.Root (Go 1.24) is the sandbox. Every Open through it is resolved
// INSIDE the root by the kernel, so "../../etc/passwd", an absolute path, or a
// symlink pointing out of the tree all fail - and they fail even if another
// process swaps a directory for a symlink mid-request, which the Python's
// resolve()-then-compare cannot promise.
func NewStaticFiles(dir string, log Logger) (*StaticFiles, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &StaticFiles{root: root, dir: dir, log: log}, nil
}

func (f *StaticFiles) Close() error { return f.root.Close() }

// serveStatic answers everything under /nayive/.
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		sendText(w, r, http.StatusMethodNotAllowed, "Method not allowed.\n")
		return
	}

	rel := unquotePath(r.PathValue("path"))
	parts := splitPath(rel)
	if hasDotDot(parts) {
		sendText(w, r, http.StatusForbidden, "Forbidden.\n")
		return
	}

	name := strings.Join(parts, "/")
	info, err := s.static.stat(name)

	// A directory URL must end in "/" or the page's relative links break.
	if err == nil && info.IsDir() {
		if !strings.HasSuffix(r.URL.Path, "/") {
			redirect(w, http.StatusFound, r.URL.Path+"/")
			return
		}
		parts = append(parts, "index.html")
		name = strings.Join(parts, "/")
		info, err = s.static.stat(name)
	}

	// THE SESSION GATE, decided on the URL and not on what is on disk, so a
	// missing file behind a login still answers 401 rather than leaking that it
	// is missing.
	if !isPublicStatic(parts) {
		if _, signedIn := s.session(r); !signedIn {
			if strings.Contains(r.Header.Get("Accept"), "text/html") {
				redirect(w, http.StatusFound,
					URLPrefix+"/login.html?return="+quotePath(r.URL.Path))
				return
			}
			sendError(w, r, http.StatusUnauthorized, "not signed in")
			return
		}
	}

	// The .gz sidecars tools/build-gzip leaves beside the assets are an
	// implementation detail of the file server, never a URL of their own.
	if err != nil || !info.Mode().IsRegular() || strings.HasSuffix(name, ".gz") {
		sendText(w, r, http.StatusNotFound, "Not found.\n")
		return
	}

	w.Header().Set("Cache-Control", cacheControlFor(parts))
	if len(parts) > 0 && parts[len(parts)-1] == "sw.js" {
		w.Header().Set("Service-Worker-Allowed", URLPrefix+"/")
	}
	s.static.serve(w, r, name, info)
}

// isPublicStatic decides whether this URL may be read with no session.
func isPublicStatic(parts []string) bool {
	if len(parts) == 0 {
		return false
	}
	if publicStatic[strings.Join(parts, "/")] {
		return true
	}
	if publicStaticNames[parts[len(parts)-1]] {
		return true
	}
	return parts[0] == "icons"
}

// cacheControlFor picks the caching tier for a /nayive/ file.
//
// Anything whose URL can never change content (a version is baked into the
// filename, or it lives in a vendored lib/ or icons/ folder) is cached hard;
// the hand-maintained files (HTML, the un-versioned shared/*.js|css, manifests)
// stay no-cache so a deploy is picked up.
func cacheControlFor(parts []string) string {
	if len(parts) == 0 {
		return "no-cache"
	}
	name := parts[len(parts)-1]
	if name == "sw.js" {
		return "no-cache" // the SW must always check for a new build
	}
	// The vendored-lib naming: luxon_v3.7.2.min.js, leaflet_v1.9.4/...,
	// ical_v2.2.1.esm.min.js - "_v" followed by something starting with a digit.
	versioned := false
	if segs := strings.Split(name, "_v"); len(segs) > 1 {
		for _, seg := range segs[1:] {
			if seg != "" && seg[0] >= '0' && seg[0] <= '9' {
				versioned = true
				break
			}
		}
	}
	if versioned || contains(parts, "lib") || contains(parts, "icons") {
		return immutableCache
	}
	return "no-cache"
}

// stat looks a path up inside the sandbox.
func (f *StaticFiles) stat(rel string) (os.FileInfo, error) {
	if rel == "" {
		rel = "."
	}
	return f.root.Stat(rel)
}

// serve sends one static file, with the .gz sidecar when there is a usable one.
func (f *StaticFiles) serve(w http.ResponseWriter, r *http.Request, rel string, info os.FileInfo) {
	file, err := f.root.Open(rel)
	if err != nil {
		sendText(w, r, http.StatusNotFound, "Not found.\n")
		return
	}
	defer file.Close()

	ctype := ContentType(rel)
	w.Header().Set("Content-Type", ctype)
	// The response body varies with Accept-Encoding, so any shared cache must
	// key on that header too. Cheap to send, so we always do.
	w.Header().Set("Vary", "Accept-Encoding")

	body := file
	modTime := info.ModTime()

	// The sidecar, for a plain whole-file GET only. A Range request takes the
	// normal path: seeking inside a gzip stream is not a thing.
	//
	// The mtime rule - the sidecar must not be OLDER than its source - is what
	// makes a stale sidecar harmless: it is simply skipped, and the plain file
	// goes out. deploy.sh's version stamp rewriting index.html after the
	// sidecar was built is exactly that case.
	if r.Header.Get("Range") == "" && acceptsGzip(r) {
		if gz, gzInfo, err := f.openSidecar(rel, modTime); err == nil {
			defer gz.Close()
			body = gz
			w.Header().Set("Content-Encoding", "gzip")
			// net/http REFUSES to set Content-Length itself once
			// Content-Encoding is present - it cannot know whether something
			// further down re-encodes the body - and falls back to chunked.
			// handler.py always sends a length, so we send the sidecar's own
			// size and the two servers stay byte-identical on the wire.
			w.Header().Set("Content-Length", strconv.FormatInt(gzInfo.Size(), 10))
			// NOTE THE ORDER: Content-Type was set from the ORIGINAL name
			// above, so ServeContent never sniffs the gzip magic and answers
			// application/x-gzip - which browsers download instead of render.
		}
	}

	// No usable sidecar? A text asset is still worth squeezing at request time
	// - the same second tier the file API uses. (tools/build-gzip normally leaves
	// a sidecar for every one of these, so this is the path after a hand edit,
	// or for an asset the build script does not cover.)
	if body == file {
		if serveGzipTier(w, r, file, ctype, info) {
			return
		}
	}

	// ServeContent handles Range (206 + Content-Range), If-Modified-Since /
	// If-None-Match (304), HEAD, and streaming. modTime is the ORIGINAL file's,
	// so a re-gzipped sidecar cannot make a cached copy look stale.
	http.ServeContent(w, r, rel, modTime, body)
}

// openSidecar opens "<rel>.gz" when it exists, is not empty, and is at least as
// new as its source.
func (f *StaticFiles) openSidecar(rel string, srcMod time.Time) (*os.File, os.FileInfo, error) {
	gz, err := f.root.Open(rel + ".gz")
	if err != nil {
		return nil, nil, err
	}
	info, err := gz.Stat()
	if err != nil || info.Size() == 0 || info.ModTime().Before(srcMod.Truncate(time.Second)) {
		gz.Close()
		if err == nil {
			err = os.ErrNotExist
		}
		return nil, nil, err
	}
	return gz, info, nil
}

// serveFileFrom is the file API's counterpart: a file already opened through
// the sandbox, no sidecar, and the same Range / 304 handling for free. The
// caller closes it.
//
// The apps stream video and audio straight out of a user's files/, so Range
// support here is not optional: without it a <video> element cannot seek.
func serveFileFrom(w http.ResponseWriter, r *http.Request, file *os.File, ctype string,
	info os.FileInfo) {

	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Accept-Ranges", "bytes")
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("Vary", "Accept-Encoding")

	if serveGzipTier(w, r, file, ctype, info) {
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

// serveGzipTier is the second gzip tier: a TEXT file with no pre-built sidecar,
// squeezed at request time when it is worth it. It reports whether it answered.
//
// This is about the phone's data plan more than the VPS: a user's tasks.json,
// calendar.ics or an app's scan cache goes out at roughly a tenth of the bytes
// for a few milliseconds of CPU. One read and one compress, no cache - the
// buffer lives for exactly one response.
//
// Anything binary, tiny, huge, or asked for with a Range goes out untouched:
// there is no seeking inside a gzip stream, and holding more than the ceiling
// in RAM to compress it would be a worse trade than sending the bytes.
//
// It reads the handle the caller already opened through its sandbox - never
// the file again by name.
func serveGzipTier(w http.ResponseWriter, r *http.Request, content io.ReadSeeker, ctype string,
	info os.FileInfo) bool {

	if r.Header.Get("Range") != "" || !acceptsGzip(r) {
		return false
	}
	size := info.Size()
	if size < gzMin || size > gzMax || !compressible(ctype) {
		return false
	}
	raw, err := io.ReadAll(content)
	// Rewind whatever happens: when this tier declines, ServeContent reads the
	// same handle again from the start.
	content.Seek(0, io.SeekStart)
	if err != nil {
		return false
	}
	packed, err := gzipBytes(raw)
	if err != nil {
		return false
	}

	// Conditional GET still has to work, and ServeContent is not doing it for
	// us on this path - so answer 304 by hand when the client's copy is current.
	w.Header().Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
	if notModified(r, info.ModTime()) {
		w.WriteHeader(http.StatusNotModified)
		return true
	}

	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Content-Length", strconv.Itoa(len(packed)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		w.Write(packed)
	}
	return true
}

// notModified is the If-Modified-Since test, to the second.
//
// java: HTTP dates have no sub-second precision, so a file modified within the
// same second as the client's copy must still count as unchanged - hence the
// Truncate. Getting this wrong means every reload re-downloads everything.
func notModified(r *http.Request, modTime time.Time) bool {
	header := r.Header.Get("If-Modified-Since")
	if header == "" {
		return false
	}
	since, err := http.ParseTime(header)
	if err != nil {
		return false
	}
	return !modTime.Truncate(time.Second).After(since)
}
