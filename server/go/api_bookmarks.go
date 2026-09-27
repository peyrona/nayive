package main

// =============================================================================
// /api/bookmarks - the two things the Bookmarks app cannot do from the browser.
// =============================================================================
//
//	GET /api/bookmarks/icon?host=example.com         the site's own icon (bytes), 204 when it has none
//	GET /api/bookmarks/title?url=https://example.com {"title": "..."} - the page's <title>
//
// A browser page may not read another site (CORS), so the SERVER asks for it.
// Nothing goes to a third party: no Google favicon service, the site itself is
// the only one asked.
//
// THE ICON is looked up once per HOST, for every user together, and kept in the
// server's own cache folder, <run-root>/.cache/bookmark-icons/ - not in anyone's
// home, so it costs no one's quota and stays out of the backups (it can always
// be fetched again). A later render never leaves the server. The folder is
// capped at bmCacheMax bytes (the oldest icons go first), and an icon older than
// bmIconMaxAge is fetched again (the old one is kept if the site gives no new).
//
// A host with no icon leaves a marker, so a dead site is not asked on every
// render: ".none" when the site answered and has no usable icon (asked again
// after bmIconRetry), ".err" when it could not be asked - no connection, a
// timeout, a 5xx - (asked again after bmErrRetry: it may be back soon). The
// browser may keep a "no icon" answer for an hour only.
//
// The lookup costs at most four requests: the home page over https (over http
// when that fails), the icon its <link rel="icon"> names, and /favicon.ico. An
// SVG icon is not used: served from this origin, a script inside it would run
// as Nayive if the file were opened directly (the reply also carries a CSP that
// forbids any, as a second lock). The app always paints a coloured initial and
// lays the icon over it, so a missing one costs nothing.
//
// Every outbound request, all users together, shares bmParallel slots. A
// lookup's clock starts once it HAS a slot: one that waits too long for one
// gives up having learned nothing about the site - no marker, and a 204 the
// browser does not keep, so the next render asks again.
//
// THE TITLE is asked for when a URL is pasted into the bookmark sheet. Only the
// first titleMax bytes are read, and the page's charset is honoured. It waits
// bmTitleWait at most for a slot, then answers 503: the app keeps the domain it
// already put in the field.
//
// NOT A PROXY INTO THE LAN. Both fetch an address a user typed, so the dialer
// refuses anything that is not the public internet - loopback, private,
// link-local, CGNAT, multicast, unspecified, and this machine's own addresses
// (a firewall hides nothing from the machine itself) - checked on the IP
// actually dialled, so a DNS name pointing inside and a redirect to one are
// both caught. Only http / https, only ports 80, 443, 8080 and 8443, no proxy
// from the environment, a short timeout, a few redirects, a size cap.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/htmlindex"
)

const (
	bmTimeout    = 6 * time.Second // one whole request, redirects included
	bmMaxRedir   = 4               // redirects followed
	bmPageMax    = 512 << 10       // bytes of a page read for its <title> / <link>
	bmIconMax    = 256 << 10       // an icon bigger than this is not kept
	bmIconCache  = 7 * 24 * 3600   // seconds a browser may keep an icon
	bmNoneCache  = 3600            // seconds a browser may keep a "no icon" answer
	bmTitleChars = 300             // the longest title handed back
	bmParallel   = 6               // outbound lookups at once, all users together
	bmUserAgent  = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Nayive"
)

// The clocks and the cap. Variables so the tests can shorten them.
var (
	bmSlotWait   = 20 * time.Second    // an icon lookup waits this long for a slot, then gives up
	bmTitleWait  = 4 * time.Second     // a title: someone is waiting at the sheet
	bmLookupMax  = 3 * bmTimeout       // one icon lookup, from the moment it has its slot
	bmIconRetry  = 7 * 24 * time.Hour  // a ".none" host is asked again after this
	bmErrRetry   = time.Hour           // a ".err" host is asked again after this
	bmIconMaxAge = 30 * 24 * time.Hour // a kept icon older than this is fetched again
	bmCacheMax   = int64(64 << 20)     // the icon folder's size cap
)

// Tests serve from 127.0.0.1 on a random port; these two let them in.
var (
	bmAllowLocal = false
	bmAllowPort  = func(p string) bool { return p == "80" || p == "443" || p == "8080" || p == "8443" }
)

var (
	bmSlots   = make(chan struct{}, bmParallel)
	bmMu      sync.Mutex
	bmRunning = map[string]chan struct{}{} // cache folder|host -> closed when its lookup ends
	bmSweepMu sync.Mutex                   // one bmSweep at a time
	bmOldGone sync.Map                     // a user's old in-home icon folder, already removed
)

var bmHostRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$`)

// What a lookup can end in, besides an icon.
var (
	errBmNoIcon  = errors.New("the site has no usable icon")
	errBmShaky   = errors.New("the site could not be asked") // may pass: ask again soon
	errBmRefused = errors.New("refused")                     // not the public internet
)

// bmStatusError: the site answered, but not with a 200.
type bmStatusError int

func (e bmStatusError) Error() string { return "status " + strconv.Itoa(int(e)) }

// bmShaky reports an error that may pass on its own: no answer at all (DNS, a
// refused connection, a timeout) or a server-side one (5xx, 429, 408). An
// address the dialer refuses, or a 404, is final.
func bmShaky(err error) bool {
	var st bmStatusError
	switch {
	case err == nil:
		return false
	case errors.As(err, &st):
		return st >= 500 || st == http.StatusTooManyRequests || st == http.StatusRequestTimeout
	case errors.Is(err, errBmRefused):
		return false
	}
	return true
}

func (s *Server) apiBookmarks(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		sendError(w, r, http.StatusMethodNotAllowed, "use GET")
		return
	}
	q := cleanQuery(r)
	switch r.PathValue("what") {
	case "icon":
		s.bookmarkIcon(w, r, sess, q.Get("host"))
	case "title":
		s.bookmarkTitle(w, r, q.Get("url"))
	default:
		sendError(w, r, http.StatusNotFound, "no such bookmarks call")
	}
}

// bmTakeSlot waits for one of the bmParallel outbound slots: false when the
// request is gone or `wait` ran out first. A true is paired with bmFreeSlot.
func bmTakeSlot(ctx context.Context, wait time.Duration) bool {
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case bmSlots <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	case <-t.C:
		return false
	}
}

func bmFreeSlot() { <-bmSlots }

// -----------------------------------------------------------------------------
// title
// -----------------------------------------------------------------------------

func (s *Server) bookmarkTitle(w http.ResponseWriter, r *http.Request, raw string) {
	u, err := bmParseURL(raw)
	if err != nil {
		sendError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	if !bmTakeSlot(r.Context(), bmTitleWait) {
		sendError(w, r, http.StatusServiceUnavailable, "busy - try again")
		return
	}
	defer bmFreeSlot()

	body, ctype, _, err := bmFetch(r.Context(), u.String(), bmPageMax)
	if err != nil {
		sendError(w, r, http.StatusBadGateway, "the page could not be read")
		return
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"title": pageTitle(body, ctype)})
}

var (
	bmTitleRe   = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	bmMetaCsRe  = regexp.MustCompile(`(?i)<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)`)
	bmSpacesRe  = regexp.MustCompile(`\s+`)
	bmLinkTagRe = regexp.MustCompile(`(?is)<link\b[^>]*>`)
	bmBaseTagRe = regexp.MustCompile(`(?is)<base\b[^>]*>`)
	bmAttrRe    = regexp.MustCompile(`(?is)([a-z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
)

// pageTitle is the page's <title>, decoded from its charset, entities
// resolved, white space collapsed, cut to bmTitleChars. "" when it has none.
func pageTitle(body []byte, ctype string) string {
	body = bmToUTF8(body, ctype)
	m := bmTitleRe.FindSubmatch(body)
	if m == nil {
		return ""
	}
	t := html.UnescapeString(string(m[1]))
	t = strings.TrimSpace(bmSpacesRe.ReplaceAllString(t, " "))
	if utf8.RuneCountInString(t) > bmTitleChars {
		t = string([]rune(t)[:bmTitleChars])
	}
	return t
}

// bmToUTF8 decodes a page to UTF-8. A charset the Content-Type names wins;
// a page that is valid UTF-8 is kept as it is (servers often say "utf-8" for
// everything); otherwise the <meta> charset, and Windows-1252 as a last guess.
func bmToUTF8(body []byte, ctype string) []byte {
	decode := func(name string) ([]byte, bool) {
		enc, err := htmlindex.Get(name)
		if err != nil {
			return nil, false
		}
		out, err := enc.NewDecoder().Bytes(body)
		return out, err == nil
	}
	if i := strings.Index(strings.ToLower(ctype), "charset="); i >= 0 {
		name := strings.ToLower(strings.Trim(ctype[i+8:], ` "';`))
		if name != "utf-8" && name != "utf8" {
			if out, ok := decode(name); ok {
				return out
			}
		}
	}
	if utf8.Valid(body) {
		return body
	}
	if m := bmMetaCsRe.FindSubmatch(body); m != nil {
		if out, ok := decode(string(m[1])); ok {
			return out
		}
	}
	if out, ok := decode("windows-1252"); ok {
		return out
	}
	return body
}

// -----------------------------------------------------------------------------
// icon
// -----------------------------------------------------------------------------

func (s *Server) bmIconDir() string { return filepath.Join(s.cfg.Here, ".cache", "bookmark-icons") }

func (s *Server) bookmarkIcon(w http.ResponseWriter, r *http.Request, sess Session, host string) {
	host = strings.ToLower(strings.TrimSpace(host))
	if len(host) > 253 || !bmHostRe.MatchString(host) {
		sendError(w, r, http.StatusBadRequest, "bad host")
		return
	}
	if sess.Role != "admin" {
		s.dropOldIconDir(sess.User)
	}

	dir := s.bmIconDir()
	base := strings.ReplaceAll(host, ":", "_")

	if img, _, known := bmCached(dir, base); known {
		if img != nil {
			sendIcon(w, img)
		} else {
			sendNoIcon(w, bmNoneCache)
		}
		return
	}

	// One lookup per host at a time: a page of cards asks for the same
	// host many times at once, and only the first goes out.
	key := dir + "|" + host
	bmMu.Lock()
	wait, busy := bmRunning[key]
	if !busy {
		wait = make(chan struct{})
		bmRunning[key] = wait
	}
	bmMu.Unlock()

	if busy {
		select {
		case <-wait:
		case <-r.Context().Done():
			return
		}
		bmAnswer(w, dir, base)
		return
	}
	defer func() {
		bmMu.Lock()
		delete(bmRunning, key)
		bmMu.Unlock()
		close(wait)
	}()

	// A slot first, while the browser still wants the answer; the lookup's
	// own clock starts only once it has one. No slot in time: nothing was
	// learned about the site, so nothing is written.
	if !bmTakeSlot(r.Context(), bmSlotWait) {
		bmAnswer(w, dir, base)
		return
	}
	// Detached from the browser: a card scrolled away mid-lookup still
	// leaves its answer for next time.
	ctx, cancel := context.WithTimeout(context.Background(), bmLookupMax)
	img, err := s.lookupIcon(ctx, host)
	cancel()
	bmFreeSlot()

	s.keepIcon(dir, base, img, err)
	bmAnswer(w, dir, base)
}

// dropOldIconDir removes the per-user icon folder the first version kept in
// each home (data/bookmarks/icons/), once per user and process. That folder
// only; the cache lives outside the homes now.
func (s *Server) dropOldIconDir(user string) {
	if user == "" || user == "." || user == ".." || strings.ContainsAny(user, `/\`) {
		return
	}
	old := filepath.Join(s.cfg.HomesDir, user, "data", "bookmarks", "icons")
	if _, done := bmOldGone.LoadOrStore(old, true); done {
		return
	}
	if err := os.RemoveAll(old); err != nil {
		s.log.Warn("bookmarks: old icon folder", "dir", old, "err", err)
	}
}

// bmCached is what the cache already knows about a host. img: a fresh icon.
// stale: an old one (past bmIconMaxAge), sent while - or if - a new lookup
// fails. known: the answer stands (a fresh icon, or a marker still in force),
// so no lookup is needed.
func bmCached(dir, base string) (img, stale []byte, known bool) {
	p := filepath.Join(dir, base)
	if fi, err := os.Stat(p + ".img"); err == nil {
		if b, err := os.ReadFile(p + ".img"); err == nil {
			if time.Since(fi.ModTime()) < bmIconMaxAge {
				return b, nil, true
			}
			return nil, b, false
		}
	}
	for _, m := range []struct {
		ext string
		ttl time.Duration
	}{{".none", bmIconRetry}, {".err", bmErrRetry}} {
		if fi, err := os.Stat(p + m.ext); err == nil && time.Since(fi.ModTime()) < m.ttl {
			return nil, nil, true
		}
	}
	return nil, nil, false
}

// bmAnswer sends what the cache holds for a host now: its icon (a stale one
// too), a "no icon" the browser may keep an hour when a marker says so, or -
// nothing known yet - a 204 it must not keep.
func bmAnswer(w http.ResponseWriter, dir, base string) {
	img, stale, known := bmCached(dir, base)
	switch {
	case img != nil:
		sendIcon(w, img)
	case stale != nil:
		sendIcon(w, stale)
	case known:
		sendNoIcon(w, bmNoneCache)
	default:
		sendNoIcon(w, 0)
	}
}

// keepIcon writes a lookup's outcome to the cache: the icon, or - when there
// is an older one - that one kept another round, or a marker: ".err" when the
// site could not be asked, ".none" when it answered without an icon.
func (s *Server) keepIcon(dir, base string, img []byte, err error) {
	if mkErr := os.MkdirAll(dir, 0o755); mkErr != nil {
		s.log.Warn("bookmarks: icon folder", "dir", dir, "err", mkErr)
		return
	}
	p := filepath.Join(dir, base)
	now := time.Now()
	_, oldErr := os.Stat(p + ".img")

	switch {
	case err == nil:
		if werr := bmWriteFile(p+".img", img); werr != nil {
			s.log.Warn("bookmarks: icon not kept", "file", p+".img", "err", werr)
			return
		}
		_ = os.Remove(p + ".none")
		_ = os.Remove(p + ".err")
	case oldErr == nil:
		_ = os.Chtimes(p+".img", now, now)
	default:
		mark, other := ".none", ".err"
		if errors.Is(err, errBmShaky) {
			mark, other = ".err", ".none"
		}
		_ = os.Remove(p + other)
		if werr := os.WriteFile(p+mark, nil, 0o644); werr == nil {
			_ = os.Chtimes(p+mark, now, now) // a rewritten empty file may keep its old time
		}
	}
	bmSweep(dir)
}

// bmSweep keeps the icon folder in bounds: markers past their time and
// half-written files go, and when the icons pass bmCacheMax the oldest go
// until they are back under nine tenths of it.
func bmSweep(dir string) {
	bmSweepMu.Lock()
	defer bmSweepMu.Unlock()

	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type kept struct {
		path string
		size int64
		mod  time.Time
	}
	var icons []kept
	var total int64
	now := time.Now()
	for _, e := range entries {
		fi, err := e.Info()
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		p, age := filepath.Join(dir, e.Name()), now.Sub(fi.ModTime())
		switch filepath.Ext(e.Name()) {
		case ".img":
			icons = append(icons, kept{p, fi.Size(), fi.ModTime()})
			total += fi.Size()
		case ".none":
			if age > bmIconRetry {
				_ = os.Remove(p)
			}
		case ".err":
			if age > bmErrRetry {
				_ = os.Remove(p)
			}
		case ".part":
			if age > time.Minute {
				_ = os.Remove(p)
			}
		}
	}
	if total <= bmCacheMax {
		return
	}
	sort.Slice(icons, func(i, j int) bool { return icons[i].mod.Before(icons[j].mod) })
	for _, k := range icons {
		if total <= bmCacheMax/10*9 {
			break
		}
		if os.Remove(k.path) == nil {
			total -= k.size
		}
	}
}

// sendNoIcon: 204, not 404 - the page shows the coloured initial either way,
// and a 404 prints a red "Failed to load resource" line in the browser's
// console for every card of a site that has no icon. The <img> still fires
// its error event (a 204 has no image to decode). maxAge 0 = "do not keep it,
// ask again next time".
func sendNoIcon(w http.ResponseWriter, maxAge int) {
	if maxAge > 0 {
		w.Header().Set("Cache-Control", "private, max-age="+strconv.Itoa(maxAge))
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	w.WriteHeader(http.StatusNoContent)
}

// bmWriteFile writes beside the target, then renames: a reader never sees half
// an icon.
func bmWriteFile(path string, b []byte) error {
	tmp := path + ".part"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func sendIcon(w http.ResponseWriter, img []byte) {
	h := w.Header()
	h.Set("Content-Type", iconType(img))
	h.Set("Content-Length", strconv.Itoa(len(img)))
	h.Set("Cache-Control", "private, max-age="+strconv.Itoa(bmIconCache))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(img)
}

// iconType is the raster type of an icon's bytes, or "" for anything else
// (an SVG, an HTML error page served as favicon.ico, garbage).
func iconType(b []byte) string {
	switch {
	case len(b) >= 4 && b[0] == 0 && b[1] == 0 && (b[2] == 1 || b[2] == 2) && b[3] == 0:
		return "image/x-icon"
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case bytes.HasPrefix(b, []byte("\xff\xd8\xff")):
		return "image/jpeg"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}

// lookupIcon asks the site: first the icon its home page names, then
// /favicon.ico. At most four requests (the home page over http as well, when
// https fails). The caller holds a slot. Without an icon the error says why:
// errBmShaky when some request failed for a reason that may pass (bmShaky),
// errBmNoIcon when the site answered and simply has none.
func (s *Server) lookupIcon(ctx context.Context, host string) ([]byte, error) {
	shaky := false
	var tried []string
	try := func(u string) []byte {
		for _, t := range tried {
			if t == u {
				return nil
			}
		}
		tried = append(tried, u)
		b, _, _, err := bmFetch(ctx, u, bmIconMax+1)
		if err != nil {
			if bmShaky(err) {
				shaky = true
			}
			return nil
		}
		if len(b) > bmIconMax || iconType(b) == "" {
			return nil
		}
		return b
	}

	home := &url.URL{Scheme: "https", Host: host, Path: "/"}
	page, _, final, err := bmFetch(ctx, home.String(), bmPageMax)
	if err != nil {
		first := err
		home.Scheme = "http"
		page, _, final, err = bmFetch(ctx, home.String(), bmPageMax)
		if err != nil && bmShaky(first) && bmShaky(err) {
			shaky = true
		}
	}
	if err == nil {
		if href := pickIconLink(page); href != "" {
			if ref, perr := url.Parse(href); perr == nil {
				if img := try(pageBase(page, final).ResolveReference(ref).String()); img != nil {
					return img, nil
				}
			}
		}
	}
	if img := try(home.ResolveReference(&url.URL{Path: "/favicon.ico"}).String()); img != nil {
		return img, nil
	}
	if shaky {
		return nil, errBmShaky
	}
	return nil, errBmNoIcon
}

// pageBase is what a page's relative links are relative to: its <base href>
// when it has one, else the address it was finally served from - after the
// redirects, so example.com -> www.example.com/en/ resolves "img/i.png" to
// www.example.com/en/img/i.png.
func pageBase(page []byte, final *url.URL) *url.URL {
	if tag := bmBaseTagRe.Find(page); tag != nil {
		for _, m := range bmAttrRe.FindAllSubmatch(tag, -1) {
			if !strings.EqualFold(string(m[1]), "href") {
				continue
			}
			v := strings.TrimSpace(html.UnescapeString(strings.Trim(string(m[2]), `"'`)))
			if ref, err := url.Parse(v); err == nil {
				if b := final.ResolveReference(ref); b.Scheme == "http" || b.Scheme == "https" {
					return b
				}
			}
		}
	}
	return final
}

// pickIconLink is the best raster icon a page's <link> tags name: a PNG /
// ICO of about 32-64 px first, then any other size, never an SVG. "" if none.
func pickIconLink(page []byte) string {
	best, bestScore := "", -1
	for _, tag := range bmLinkTagRe.FindAll(page, 200) {
		attrs := map[string]string{}
		for _, m := range bmAttrRe.FindAllSubmatch(tag, -1) {
			v := strings.Trim(string(m[2]), `"'`)
			attrs[strings.ToLower(string(m[1]))] = html.UnescapeString(v)
		}
		rel := " " + strings.ToLower(attrs["rel"]) + " "
		if !strings.Contains(rel, " icon ") && !strings.Contains(rel, " apple-touch-icon ") {
			continue
		}
		href := strings.TrimSpace(attrs["href"])
		low := strings.ToLower(href)
		if href == "" || strings.HasPrefix(low, "data:") ||
			strings.Contains(strings.ToLower(attrs["type"]), "svg") ||
			strings.HasSuffix(strings.SplitN(low, "?", 2)[0], ".svg") {
			continue
		}
		score := 10
		if strings.Contains(rel, "apple-touch-icon") {
			score = 5 // big, but always a PNG
		}
		if sz := attrs["sizes"]; sz != "" {
			n, _ := strconv.Atoi(strings.SplitN(strings.ToLower(sz), "x", 2)[0])
			switch {
			case n >= 32 && n <= 64:
				score = 30
			case n > 64 && n <= 192:
				score = 20
			case n > 0 && n < 32:
				score = 15
			}
		}
		if score > bestScore {
			best, bestScore = href, score
		}
	}
	return best
}

// -----------------------------------------------------------------------------
// the guarded fetch
// -----------------------------------------------------------------------------

func bmParseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("not an http(s) address")
	}
	u.Fragment = ""
	return u, nil
}

// bmPublicIP says whether an IP is on the public internet.
func bmPublicIP(ip net.IP) bool {
	if ip4 := ip.To4(); ip4 != nil {
		ip = ip4
		if ip4[0] == 0 || (ip4[0] == 100 && ip4[1]&0xc0 == 64) { // 0.0.0.0/8, CGNAT 100.64/10
			return false
		}
	}
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast())
}

// This machine's own addresses, read again every minute: its public IP sits on
// one of them on a VPS, and a request from the machine to itself gets past any
// firewall - a service kept off the internet would answer.
var (
	bmOwnMu    sync.Mutex
	bmOwnAt    time.Time
	bmOwnList  []net.IP
	bmOwnAddrs = net.InterfaceAddrs // the tests swap it
)

// bmOwnIP says whether an IP is one of this machine's own.
func bmOwnIP(ip net.IP) bool {
	bmOwnMu.Lock()
	defer bmOwnMu.Unlock()
	if time.Since(bmOwnAt) > time.Minute {
		bmOwnAt = time.Now()
		bmOwnList = bmOwnList[:0]
		if addrs, err := bmOwnAddrs(); err == nil {
			for _, a := range addrs {
				switch v := a.(type) {
				case *net.IPNet:
					bmOwnList = append(bmOwnList, v.IP)
				case *net.IPAddr:
					bmOwnList = append(bmOwnList, v.IP)
				}
			}
		}
	}
	for _, own := range bmOwnList {
		if own.Equal(ip) {
			return true
		}
	}
	return false
}

// bmControl runs on every socket before it connects, with the address
// already resolved - the one place a DNS answer or a redirect cannot dodge.
func bmControl(network, address string, _ syscall.RawConn) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if !bmAllowPort(port) {
		return fmt.Errorf("%w: port %s", errBmRefused, port)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return errors.New("not an IP")
	}
	if bmAllowLocal && ip.IsLoopback() {
		return nil
	}
	if !bmPublicIP(ip) || bmOwnIP(ip) {
		return fmt.Errorf("%w: %s is not a public address", errBmRefused, ip)
	}
	return nil
}

var bmClient = &http.Client{
	Timeout: bmTimeout,
	Transport: &http.Transport{
		Proxy:                 nil, // never an environment proxy: it would dial for us
		DialContext:           (&net.Dialer{Timeout: bmTimeout, Control: bmControl}).DialContext,
		TLSHandshakeTimeout:   bmTimeout,
		ResponseHeaderTimeout: bmTimeout,
		MaxIdleConns:          16,
		IdleConnTimeout:       30 * time.Second,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= bmMaxRedir {
			return errors.New("too many redirects")
		}
		if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
			return errors.New("redirect out of http(s)")
		}
		return nil
	},
}

// bmFetch GETs a URL through the guarded client and reads at most `max` bytes.
// It also says where the body finally came from (after the redirects), the
// base for the page's relative links. Not a 200: a bmStatusError.
func bmFetch(ctx context.Context, u string, max int64) ([]byte, string, *url.URL, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, "", nil, err
	}
	req.Header.Set("User-Agent", bmUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5")
	resp, err := bmClient.Do(req)
	if err != nil {
		return nil, "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", nil, bmStatusError(resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max))
	if err != nil && len(b) == 0 {
		return nil, "", nil, err
	}
	return b, resp.Header.Get("Content-Type"), resp.Request.URL, nil
}
