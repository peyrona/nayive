package main

// =============================================================================
// Read-only sharing between Nayive users.
// =============================================================================
//
// One user (the OWNER) lets another (the RECIPIENT) see one file or one folder
// out of their own home. Nothing is copied: the recipient reads the owner's
// bytes straight from disk, and may never write them.
//
//	grant = {id, owner, to, slug, root, app, mode, title, created}
//	path  = "shared/<slug>/..."  in the recipient's own path space
//
// Users.ResolvePath turns that path into the owner's real file with
// writable=false, so every existing write guard (PUT / mkdir / rename / delete)
// refuses it without a line of new code. This file only answers two questions:
// "which grant is this?" and "where does it point?".
//
// Grants live in config/shares.json and are held in memory - ResolvePath runs
// on every single file request and must never touch the disk for this.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Apps is what a grant may ask to be opened as. Only a hint for the recipient's
// UI - every grant is a plain read-only file or folder whatever this says.
var Apps = []string{"folder", "file", "photos", "trips", "split"}

// ExtraSeg is the path segment that asks for one of a shared TRIP's outside
// files:  shared/<slug>/~/<the owner's own path>  . See ExtraPath at the bottom.
const ExtraSeg = "~"

// Modes is what the recipient may do. "ro" is the default and the whole story
// for most grants; "add" additionally lets them PUT NEW files into the shared
// folder - their own holiday photos into the album somebody hosts - and nothing
// else: no overwriting, no deleting, no renaming, no passing the share on.
// Those four are refused in the file API, which asks IsSharedPath on each.
//
// Only a FOLDER makes sense to add to, and only one that is not itself an app's
// private document: a trip folder holds trip.json, which the apps rewrite whole,
// so two writers would lose each other's work.
var (
	Modes       = []string{"ro", "add"}
	AddableApps = []string{"folder", "photos"}
)

// Grant is one row of config/shares.json.
//
// java: a STRUCT rather than a map keeps the JSON field order stable, which
// matters because this file is read by people and written by two servers.
type Grant struct {
	ID      string `json:"id"`
	Owner   string `json:"owner"`
	To      string `json:"to"`
	Slug    string `json:"slug"`
	Root    string `json:"root"`
	App     string `json:"app"`
	Mode    string `json:"mode"`
	Title   string `json:"title"`
	Created int64  `json:"created"`
}

// Shares is the in-memory grant table, loaded from disk on first use.
type Shares struct {
	mu       sync.Mutex
	path     string
	homesDir string
	loaded   bool
	grants   []Grant
	log      Logger

	// extraMu guards the trip-extras cache below; it is a SEPARATE lock because
	// reading a trip.json does I/O and must not block the hot lookup path.
	extraMu    sync.Mutex
	extraCache map[string]tripExtras

	// broken: shares.json existed but could not be read at start-up. save()
	// moves it aside before writing, so what it held is never lost. Guarded
	// by mu.
	broken bool
}

// tripExtras is what one shared trip lends outside its own folder, cached by
// trip.json's modification time.
type tripExtras struct {
	mtime  time.Time
	docs   map[string]bool // "/"-joined linked-document paths
	photos []string        // the photo folder's segments, or nil
}

// NewShares does no I/O; the file is read the first time anything asks.
func NewShares(configDir, homesDir string, log Logger) *Shares {
	return &Shares{
		path:       filepath.Join(configDir, "shares.json"),
		homesDir:   homesDir,
		log:        log,
		extraCache: make(map[string]tripExtras),
	}
}

// sharesFile is the on-disk wrapper: {"shares": [...]}.
type sharesFile struct {
	Shares []Grant `json:"shares"`
}

// ensureLoaded fills the table the first time anything asks. Caller holds mu.
func (s *Shares) ensureLoaded() {
	if s.loaded {
		return
	}
	s.loaded = true
	s.grants = nil

	raw, err := os.ReadFile(s.path)
	if err != nil {
		if !os.IsNotExist(err) {
			s.log.Error("shares.json is unreadable - starting with no shares", "err", err)
			s.broken = true
		}
		return // nothing shared yet - the normal first run
	}

	var file sharesFile
	if err := json.Unmarshal(raw, &file); err != nil {
		// The Python also accepts a bare top-level list, from before the
		// wrapper existed. Try that before giving up.
		var bare []Grant
		if err2 := json.Unmarshal(raw, &bare); err2 != nil {
			s.log.Error("shares.json is unreadable - starting with no shares", "err", err)
			s.broken = true
			return
		}
		file.Shares = bare
	}
	// Keep only well-formed entries, so one hand-edited line cannot take the
	// server down.
	for _, g := range file.Shares {
		if g.Slug != "" {
			s.grants = append(s.grants, g)
		}
	}
}

// save writes the whole list back. Caller holds mu.
func (s *Shares) save() {
	// NEVER WRITE OVER A FILE THAT COULD NOT BE READ. The table in memory
	// started empty, so saving it straight away would wipe every grant the
	// file still holds: one bad hand edit, and every share gone for good.
	// Move it aside first, dated, where the admin can still recover it. (A
	// deliberate difference from the Python, which writes straight over.)
	if s.broken {
		aside := s.path + ".broken-" + time.Now().Format("2006-01-02-150405")
		if err := os.Rename(s.path, aside); err != nil && !os.IsNotExist(err) {
			s.log.Error("shares.json is unreadable and cannot be moved aside - not saving", "err", err)
			return
		}
		s.log.Warn("unreadable shares.json moved aside", "kept", aside)
		s.broken = false
	}
	if err := atomicWriteJSON(s.path, sharesFile{Shares: s.grants}, 4); err != nil {
		s.log.Error("cannot save shares.json", "err", err)
	}
}

// -----------------------------------------------------------------------------
// slugs - the second path segment the recipient sees: shared/<slug>/...
// -----------------------------------------------------------------------------

var slugBad = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify turns "Viajes/Lisboa 2026" into "lisboa-2026": ASCII, lowercase,
// dashes only. Accented letters are simply dropped - good enough for a URL-ish
// path segment, and the real title is kept in the grant's Title field.
func Slugify(text string) string {
	slug := strings.Trim(slugBad.ReplaceAllString(strings.ToLower(text), "-"), "-")
	if len(slug) > 48 {
		slug = slug[:48]
	}
	if slug == "" {
		return "compartido"
	}
	return slug
}

// uniqueSlug returns a slug not already used by anything shared with `to`.
// Caller holds mu.
func (s *Shares) uniqueSlug(to, base string) string {
	taken := make(map[string]bool)
	for _, g := range s.grants {
		if g.To == to {
			taken[g.Slug] = true
		}
	}
	if !taken[base] {
		return base
	}
	for n := 2; ; n++ {
		candidate := base + "-" + itoa(n)
		if !taken[candidate] {
			return candidate
		}
	}
}

// -----------------------------------------------------------------------------
// where a grant points
// -----------------------------------------------------------------------------

// RootPath is the grant's target as a real absolute path, or "" if it has gone
// away or no longer sits inside its owner's home.
//
// The second check matters: the folder was validated when the grant was made,
// but the owner could have deleted it since and put a symlink in its place.
// Every request re-checks.
func (s *Shares) RootPath(g *Grant) string {
	if g == nil {
		return ""
	}
	ownerHome, err := resolveExisting(filepath.Join(s.homesDir, g.Owner))
	if err != nil {
		return ""
	}
	parts := splitPath(g.Root)
	if len(parts) == 0 || hasDotDot(parts) {
		return ""
	}
	target, err := resolveExisting(filepath.Join(append([]string{ownerHome}, parts...)...))
	if err != nil {
		return ""
	}
	if !isInside(ownerHome, target) {
		return ""
	}
	if _, err := os.Lstat(target); err != nil {
		return ""
	}
	return target
}

// -----------------------------------------------------------------------------
// lookups
// -----------------------------------------------------------------------------

// Find is the grant shared WITH `user` under `slug`, or nil. THE hot path:
// ResolvePath calls this on every request for a shared/... file.
//
// java: it returns a COPY (a *Grant pointing at a fresh value), so a caller can
// never mutate the table's own state.
func (s *Shares) Find(user, slug string) *Grant {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoaded()
	for i := range s.grants {
		if s.grants[i].To == user && s.grants[i].Slug == slug {
			g := s.grants[i]
			return &g
		}
	}
	return nil
}

// ForUser is everything shared WITH `user`, newest first.
func (s *Shares) ForUser(user string) []Grant {
	return s.filter(func(g *Grant) bool { return g.To == user })
}

// ByOwner is everything `user` has shared OUT, newest first.
func (s *Shares) ByOwner(user string) []Grant {
	return s.filter(func(g *Grant) bool { return g.Owner == user })
}

func (s *Shares) filter(keep func(*Grant) bool) []Grant {
	s.mu.Lock()
	s.ensureLoaded()
	var out []Grant
	for i := range s.grants {
		if keep(&s.grants[i]) {
			out = append(out, s.grants[i])
		}
	}
	s.mu.Unlock()

	sort.SliceStable(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	return out
}

// HasAny reports whether anything at all is shared with `user` - it decides
// whether the `shared/` node appears in their file tree.
func (s *Shares) HasAny(user string) bool {
	return len(s.ForUser(user)) > 0
}

// -----------------------------------------------------------------------------
// changes
// -----------------------------------------------------------------------------

// CanAdd reports whether the recipient of this grant may put NEW files into it.
// Never true for a plain file, a trip, or a grant that was made read-only.
func CanAdd(g *Grant) bool {
	return g != nil && g.Mode == "add" && contains(AddableApps, g.App)
}

// Create adds a grant. The caller has already checked that `root` is a real
// path inside `owner`'s home and that `to` is a real user - this only stores it.
// Returns nil when that exact share already exists (the caller answers 409).
func (s *Shares) Create(owner, to, root, app, title, mode string) *Grant {
	if !contains(Apps, app) {
		app = "folder"
	}
	// "add" on something you cannot add to quietly becomes "ro": one place
	// decides it, so no caller can create a grant that means nothing.
	if !contains(Modes, mode) || !contains(AddableApps, app) {
		mode = "ro"
	}
	if title == "" {
		title = lastSegment(root)
	}

	s.mu.Lock()
	s.ensureLoaded()
	for i := range s.grants {
		if s.grants[i].Owner == owner && s.grants[i].To == to && s.grants[i].Root == root {
			s.mu.Unlock()
			return nil // already shared
		}
	}
	grant := Grant{
		ID:      newShareID(),
		Owner:   owner,
		To:      to,
		Slug:    s.uniqueSlug(to, Slugify(title)),
		Root:    root,
		App:     app,
		Mode:    mode,
		Title:   title,
		Created: time.Now().Unix(),
	}
	s.grants = append(s.grants, grant)
	s.save()
	s.mu.Unlock()

	s.log.Info("share created", "owner", owner, "to", to, "root", root)
	return &grant
}

// Revoke drops one grant. Only its owner may. True when something was removed.
func (s *Shares) Revoke(shareID, owner string) bool {
	s.mu.Lock()
	s.ensureLoaded()
	kept := s.grants[:0:0] // a fresh slice; never alias the one we are filtering
	for _, g := range s.grants {
		if !(g.ID == shareID && g.Owner == owner) {
			kept = append(kept, g)
		}
	}
	if len(kept) == len(s.grants) {
		s.mu.Unlock()
		return false
	}
	s.grants = kept
	s.save()
	s.mu.Unlock()

	s.log.Info("share revoked", "id", shareID, "by", owner)
	return true
}

// DropUser forgets every grant this user owns or received (the admin deleted
// them). Returns how many went.
func (s *Shares) DropUser(name string) int {
	s.mu.Lock()
	s.ensureLoaded()
	kept := s.grants[:0:0]
	for _, g := range s.grants {
		if g.Owner != name && g.To != name {
			kept = append(kept, g)
		}
	}
	gone := len(s.grants) - len(kept)
	if gone > 0 {
		s.grants = kept
		s.save()
	}
	s.mu.Unlock()

	if gone > 0 {
		s.log.Info("dropped shares of a deleted user", "count", gone, "user", name)
	}
	return gone
}

// -----------------------------------------------------------------------------
// the synthetic "Compartido conmigo" folder
// -----------------------------------------------------------------------------

// RootNodes are the children of the virtual `shared/` folder, in the same node
// shape every other listing uses.
//
// A grant whose target has gone away is skipped, so a share the owner deleted
// quietly disappears instead of erroring when it is opened.
func (s *Shares) RootNodes(user string) []Node {
	out := []Node{}
	for i, g := range s.ForUser(user) {
		_ = i
		target := s.RootPath(&g)
		if target == "" {
			continue
		}
		info, err := os.Stat(target)
		if err != nil {
			continue
		}
		node := Node{Path: "shared/" + g.Slug}
		if info.IsDir() {
			node.Nodes = []Node{}
			node.MTime = ptrInt64(info.ModTime().Unix())
		} else {
			node.Size = ptrInt64(info.Size())
			node.MTime = ptrInt64(info.ModTime().Unix())
		}
		// Extra fields the plain file API never sends; the apps use them to show
		// "Compartido por ana" and to open the item in the right app.
		node.Shared = &SharedBy{By: g.Owner, Title: g.Title, App: g.App}
		out = append(out, node)
	}
	return out
}

// -----------------------------------------------------------------------------
// what a shared TRIP lends outside its own folder
//
// A trip folder holds trip.json and the documents that were uploaded INTO it -
// those travel with the share for free. But a trip also POINTS at two kinds of
// thing that live elsewhere in the owner's files/:
//
//	a kind:"link" document  ->  doc.path, e.g. "files/viajes/billete.pdf"
//	the trip's photo folder ->  trip.photosDir, e.g. "files/fotos/lisboa"
//
// Sharing the trip has to lend those too, or the recipient sees a document list
// with holes in it. They are reached as
//
//	shared/<slug>/~/files/viajes/billete.pdf
//
// and the whitelist is READ FROM THE TRIP ITSELF on every request (cached by
// trip.json's mtime). That is the whole point: a document the owner adds
// tomorrow is lent tomorrow, one they remove stops being lent, and nothing has
// to be written down or kept in step when a share is made or revoked.
// -----------------------------------------------------------------------------

// tripDoc and tripFile are just enough of trip.json to read the whitelist.
type tripDoc struct {
	Kind string `json:"kind"`
	Path string `json:"path"`
}

type tripStage struct {
	Documents []tripDoc `json:"documents"`
}

type tripFile struct {
	Documents []tripDoc   `json:"documents"`
	Stages    []tripStage `json:"stages"`
	PhotosDir string      `json:"photosDir"`
}

// ExtraPath is where "shared/<slug>/~/<parts>" really is, or "" when this grant
// does not lend it.
//
// Only a shared TRIP lends anything this way, and only what its own trip.json
// points at right now: one of its linked documents (exact match) or something
// inside its photo folder (prefix match).
func (s *Shares) ExtraPath(g *Grant, parts []string) string {
	if g == nil || g.App != "trips" {
		return ""
	}
	root := s.RootPath(g)
	if root == "" {
		return ""
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return ""
	}

	want := cleanSegments(parts)
	if len(want) == 0 || hasDotDot(want) {
		return ""
	}

	extras := s.tripExtras(root)
	if !extras.docs[strings.Join(want, "/")] && !hasPrefixSegments(want, extras.photos) {
		return ""
	}

	ownerHome, err := resolveExisting(filepath.Join(s.homesDir, g.Owner))
	if err != nil {
		return ""
	}
	target, err := resolveExisting(filepath.Join(append([]string{ownerHome}, want...)...))
	if err != nil {
		return ""
	}
	// The same containment test RootPath uses. ResolvePath checks it again
	// against the owner's home; doing it here too keeps this function safe alone.
	if !isInside(ownerHome, target) {
		return ""
	}
	if _, err := os.Lstat(target); err != nil {
		return ""
	}
	return target
}

// tripExtras is the whitelist for the trip in `root`, re-read only when
// trip.json changed.
func (s *Shares) tripExtras(root string) tripExtras {
	tripJSON := filepath.Join(root, "trip.json")
	info, err := os.Stat(tripJSON)
	if err != nil {
		return tripExtras{} // not a trip folder (or gone)
	}

	s.extraMu.Lock()
	hit, found := s.extraCache[tripJSON]
	s.extraMu.Unlock()
	if found && hit.mtime.Equal(info.ModTime()) {
		return hit
	}

	fresh := readTripExtras(tripJSON) // outside the lock: it does I/O
	fresh.mtime = info.ModTime()

	s.extraMu.Lock()
	s.extraCache[tripJSON] = fresh
	s.extraMu.Unlock()
	return fresh
}

// readTripExtras reads one trip.json. Anything unreadable or oddly shaped lends
// nothing.
func readTripExtras(path string) tripExtras {
	out := tripExtras{docs: make(map[string]bool)}

	var trip tripFile
	if !loadJSONFile(path, &trip) {
		return out
	}

	// A document can hang off the trip itself or off any of its stages.
	lists := [][]tripDoc{trip.Documents}
	for _, st := range trip.Stages {
		lists = append(lists, st.Documents)
	}
	for _, list := range lists {
		for _, d := range list {
			if d.Kind != "link" {
				continue
			}
			if ref := splitRef(d.Path); len(ref) > 0 {
				out.docs[strings.Join(ref, "/")] = true
			}
		}
	}
	out.photos = splitRef(trip.PhotosDir)
	return out
}

// splitRef turns "files/viajes/x.pdf" into its segments, or nil when the value
// is empty or tries to walk up.
func splitRef(value string) []string {
	parts := splitPath(value)
	if len(parts) == 0 || hasDotDot(parts) {
		return nil
	}
	return parts
}

// hasPrefixSegments reports whether `want` starts with every segment of
// `prefix`. An empty prefix lends nothing (never everything).
func hasPrefixSegments(want, prefix []string) bool {
	if len(prefix) == 0 || len(want) < len(prefix) {
		return false
	}
	for i, seg := range prefix {
		if want[i] != seg {
			return false
		}
	}
	return true
}
