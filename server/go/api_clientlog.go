package main

// =============================================================================
// POST /api/clientlog - a browser tells us it broke
// =============================================================================
//
// Every app page catches its own uncaught errors (shared/ui.js) and sends them
// here, with the browser, its version and the device shape (mouse or touch,
// screen size). Without it a page that breaks on someone's phone breaks in
// silence: we only ever saw what our own Chromium showed us.
//
// Not a user-data path: it writes one line per error to
// <run-root>/logs/client-errors.log (JSON per line, `jq` reads it), never into
// a home. Read it on the VPS with:  tail -f ~/nayive/store/logs/client-errors.log
//
// Limits, so a page stuck in an error loop cannot fill the disk:
//   - a session is required (no anonymous writes);
//   - each field is cut to a fixed length;
//   - per account, at most clientLogPerHour lines an hour, and the same error
//     (message + file + line) only once an hour;
//   - the file rolls to .1 past clientLogMaxSize (two files at most).

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	clientLogPerHour = 30
	clientLogMaxSize = 2 << 20 // 2 MiB, then client-errors.log.1
)

// clientReport is what shared/ui.js sends. Every field is optional.
type clientReport struct {
	App     string `json:"app"`     // "calc", "drive"... (the page's folder)
	Kind    string `json:"kind"`    // "error" | "rejection"
	Message string `json:"message"` //
	Source  string `json:"source"`  // the script's URL
	Line    int    `json:"line"`    //
	Col     int    `json:"col"`     //
	Stack   string `json:"stack"`   //
	Browser string `json:"browser"` // "Firefox 131", "Safari 17.6"... (worked out in the page)
	UA      string `json:"ua"`      // the raw user agent, for what the page could not name
	Touch   bool   `json:"touch"`   // the main pointer is a finger
	Width   int    `json:"w"`       // the window, CSS pixels
	Height  int    `json:"h"`       //
}

// ClientLog is the file and the per-account counters.
type ClientLog struct {
	mu     sync.Mutex
	path   string
	window time.Time           // when the current hour began
	counts map[string]int      // account -> lines this hour
	seen   map[string]struct{} // account + error -> already logged this hour
	now    func() time.Time    // a test moves the clock
	write  func(path string, line []byte) error
}

func NewClientLog(runRoot string) *ClientLog {
	return &ClientLog{
		path:   filepath.Join(runRoot, "logs", "client-errors.log"),
		counts: map[string]int{},
		seen:   map[string]struct{}{},
		now:    time.Now,
		write:  appendRolling,
	}
}

// Add logs one report for `user`, unless it is over the hour's limit or the
// same error was already logged this hour. It answers whether a line was written.
func (c *ClientLog) Add(user string, rep clientReport) (bool, error) {
	rep.App = clipRunes(rep.App, 40)
	rep.Kind = clipRunes(rep.Kind, 20)
	rep.Message = clipRunes(rep.Message, 500)
	rep.Source = clipRunes(rep.Source, 300)
	rep.Stack = clipRunes(rep.Stack, 2000)
	rep.Browser = clipRunes(rep.Browser, 60)
	rep.UA = clipRunes(rep.UA, 300)

	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	if now.Sub(c.window) >= time.Hour {
		c.window = now
		c.counts = map[string]int{}
		c.seen = map[string]struct{}{}
	}
	key := user + "\x00" + rep.Message + "\x00" + rep.Source + "\x00" + itoa(rep.Line)
	if _, dup := c.seen[key]; dup || c.counts[user] >= clientLogPerHour {
		return false, nil
	}
	c.seen[key] = struct{}{}
	c.counts[user]++

	line, err := json.Marshal(struct {
		Time string `json:"time"`
		User string `json:"user"`
		clientReport
	}{now.Format(time.DateTime), user, rep})
	if err != nil {
		return false, err
	}
	return true, c.write(c.path, append(line, '\n'))
}

// appendRolling appends `line` to `path`, first moving a file past
// clientLogMaxSize to path.1 (the older .1 is dropped).
func appendRolling(path string, line []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if fi, err := os.Stat(path); err == nil && fi.Size()+int64(len(line)) > clientLogMaxSize {
		os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(line); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// apiClientLog is POST /api/clientlog. It answers 204 whether the line was
// written or dropped by the limits: the page has nothing to do either way.
func (s *Server) apiClientLog(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if !allowMethod(w, r, "use POST", http.MethodPost) {
		return
	}
	var rep clientReport
	if !readJSONBody(w, r, &rep) {
		return
	}
	if _, err := s.clientLog.Add(sess.User, rep); err != nil {
		s.log.Error("client log", "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}
