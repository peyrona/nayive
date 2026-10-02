package main

// =============================================================================
// /api/culture/fetch - the "Salon" screen locker's window on the free sources.
// =============================================================================
//
//	GET /api/culture/fetch?u=<https URL>&ttl=<seconds>   the source's answer, as is
//
// The Salon locker (client/apps/shared/lockers/culture.js) shows a painting, a
// word, a quote and "on this day", all live from Wikipedia, Wiktionary,
// Wikiquote and Wikidata. The Science locker (lockers/science.js) adds
// science news feeds (RSS / Atom, sent back as text) and NASA's image of the day. The browser does all the reading and choosing; the
// SERVER only fetches, for three reasons:
//
//   - One fetch serves every user and every desktop: the answer is kept in
//     <run-root>/.cache/culture/ (not in anyone's home: no quota, no backup,
//     it can always be fetched again) until `ttl` runs out.
//   - Wikimedia answers 429 to quick bursts and wants a User-Agent that says
//     who asks. Here every request carries one, they go out ONE at a time with
//     cuGap between them, and N desktops waking at midnight share one fetch.
//   - The users' addresses stay home.
//
// When a fresh copy cannot be had (no network, a 429, a 5xx) the last copy is
// served, however old, with "X-Nayive-Stale: 1". No copy at all: 502.
//
// NOT AN OPEN PROXY: only https, only GET, only the hosts in cuHosts (checked
// again on every redirect), through the bookmarks' guarded dialer (public
// internet only), at most cuMax bytes. The answer goes back as JSON or as
// plain text - never as HTML or anything a browser would run - with a
// sandbox CSP as a second lock.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	cuTimeout   = 65 * time.Second // one whole request (Wikidata stops a query at 60 s)
	cuMax       = 8 << 20          // bytes read from one answer ("on this day" is 1-3 MB)
	cuTTLMin    = 10 * 60          // seconds: the shortest keep a page may ask for
	cuTTLMax    = 30 * 24 * 3600   // ...and the longest
	cuUserAgent = "Nayive/1.0 (screen locker; https://github.com/peyrona/nayive)"
)

// Variables so the tests can change them.
var (
	cuGap      = 350 * time.Millisecond // between two outbound requests, all users together
	cuCacheMax = int64(256 << 20)       // the cache folder's size cap
	cuKeepMax  = 90 * 24 * time.Hour    // a copy nobody asked for in this long goes
	cuFetch    = cuGet                  // the tests swap it for a fake internet
)

// The hosts the lockers may read. Exact names only. The second line is the
// Science locker's (lockers/science.js): its news and NASA's picture of the
// day - sources whose terms allow it (checked 2026-09-30: SINC CC BY 4.0,
// The Conversation CC BY-ND 4.0, Agência FAPESP CC BY-NC-ND, NASA public
// domain).
var cuHosts = func() map[string]bool {
	m := map[string]bool{"query.wikidata.org": true, "www.wikidata.org": true,
		"www.agenciasinc.es": true, "theconversation.com": true, "agencia.fapesp.br": true, "www.nasa.gov": true,
		"www.eso.org": true, "esahubble.org": true, "esawebb.org": true}
	for _, lang := range []string{"de", "en", "es", "fr", "pt"} {
		for _, site := range []string{"wikipedia", "wiktionary", "wikiquote"} {
			m[lang+"."+site+".org"] = true
		}
	}
	return m
}()

var (
	cuMu      sync.Mutex
	cuRunning = map[string]*cuCall{} // key -> the fetch in flight
	cuOutMu   sync.Mutex             // one outbound request at a time
	cuLastOut time.Time
	cuSweepMu sync.Mutex
)

type cuCall struct {
	done chan struct{}
	body []byte
	kind string
	err  error
}

var errCuRefused = errors.New("not an address the locker may read")

func (s *Server) cuDir() string { return filepath.Join(s.cfg.Here, ".cache", "culture") }

func (s *Server) apiCulture(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireSession(w, r); !ok {
		return
	}
	if r.Method != http.MethodGet {
		sendError(w, r, http.StatusMethodNotAllowed, "use GET")
		return
	}
	if r.PathValue("what") != "fetch" {
		sendError(w, r, http.StatusNotFound, "no such culture call")
		return
	}
	q := cleanQuery(r)
	u, err := cuParseURL(q.Get("u"))
	if err != nil {
		sendError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	ttl, _ := strconv.Atoi(q.Get("ttl"))
	ttl = min(max(ttl, cuTTLMin), cuTTLMax)

	key := u.String()
	sum := sha256.Sum256([]byte(key))
	path := filepath.Join(s.cuDir(), hex.EncodeToString(sum[:]))

	kind, body, age, have := cuRead(path)
	if have && age < time.Duration(ttl)*time.Second {
		cuSend(w, kind, body, false)
		return
	}
	nkind, nbody, err := cuShared(r.Context(), key)
	if err == nil {
		cuWrite(path, nkind, nbody)
		go s.cuSweep()
		cuSend(w, nkind, nbody, false)
		return
	}
	if have {
		cuSend(w, kind, body, true)
		return
	}
	if errors.Is(err, context.Canceled) {
		return // the page went away; the fetch goes on and is kept for the next one
	}
	s.log.Warn("culture fetch failed", "url", key, "err", err)
	sendError(w, r, http.StatusBadGateway, "the source could not be reached")
}

// cuParseURL accepts only https GETs to cuHosts, with no user, no port.
func cuParseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || !cuHosts[u.Hostname()] {
		return nil, errCuRefused
	}
	u.Fragment = ""
	return u, nil
}

// cuShared: every request for the same URL waits on one fetch.
func cuShared(ctx context.Context, key string) (string, []byte, error) {
	cuMu.Lock()
	c := cuRunning[key]
	if c == nil {
		c = &cuCall{done: make(chan struct{})}
		cuRunning[key] = c
		go func() {
			// Not the asker's context: a closed tab must not waste the fetch.
			c.kind, c.body, c.err = cuFetch(context.Background(), key)
			cuMu.Lock()
			delete(cuRunning, key)
			cuMu.Unlock()
			close(c.done)
		}()
	}
	cuMu.Unlock()
	select {
	case <-c.done:
		return c.kind, c.body, c.err
	case <-ctx.Done():
		return "", nil, ctx.Err()
	}
}

var cuClient = &http.Client{
	Timeout: cuTimeout,
	Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 8 * time.Second, Control: bmControl}).DialContext,
		TLSHandshakeTimeout:   8 * time.Second,
		ResponseHeaderTimeout: cuTimeout,
		MaxIdleConns:          8,
		IdleConnTimeout:       60 * time.Second,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 4 {
			return errors.New("too many redirects")
		}
		if _, err := cuParseURL(req.URL.String()); err != nil {
			return err
		}
		return nil
	},
}

// cuGet is one outbound GET, after the others: at most one at a time, cuGap
// apart. The answer's kind is "json" or "text".
func cuGet(ctx context.Context, u string) (string, []byte, error) {
	cuOutMu.Lock()
	defer cuOutMu.Unlock()
	if wait := cuGap - time.Since(cuLastOut); wait > 0 {
		time.Sleep(wait)
	}
	defer func() { cuLastOut = time.Now() }()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("User-Agent", cuUserAgent)
	if strings.HasPrefix(u, "https://query.wikidata.org/") {
		req.Header.Set("Accept", "application/sparql-results+json")
	} else {
		req.Header.Set("Accept", "application/json, text/xml;q=0.9, */*;q=0.5")
	}
	resp, err := cuClient.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", nil, errors.New("status " + strconv.Itoa(resp.StatusCode))
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, cuMax+1))
	if err != nil {
		return "", nil, err
	}
	if len(b) > cuMax {
		return "", nil, errors.New("answer too big")
	}
	kind := "text"
	if ct := resp.Header.Get("Content-Type"); strings.Contains(ct, "json") {
		kind = "json"
	}
	return kind, b, nil
}

// The cache file: "json\n" or "text\n", then the body as it came.
func cuRead(path string) (kind string, body []byte, age time.Duration, ok bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", nil, 0, false
	}
	i := strings.IndexByte(string(b[:min(len(b), 8)]), '\n')
	if i < 0 {
		return "", nil, 0, false
	}
	return string(b[:i]), b[i+1:], time.Since(cuModTime(path)), true
}

func cuModTime(path string) time.Time {
	if fi, err := os.Stat(path); err == nil {
		return fi.ModTime()
	}
	return time.Time{}
}

func cuWrite(path, kind string, body []byte) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	_ = bmWriteFile(path, append([]byte(kind+"\n"), body...))
}

func cuSend(w http.ResponseWriter, kind string, body []byte, stale bool) {
	h := w.Header()
	if kind == "json" {
		h.Set("Content-Type", "application/json; charset=utf-8")
	} else {
		h.Set("Content-Type", "text/plain; charset=utf-8")
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("Cache-Control", "no-store") // the page keeps its own copy (localStorage)
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if stale {
		h.Set("X-Nayive-Stale", "1")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// cuSweep keeps the folder in bounds: copies fetched more than cuKeepMax ago
// go, then the oldest until the folder is under nine tenths of cuCacheMax.
func (s *Server) cuSweep() {
	if !cuSweepMu.TryLock() {
		return
	}
	defer cuSweepMu.Unlock()
	entries, err := os.ReadDir(s.cuDir())
	if err != nil {
		return
	}
	type kept struct {
		path string
		size int64
		mod  time.Time
	}
	var all []kept
	var total int64
	for _, e := range entries {
		fi, err := e.Info()
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		p := filepath.Join(s.cuDir(), e.Name())
		if strings.HasSuffix(e.Name(), ".part") {
			if time.Since(fi.ModTime()) > time.Minute {
				_ = os.Remove(p)
			}
			continue
		}
		if time.Since(fi.ModTime()) > cuKeepMax {
			_ = os.Remove(p)
			continue
		}
		all = append(all, kept{p, fi.Size(), fi.ModTime()})
		total += fi.Size()
	}
	if total <= cuCacheMax {
		return
	}
	sort.Slice(all, func(i, j int) bool { return all[i].mod.Before(all[j].mod) })
	for _, k := range all {
		if total <= cuCacheMax/10*9 {
			break
		}
		if os.Remove(k.path) == nil {
			total -= k.size
		}
	}
}
