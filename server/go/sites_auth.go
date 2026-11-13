package main

// =============================================================================
// A password on a static web site - the browser's own login box.
// =============================================================================
//
// A site folder that holds a file named ".password" asks for a name and a
// password (HTTP Basic Auth) before it sends anything. No file, no question:
// the site stays public, as before. The file is one line per person:
//
//	ana:$pbkdf2-sha256$600000$<salt>$<key>
//
// made by `nayive -site-password ana` (main.go). The hash is the one Nayive's
// own accounts use (password_hash.go); a plain-text password in the file is
// never accepted. Lines starting with "#" are notes. The file is read on every
// request, so a change works at once with no restart, and it is never served
// itself: serveSite refuses every name starting with ".".
//
// Fail closed: only "there is no .password" means public. A file that cannot
// be read, is too big, or holds no usable line locks the site for everybody.
//
// The browser sends the name and password again with EVERY file (each image,
// each stylesheet), and one check costs ~0.15 s. So a good login is remembered
// for loginTTL, keyed by a SHA-256 of site + name + password + the file's own
// bytes - never the password itself. Editing the file changes the key, so a
// removed person is out at their next request.
//
// Guessing: checks from one address run one at a time (Server.authLocks), a
// wrong one costs authFailDelay, and siteFailMax DIFFERENT wrong passwords
// from one address lock it out for a while, doubling each time. The same wrong
// password sent again (a browser holding an old password asks for 30 images
// at once) costs nothing and is not counted. A request with no password at all
// is the normal first visit, and is never counted.
//
// Limit: site pages run sandboxed (sites.go, siteSandbox), and from a sandboxed
// page the browser sends the password only for pages, images, stylesheets and
// classic <script src>. Web fonts, fetch()/XHR and <script type="module"> go
// without it and get 401 on a protected site (tested in Chromium, 2026-11-13).

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	sitePasswordFile = ".password"
	sitePasswordMax  = 64 << 10 // a bigger .password is a mistake, not a list of people

	siteLoginTTL   = 10 * time.Minute // a good login is not hashed again for this long
	siteFailMax    = 5                // different wrong passwords before a lock-out
	siteLockFirst  = time.Minute      // the first lock-out; each next one doubles
	siteLockMax    = time.Hour        // ...up to this
	siteFailForget = time.Hour        // an address quiet this long starts again from zero

	siteGuardMaxEntries = 10000 // above this, expired entries are swept; then all
)

// siteGuard is the memory of good logins and of wrong guesses. The zero value
// is ready to use.
type siteGuard struct {
	mu    sync.Mutex
	good  map[[32]byte]time.Time // login fingerprint -> valid until
	fails map[string]*siteFails  // client address (IPv6: its /64) -> its wrong guesses
}

type siteFails struct {
	wrong    [][32]byte // the different wrong logins since the last lock-out
	locks    int        // lock-outs so far; sets the next one's length
	until    time.Time  // locked out until then
	lastSeen time.Time
}

// siteLocked guards one request to a site. It reports true when it has
// answered (401, 429) and the caller must stop; false lets the file go out.
func (s *Server) siteLocked(w http.ResponseWriter, r *http.Request, root *os.Root, site string) bool {
	raw, err := readSitePasswords(root, site)
	if errors.Is(err, fs.ErrNotExist) {
		return false // a public site
	}
	if err != nil {
		s.log.Warn("site password file unusable - site locked", "site", site, "err", err)
		return siteChallenge(w, r, site)
	}
	people := parseSitePasswords(raw)
	if len(people) == 0 {
		s.log.Warn("site password file has no usable line - site locked", "site", site)
		return siteChallenge(w, r, site)
	}

	// The browser may keep a copy of any protected page: only this visitor's.
	w.Header().Set("Cache-Control", "private, no-cache")

	name, password, given := r.BasicAuth()
	if !given {
		return siteChallenge(w, r, site) // the first visit: the browser asks
	}

	addr := siteAddr(r)
	fp := siteFingerprint(site, name, password, raw)
	now := time.Now()

	if wait := s.siteGuard.lockedFor(addr, now); wait > 0 {
		return siteTooMany(w, r, wait)
	}
	if s.siteGuard.known(fp, now) {
		return false
	}
	if s.siteGuard.knownWrong(fp, addr) {
		return siteChallenge(w, r, site)
	}

	// One check at a time from one address.
	unlock := s.authLocks.Lock("site-addr:" + addr)
	defer unlock()

	// A request that waited for the lock may find its answer ready.
	now = time.Now()
	if wait := s.siteGuard.lockedFor(addr, now); wait > 0 {
		return siteTooMany(w, r, wait)
	}
	if s.siteGuard.known(fp, now) {
		return false
	}
	if s.siteGuard.knownWrong(fp, addr) {
		return siteChallenge(w, r, site)
	}

	// An unknown name is checked against a dummy hash, so it takes as long as
	// a wrong password: no telling which names exist.
	stored, found := people[name]
	if !found {
		stored = pwDummyHash()
	}
	ok, _ := checkPassword(password, stored)
	if ok && found {
		s.siteGuard.remember(fp, addr, time.Now())
		return false
	}

	time.Sleep(authFailDelay)
	if s.siteGuard.wrongGuess(fp, addr, time.Now()) {
		s.log.Warn("site password: too many wrong guesses", "site", site, "addr", addr)
	}
	return siteChallenge(w, r, site)
}

// readSitePasswords reads <site>/.password inside the sites root. A missing
// file is fs.ErrNotExist; anything else wrong with it is another error.
func readSitePasswords(root *os.Root, site string) ([]byte, error) {
	name := site + "/" + sitePasswordFile
	info, err := root.Stat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	if info.Size() > sitePasswordMax {
		return nil, errors.New("file too big")
	}
	return root.ReadFile(name)
}

// parseSitePasswords turns the file into name -> stored hash. Blank lines,
// "#" notes and lines that are not "name:$pbkdf2-sha256$..." are skipped.
func parseSitePasswords(raw []byte) map[string]string {
	people := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, hash, ok := strings.Cut(line, ":")
		name, hash = strings.TrimSpace(name), strings.TrimSpace(hash)
		if !ok || name == "" || !isHashedPassword(hash) {
			continue
		}
		people[name] = hash
	}
	return people
}

// siteFingerprint stands for one login attempt on one version of the file.
func siteFingerprint(site, name, password string, file []byte) [32]byte {
	fileSum := sha256.Sum256(file)
	h := sha256.New()
	for _, part := range []string{site, name, password} {
		h.Write([]byte(strconv.Itoa(len(part)) + ":" + part))
	}
	h.Write(fileSum[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// siteAddr is the client's address as the guessing limit counts it.
func siteAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return addrKey(host)
}

// siteChallenge answers 401 with the header that makes the browser show its
// login box. Always true: the request has been answered.
func siteChallenge(w http.ResponseWriter, r *http.Request, site string) bool {
	realm := strings.NewReplacer(`"`, "", `\`, "").Replace(site)
	w.Header().Set("WWW-Authenticate", `Basic realm="`+realm+`", charset="UTF-8"`)
	w.Header().Set("Cache-Control", "no-store")
	sendText(w, r, http.StatusUnauthorized, "Name and password needed.\n")
	return true
}

func siteTooMany(w http.ResponseWriter, r *http.Request, wait time.Duration) bool {
	secs := int(wait/time.Second) + 1
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	w.Header().Set("Cache-Control", "no-store")
	sendText(w, r, http.StatusTooManyRequests, "Too many wrong passwords. Try again later.\n")
	return true
}

// lockedFor is how long `addr` must still wait (0: not locked out).
func (g *siteGuard) lockedFor(addr string, now time.Time) time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.fails[addr]
	if f == nil || !now.Before(f.until) {
		return 0
	}
	return f.until.Sub(now)
}

// known reports a good login seen within siteLoginTTL.
func (g *siteGuard) known(fp [32]byte, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	until, ok := g.good[fp]
	return ok && now.Before(until)
}

// knownWrong reports a wrong login this address has already been charged for.
func (g *siteGuard) knownWrong(fp [32]byte, addr string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.fails[addr]
	if f == nil {
		return false
	}
	for _, w := range f.wrong {
		if w == fp {
			return true
		}
	}
	return false
}

// remember keeps a good login, and forgives the address its wrong guesses.
func (g *siteGuard) remember(fp [32]byte, addr string, now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.good == nil {
		g.good = map[[32]byte]time.Time{}
	}
	if len(g.good) >= siteGuardMaxEntries {
		for k, until := range g.good {
			if !now.Before(until) {
				delete(g.good, k)
			}
		}
		if len(g.good) >= siteGuardMaxEntries {
			clear(g.good) // costs only a fresh check for each
		}
	}
	g.good[fp] = now.Add(siteLoginTTL)
	delete(g.fails, addr)
}

// wrongGuess counts one new wrong login from `addr`, and reports whether it
// has just been locked out.
func (g *siteGuard) wrongGuess(fp [32]byte, addr string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.fails == nil {
		g.fails = map[string]*siteFails{}
	}
	f := g.fails[addr]
	if f != nil && now.Sub(f.lastSeen) > siteFailForget && !now.Before(f.until) {
		f = nil // quiet long enough: a clean slate
	}
	if f == nil {
		if len(g.fails) >= siteGuardMaxEntries {
			g.sweepFails(now)
		}
		f = &siteFails{}
		g.fails[addr] = f
	}
	f.lastSeen = now
	f.wrong = append(f.wrong, fp)
	if len(f.wrong) < siteFailMax {
		return false
	}
	lock := siteLockFirst << f.locks
	if lock > siteLockMax || lock <= 0 {
		lock = siteLockMax
	}
	f.locks++
	f.until = now.Add(lock)
	f.wrong = nil
	return true
}

// sweepFails drops the addresses nobody needs to remember; if they are all
// still fresh, those not locked out right now.
func (g *siteGuard) sweepFails(now time.Time) {
	for k, f := range g.fails {
		if now.Sub(f.lastSeen) > siteFailForget && !now.Before(f.until) {
			delete(g.fails, k)
		}
	}
	if len(g.fails) < siteGuardMaxEntries {
		return
	}
	for k, f := range g.fails {
		if !now.Before(f.until) {
			delete(g.fails, k)
		}
	}
}

// printSitePasswordLine is `nayive -site-password <name>`: it reads a password
// and prints the line to put in a site's .password file. From a terminal it
// asks twice with the typing hidden (stty, so no new dependency); from a pipe
// it takes the first line. Never from the command line: that would leave the
// password in the shell history and in `ps`.
func printSitePasswordLine(name string, in *os.File, out, msg io.Writer) error {
	if err := sitePersonNameOK(name); err != nil {
		return err
	}
	tty := false
	if info, err := in.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
		tty = true
	}
	read := bufio.NewReader(in)
	ask := func(prompt string) (string, error) {
		if tty {
			fmt.Fprint(msg, prompt)
			hide := exec.Command("stty", "-echo")
			hide.Stdin = in
			if hide.Run() == nil {
				defer func() {
					show := exec.Command("stty", "echo")
					show.Stdin = in
					show.Run()
					fmt.Fprintln(msg)
				}()
			}
		}
		line, err := read.ReadString('\n')
		if err != nil && line == "" {
			return "", errors.New("no password given")
		}
		return strings.TrimRight(line, "\r\n"), nil
	}

	password, err := ask("Password for " + name + ": ")
	if err != nil {
		return err
	}
	if password == "" {
		return errors.New("the password is empty")
	}
	if tty {
		again, err := ask("Same password again: ")
		if err != nil {
			return err
		}
		if again != password {
			return errors.New("the two passwords differ")
		}
	}
	_, err = fmt.Fprintf(out, "%s:%s\n", name, hashPassword(password))
	return err
}
