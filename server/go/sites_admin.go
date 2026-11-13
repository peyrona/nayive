// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// Admin panel, Web sites tab: who may open each site (its .password file).
// =============================================================================
//
// Three /api/admin actions, admin only (apiAdmin checks the role first):
//
//	list-sites                        -> {"sites": [{name, locked, broken, people}]}
//	set-site-person    site name password   add a person, or give one a new password
//	remove-site-person site name            take a person off; the last one makes the site public
//	rename-site-person site name new_name   a new name, the same password (the hash moves)
//
// The file format and the login itself are sites_auth.go's. Here only the
// admin's edits:
//
//   - The file is edited LINE BY LINE: notes ("#"), blank lines and lines this
//     code does not understand stay exactly as they were. Only the one
//     person's line is replaced, added or dropped.
//   - Written whole or not at all (atomicWriteFile: temp, fsync, rename, folder
//     sync), mode 0600 - the hashes are nobody else's business on the box.
//   - One edit at a time (sitePasswordMu), so two admin tabs never lose each
//     other's change in a read-modify-write.
//   - A site is one REAL folder right under sites_dir: not a symlink (it could
//     point anywhere, Nayive's own data included), not a hidden folder, not a
//     name Nayive answers itself.
//   - When no person is left, the file is removed and the site is public
//     again. A file that keeps no usable line would lock it for everybody
//     (sites_auth.go fails closed), which nobody asked for.
//
// Only the hash reaches the disk; the password is never logged or returned.

import (
	"bytes"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// sitePasswordMu serialises every admin edit of any .password file.
var sitePasswordMu sync.Mutex

// siteInfo is one row of list-sites.
type siteInfo struct {
	Name   string   `json:"name"`
	Locked bool     `json:"locked"` // a .password file is there
	Broken bool     `json:"broken"` // ...but it opens for nobody (fail closed)
	People []string `json:"people"` // the names in it, sorted
}

// adminListSites answers every site folder and who may open it.
func (s *Server) adminListSites(w http.ResponseWriter, r *http.Request) {
	dir := s.cfg.SitesPath()
	if dir == "" {
		sendJSON(w, r, http.StatusOK, map[string]any{"sites": []siteInfo{}})
		return
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		sendError(w, r, http.StatusNotFound, "cannot open the web sites folder")
		return
	}
	defer root.Close()
	entries, err := os.ReadDir(dir)
	if err != nil {
		sendError(w, r, http.StatusNotFound, "cannot read the web sites folder")
		return
	}
	sites := []siteInfo{}
	for _, e := range entries {
		name := e.Name()
		if !siteNameOK(name) || name == apkSite {
			continue
		}
		// A site is what serveSite serves: a folder, through a link too.
		if info, err := root.Stat(name); err != nil || !info.IsDir() {
			continue
		}
		row := siteInfo{Name: name, People: []string{}}
		raw, err := readSitePasswords(root, name)
		switch {
		case errors.Is(err, fs.ErrNotExist):
		case err != nil:
			row.Locked, row.Broken = true, true
		default:
			row.Locked = true
			people := parseSitePasswords(raw)
			row.Broken = len(people) == 0
			for n := range people {
				row.People = append(row.People, n)
			}
			sort.Strings(row.People)
		}
		sites = append(sites, row)
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"sites": sites})
}

// adminSetSitePerson adds a person to a site, or gives one a new password.
func (s *Server) adminSetSitePerson(w http.ResponseWriter, r *http.Request, body *adminRequest) {
	name := body.Name
	if err := sitePersonNameOK(name); err != nil {
		sendError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	if body.Password == nil || *body.Password == "" {
		sendError(w, r, http.StatusBadRequest, "the password is empty")
		return
	}
	line := name + ":" + hashPassword(*body.Password) // slow: outside the lock
	s.editSitePasswords(w, r, body.Site, func(lines []string) ([]string, error) {
		out, found := []string{}, false
		for _, l := range lines {
			if n, ok := sitePersonOf(l); ok && n == name {
				if !found {
					out = append(out, line) // the new password, in the old place
				}
				found = true
				continue
			}
			out = append(out, l)
		}
		if !found {
			out = append(out, line)
		}
		return out, nil
	})
}

// adminRemoveSitePerson takes a person off a site.
func (s *Server) adminRemoveSitePerson(w http.ResponseWriter, r *http.Request, body *adminRequest) {
	name := body.Name
	s.editSitePasswords(w, r, body.Site, func(lines []string) ([]string, error) {
		out, found := []string{}, false
		for _, l := range lines {
			if n, ok := sitePersonOf(l); ok && n == name {
				found = true
				continue
			}
			out = append(out, l)
		}
		if !found {
			return nil, errSitePersonMissing
		}
		return out, nil
	})
}

// adminRenameSitePerson gives a person a new name and keeps their password:
// only the name part of their line changes, in its place.
func (s *Server) adminRenameSitePerson(w http.ResponseWriter, r *http.Request, body *adminRequest) {
	name, newName := body.Name, body.NewName
	if err := sitePersonNameOK(newName); err != nil {
		sendError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	s.editSitePasswords(w, r, body.Site, func(lines []string) ([]string, error) {
		out, found := []string{}, false
		for _, l := range lines {
			n, ok := sitePersonOf(l)
			if ok && n == newName && newName != name {
				return nil, errSitePersonTaken
			}
			if ok && n == name {
				if found {
					continue // a doubled line: one is enough
				}
				found = true
				_, hash, _ := strings.Cut(strings.TrimSpace(l), ":")
				out = append(out, newName+":"+strings.TrimSpace(hash))
				continue
			}
			out = append(out, l)
		}
		if !found {
			return nil, errSitePersonMissing
		}
		return out, nil
	})
}

var (
	errSitePersonMissing = errors.New("that person is not on this site")
	errSitePersonTaken   = errors.New("someone on this site already has that name")
)

// editSitePasswords runs one edit of <site>/.password under sitePasswordMu:
// read it (missing = no lines), let `edit` change the lines (an error:
// errSitePersonMissing = 404, any other = 409), then write it back - or remove it when no
// person is left. Answers {"ok": true, "locked": bool} or an error.
func (s *Server) editSitePasswords(w http.ResponseWriter, r *http.Request, site string,
	edit func(lines []string) ([]string, error)) {

	dir, err := s.siteFolder(site)
	if err != nil {
		sendError(w, r, http.StatusNotFound, err.Error())
		return
	}
	file := filepath.Join(dir, sitePasswordFile)

	sitePasswordMu.Lock()
	defer sitePasswordMu.Unlock()

	var lines []string
	info, err := os.Lstat(file)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		sendError(w, r, http.StatusInternalServerError, "cannot read the .password file")
		return
	case !info.Mode().IsRegular():
		// A link or a folder: not ours to rewrite.
		sendError(w, r, http.StatusConflict, ".password is not a plain file; fix it by hand")
		return
	case info.Size() > sitePasswordMax:
		sendError(w, r, http.StatusConflict, ".password is too big; fix it by hand")
		return
	default:
		raw, err := os.ReadFile(file)
		if err != nil {
			sendError(w, r, http.StatusInternalServerError, "cannot read the .password file")
			return
		}
		lines = splitSiteLines(raw)
	}

	out, err := edit(lines)
	if errors.Is(err, errSitePersonMissing) {
		sendError(w, r, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		sendError(w, r, http.StatusConflict, err.Error())
		return
	}

	joined := strings.Join(out, "\n")
	if joined != "" {
		joined += "\n"
	}
	if len(parseSitePasswords([]byte(joined))) == 0 {
		// Nobody left: the site is public again.
		if err := os.Remove(file); err != nil && !errors.Is(err, fs.ErrNotExist) {
			sendError(w, r, http.StatusInternalServerError, "could not remove the .password file")
			return
		}
		if err := syncDir(dir); err != nil {
			sendError(w, r, http.StatusInternalServerError, "could not save")
			return
		}
		s.log.Info("site is public again", "site", site)
		sendJSON(w, r, http.StatusOK, map[string]any{"ok": true, "locked": false})
		return
	}
	if err := atomicWriteFile(file, []byte(joined), 0o600); err != nil {
		sendError(w, r, http.StatusInternalServerError, "could not save the .password file")
		return
	}
	s.log.Info("site people changed", "site", site)
	sendJSON(w, r, http.StatusOK, map[string]any{"ok": true, "locked": true})
}

// siteFolder is the absolute path of one site's folder, for a write: a real
// folder right under sites_dir, never a link.
func (s *Server) siteFolder(site string) (string, error) {
	base := s.cfg.SitesPath()
	if base == "" {
		return "", errors.New("no web sites folder is set")
	}
	if !siteNameOK(site) || site == apkSite {
		return "", errors.New("no such site")
	}
	dir := filepath.Join(base, site)
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		// A symlink lands here too: Lstat does not follow it.
		return "", errors.New("no such site, or it is a link")
	}
	return dir, nil
}

// apkSite is the Android app download folder (deploy.sh fills it). It is
// Nayive's own, with its own users, so the admin Web sites list never shows it.
const apkSite = "app"

// siteNameOK: a folder name serveSite would answer as a site.
func siteNameOK(name string) bool {
	return name != "" && !strings.HasPrefix(name, ".") && !reservedSites[name] &&
		!strings.ContainsAny(name, `/\`)
}

// sitePersonNameOK is the rule for a name in a .password file (the CLI's too).
func sitePersonNameOK(name string) error {
	switch {
	case name == "":
		return errors.New("the name is empty")
	case len(name) > 64:
		return errors.New("the name is too long (64 characters at most)")
	case strings.TrimSpace(name) != name || strings.ContainsAny(name, ":\r\n") || strings.HasPrefix(name, "#"):
		return errors.New(`a name cannot hold ":" or a line break, start with "#", or start or end with a space`)
	}
	return nil
}

// sitePersonOf is the person a line is about, as parseSitePasswords reads it.
func sitePersonOf(line string) (string, bool) {
	l := strings.TrimSpace(line)
	if l == "" || strings.HasPrefix(l, "#") {
		return "", false
	}
	name, hash, ok := strings.Cut(l, ":")
	name = strings.TrimSpace(name)
	if !ok || name == "" || !isHashedPassword(strings.TrimSpace(hash)) {
		return "", false
	}
	return name, true
}

// splitSiteLines splits the file into lines, without the last empty one.
func splitSiteLines(raw []byte) []string {
	raw = bytes.TrimSuffix(raw, []byte("\n"))
	if len(raw) == 0 {
		return nil
	}
	lines := strings.Split(string(raw), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSuffix(l, "\r")
	}
	return lines
}
