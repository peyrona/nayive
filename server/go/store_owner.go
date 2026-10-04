// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// Whose save is this? - one browser, two accounts.
// =============================================================================
//
// shared/store.js queues a save in the browser while the server cannot be
// reached, and sends it later with whatever session cookie the browser holds
// THEN. If another account signed in on that browser meanwhile - a sign-out,
// an expired session, a second tab - the first person's file went into the
// second person's home.
//
// So the page learns who it belongs to when it loads - the readable cookie
// "nayive_who", set beside the session cookie - and every queued save carries
// that name in X-Nayive-User. A save whose name is not the session's is
// refused with 423: the browser keeps it, and it goes up once its owner signs
// in again. No header = a page from before this (or one that loaded signed
// out): taken as before.
//
// 423, not 401 (the "session expired" bar - wrong for the person signed in),
// not 403/409 (the store drops those), not 412 (a conflict: offers a copy),
// not 421 (Chrome re-sends a 421 on a new connection by itself).
//
// NOT ONLY SAVES (L5). The page's other changes go up with the cookie held
// NOW too: an editor's "Restore the previous copy" or "Clean copy", Drive's
// delete or move in a tab left open. shared/gum-api.js sends the header on
// every request that changes files, and every route that changes them asks
// saveOwnerOK: all of /api/files but its reads (a save, a move or rename, a
// delete or purge, the bin's restore / delete / empty, a new folder, a copy,
// the settings), /api/zip's Extract and Compress, /api/office's twin, and
// Chat's "Copiar" / "Editar" (which write into the owner's files).
//
// The cookie is NOT HttpOnly on purpose: it holds only "role:name", which the
// page shows anyway. It never authenticates anything.
//
// AN ADMIN RENAME (L3). Saves queued before the admin renamed ana to ana2
// carry "user:ana", which is nobody's any more: never sent, never shown, and
// the launcher's sign-out deletes them. So the server keeps the names each
// account had (config/renames.json, accountRenames below) and hands them to
// the account's pages, for shared/store.js to re-tag those saves once:
//
//   - GET /api/whoami, as ana2: "renamed": {"who": "user:ana2", "from":
//     ["user:ana"]} - absent when there are none. "who" is the nayive_who
//     value of the account they now belong to: a page re-tags only when it is
//     its own ME. Every value is escaped exactly as whoValue escapes it.
//   - the readable cookie "nayive_was", set beside nayive_who (sign-in,
//     whoami) and with its lifetime: the same values, the account's first,
//     joined by "/" (a valid cookie byte that whoValue always escapes inside
//     a value): "user:ana2/user:ana". Cleared at sign-out, and by a whoami
//     that has none to give.
//   - a save tagged "user:ana" from ana2's session is ana2's: taken, not 423
//     (Server.saveOwnerOK) - a page loaded before the rename tags that way.
//
// A name given to a NEW account (create-user, or another rename into it)
// stops being an old name of anyone - its saves must never reach the renamed
// person, nor theirs the newcomer - and a deleted account's names go with it.

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	WhoCookieName = "nayive_who"
	WasCookieName = "nayive_was"
	whoHeader     = "X-Nayive-User"
)

// whoValue is the cookie's value and the header's: "role:name", escaped so a
// name with a space, a comma or an accent is still one cookie token. The role
// is in it because an admin and a user may share a name.
func whoValue(role, user string) string {
	return url.PathEscape(role + ":" + user)
}

// whoCookieHeader lives exactly as long as the session cookie beside it.
func whoCookieHeader(role, user string, ttl time.Duration, remember, secure bool) string {
	out := WhoCookieName + "=" + whoValue(role, user) + "; SameSite=Lax; Path=/"
	if remember {
		out += "; Max-Age=" + strconv.Itoa(int(ttl.Seconds()))
	}
	if secure {
		out += "; Secure"
	}
	return out
}

func clearWhoCookieHeader() string {
	return WhoCookieName + "=; SameSite=Lax; Path=/; Max-Age=0"
}

// saveOwnerOK refuses a save queued under another account. True = go on.
//
// A save queued under a name the admin renamed to this account is this
// account's (L3). One method, not a plain check beside it: a caller that
// skipped the old names would hold the renamed person's saves at 423 for good.
func (s *Server) saveOwnerOK(w http.ResponseWriter, r *http.Request, role, user string) bool {
	h := r.Header.Get(whoHeader)
	if h == "" || h == whoValue(role, user) {
		return true
	}
	if role == "user" {
		for _, old := range s.users.RenamedFrom(user) {
			if h == whoValue("user", old) {
				return true
			}
		}
	}
	sendError(w, r, http.StatusLocked, "this save belongs to another account")
	return false
}

// wasValue is the nayive_was cookie's value: the account's who value, then
// one per old name. "" = no old names.
func wasValue(user string, from []string) string {
	if len(from) == 0 {
		return ""
	}
	out := []string{whoValue("user", user)}
	for _, old := range from {
		out = append(out, whoValue("user", old))
	}
	return strings.Join(out, "/")
}

// wasCookieHeader lives exactly as long as the nayive_who cookie beside it.
func wasCookieHeader(value string, ttl time.Duration, remember, secure bool) string {
	out := WasCookieName + "=" + value + "; SameSite=Lax; Path=/"
	if remember {
		out += "; Max-Age=" + strconv.Itoa(int(ttl.Seconds()))
	}
	if secure {
		out += "; Secure"
	}
	return out
}

func clearWasCookieHeader() string {
	return WasCookieName + "=; SameSite=Lax; Path=/; Max-Age=0"
}

// -----------------------------------------------------------------------------
// the old names: config/renames.json
// -----------------------------------------------------------------------------

// accountRename is one row of config/renames.json: the account now called To
// was called From until At.
type accountRename struct {
	From string    `json:"from"`
	To   string    `json:"to"`
	At   time.Time `json:"at"`
}

type renamesFile struct {
	Renames []accountRename `json:"renames"`
}

// accountRenames is config/renames.json, held in memory. Its own lock: whoami
// and the save check ask it, and must not wait on a config.json write.
type accountRenames struct {
	path string
	log  Logger

	mu     sync.Mutex
	loaded bool
	broken bool // the file could not be read: moved aside before the next save
	rows   []accountRename
}

func newAccountRenames(configDir string, log Logger) *accountRenames {
	return &accountRenames{path: filepath.Join(configDir, "renames.json"), log: log}
}

// loadLocked reads the file the first time anything asks. mu held.
func (a *accountRenames) loadLocked() {
	if a.loaded {
		return
	}
	a.loaded = true
	var f renamesFile
	if ok, broken := loadTable(a.path, &f, a.log, "starting with no old names"); ok {
		a.rows = f.Renames
	} else {
		a.broken = broken
	}
}

// saveLocked writes the table back. A failed write is only logged: the rename
// itself is done, and memory still answers until a restart. mu held.
func (a *accountRenames) saveLocked() {
	rows := a.rows
	if rows == nil {
		rows = []accountRename{}
	}
	saveTable(a.path, &a.broken, renamesFile{Renames: rows}, a.log)
}

// dropLocked removes every row that names `name`, either way round, and says
// whether there was one. mu held.
func (a *accountRenames) dropLocked(name string) bool {
	var kept []accountRename
	for _, r := range a.rows {
		if r.From != name && r.To != name {
			kept = append(kept, r)
		}
	}
	changed := len(kept) != len(a.rows)
	a.rows = kept
	return changed
}

// renamed notes old -> name. Rows that named `name` go first (it is a new
// account's name now, see the top), the names `old` had follow it to `name`
// (ana -> ana2 -> ana3: both are ana3's), and a name renamed back to what it
// was is no old name of itself.
func (a *accountRenames) renamed(old, name string, at time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.loadLocked()
	a.dropLocked(name)
	var kept []accountRename
	for _, r := range a.rows {
		if r.To == old {
			r.To = name
		}
		if r.From != r.To {
			kept = append(kept, r)
		}
	}
	a.rows = append(kept, accountRename{From: old, To: name, At: at.UTC().Truncate(time.Second)})
	a.saveLocked()
}

// forget drops every row naming `name`: a new account took it, or it was
// deleted.
func (a *accountRenames) forget(name string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.loadLocked()
	if a.dropLocked(name) {
		a.saveLocked()
	}
}

// from is the names the account `name` had, oldest first.
func (a *accountRenames) from(name string) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.loadLocked()
	var out []string
	for _, r := range a.rows {
		if r.To == name {
			out = append(out, r.From)
		}
	}
	return out
}

// isAccount: homes/<name>/data/config.json is there - the test ListUserNames
// makes.
func isAccount(homesDir, name string) bool {
	info, err := os.Stat(filepath.Join(homesDir, name, "data", "config.json"))
	return err == nil && !info.IsDir()
}

// moveOwner is `rows` after an account rename (`to` the new name) or deletion
// (`to` ""): the owner's rows renamed or dropped, every other row as it was,
// in the same order. found says whether the owner had any.
func moveOwner[T any](rows []T, owner, to string, ownerOf func(*T) *string) (kept []T, found bool) {
	kept = rows[:0:0]
	for _, r := range rows {
		if *ownerOf(&r) != owner {
			kept = append(kept, r)
			continue
		}
		found = true
		if to != "" {
			*ownerOf(&r) = to
			kept = append(kept, r)
		}
	}
	return kept, found
}
