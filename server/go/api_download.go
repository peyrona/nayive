package main

// =============================================================================
// /api/download - Drive's "Download", sent by the SERVER.
// =============================================================================
//
//	POST   /api/download?paths=a&paths=b      check them -> {"id", "name", "total", "files"}
//	POST   /api/download  {"paths": [a, b]}   the same, for a pick too long for an address
//	GET    /api/download?id=<id>              the bytes, as an attachment
//	GET    /api/download?id=<id>&progress=1   {"state", "sent", "total", "files", "done"}
//	DELETE /api/download?id=<id>              stop it
//
// One picked FILE goes out as it is. Anything else - a folder, several items -
// goes out as ONE .zip written straight into the response while its files are
// read: nothing is held in memory and no temp lands on the disk, whatever the
// size. Drive clicks a link to the GET, so the BROWSER saves it with its own
// downloader and a phone never holds the whole thing either. The zip has the
// shape Compress gives (api_zip.go): the same walk, the same names, photos and
// videos stored, the rest deflated.
//
// Drive still shows how far it got. The GET counts what it has sent - a file's
// bytes, or the bytes of the files read into the zip so far - and the page asks
// for that count (progress=1) to draw its bar. It runs a little ahead of what
// the browser has saved (what sits in the socket's buffers), never behind.
//
// The POST is there so a refusal - 403, 404, 413 - comes back as JSON the page
// can show; a link that failed would only leave a broken download in the
// browser's list. The paths are resolved again by the GET, so a share taken
// away in between is honoured. A job is its user's alone: another user's id
// is a 404, the same as one that does not exist.
//
// A stop - the DELETE, or the browser giving up - BREAKS the connection rather
// than ending the response, so the browser marks the download failed instead
// of keeping half a zip as if it were whole. So does a file that cannot be
// read half way.
//
// Jobs live in memory only. One nobody fetched within dlWaitTTL, or that ended
// dlEndTTL ago, is swept at the next POST; a user holds dlMaxJobs at most.

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	dlWaitTTL = 5 * time.Minute // a job the browser never fetched
	dlEndTTL  = 2 * time.Minute // an ended job, kept for the page's last look
	dlMaxJobs = 8               // per user, ended ones not yet swept included
)

// The states a job goes through. "stopped" is the DELETE or the browser
// giving up; "failed" is the server's own fault.
const (
	dlWaiting = "waiting"
	dlRunning = "running"
	dlDone    = "done"
	dlFailed  = "failed"
	dlStopped = "stopped"
)

// dlJob is one download: what was picked and how far the GET got.
type dlJob struct {
	id, role, user string
	virts          []string
	name           string // what the browser saves it as
	single         bool   // one file, sent as it is (no zip)
	files          int

	total atomic.Int64 // bytes of the files; set again by the GET's own walk
	sent  atomic.Int64 // bytes of them sent so far
	done  atomic.Int64 // files sent whole

	mu      sync.Mutex // guards what follows
	state   string
	created time.Time
	ended   time.Time
	stop    context.CancelFunc // while running
}

// Downloads holds every user's jobs.
type Downloads struct {
	mu   sync.Mutex
	jobs map[string]*dlJob
}

func NewDownloads() *Downloads { return &Downloads{jobs: map[string]*dlJob{}} }

// add sweeps the old jobs, then keeps `job` - unless its user already holds
// dlMaxJobs.
func (d *Downloads) add(job *dlJob) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := time.Now()
	n := 0
	for id, j := range d.jobs {
		if j.expired(now) {
			delete(d.jobs, id)
			continue
		}
		if j.user == job.user {
			n++
		}
	}
	if n >= dlMaxJobs {
		return false
	}
	d.jobs[job.id] = job
	return true
}

// get is the job `id` if it is `user`'s, or nil.
func (d *Downloads) get(id, user string) *dlJob {
	d.mu.Lock()
	defer d.mu.Unlock()
	if j := d.jobs[id]; j != nil && j.user == user {
		return j
	}
	return nil
}

func (j *dlJob) expired(now time.Time) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	switch j.state {
	case dlWaiting:
		return now.Sub(j.created) > dlWaitTTL
	case dlRunning:
		return false
	}
	return now.Sub(j.ended) > dlEndTTL
}

// dlRefusal is a GET that failed before its first byte: it can still answer.
type dlRefusal struct {
	status int
	msg    string
}

func (e *dlRefusal) Error() string { return e.msg }

func (s *Server) apiDownload(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	role, user := sess.Role, sess.User
	q := cleanQuery(r)

	if r.Method == http.MethodPost {
		if paths, ok := pickedPaths(w, r, q); ok {
			s.dlStart(w, r, role, user, paths)
		}
		return
	}
	job := s.downloads.get(q.Get("id"), user)
	switch {
	case r.Method != http.MethodGet && r.Method != http.MethodDelete:
		sendError(w, r, http.StatusMethodNotAllowed, "use POST, GET or DELETE")
	case job == nil:
		sendError(w, r, http.StatusNotFound, "no existe")
	case r.Method == http.MethodDelete:
		job.mu.Lock()
		switch job.state {
		case dlRunning:
			job.stop() // the GET sees it, breaks the connection and says "stopped"
		case dlWaiting:
			job.state, job.ended = dlStopped, time.Now()
		}
		job.mu.Unlock()
		sendJSON(w, r, http.StatusOK, map[string]any{"ok": true})
	case q.Has("progress"):
		job.mu.Lock()
		state := job.state
		job.mu.Unlock()
		sendJSON(w, r, http.StatusOK, map[string]any{
			"state": state, "sent": job.sent.Load(), "total": job.total.Load(),
			"files": job.files, "done": job.done.Load(),
		})
	default:
		s.dlSend(w, r, job)
	}
}

// pickedPaths is what Download and Compress (api_zip.go) pack: the ?paths= of
// the address, or {"paths": [...]} in a JSON body. The body is for a big pick:
// Ctrl+A in a folder of 1,300 photos makes an address past the server's 64 KiB
// header cap, refused with 431 every time (AB1). ok false: the answer (400 bad
// JSON, 413 over 1 MiB) is sent.
func pickedPaths(w http.ResponseWriter, r *http.Request, q Query) ([]string, bool) {
	if q.Has("paths") || !jsonBody(r) {
		return q.All("paths"), true
	}
	var in struct {
		Paths []string `json:"paths"`
	}
	if err := readJSON(w, r, &in); err != nil {
		sendBodyError(w, r, err)
		return nil, false
	}
	return in.Paths, true
}

// jsonBody reports a request that says it carries JSON.
func jsonBody(r *http.Request) bool {
	return strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json")
}

// dlStart is the POST: the paths are checked, measured and named.
func (s *Server) dlStart(w http.ResponseWriter, r *http.Request, role, user string, paths []string) {
	virts := zipVirts(paths)
	if len(virts) == 0 {
		sendError(w, r, http.StatusBadRequest, "missing ?paths=")
		return
	}
	job := &dlJob{id: newToken(), role: role, user: user, virts: virts,
		state: dlWaiting, created: time.Now()}

	if len(virts) == 1 {
		src, ok := s.users.Resolve(role, user, virts[0])
		if !ok {
			sendError(w, r, http.StatusForbidden, "forbidden")
			return
		}
		// A home the admin moved under the request: 503, never 404 (sendMissing).
		info, err := src.Stat()
		if err != nil || !(info.Mode().IsRegular() || info.IsDir()) {
			sendMissing(w, r, err, "no existe")
			return
		}
		if info.Mode().IsRegular() {
			job.single, job.files, job.name = true, 1, path.Base(virts[0])
			job.total.Store(info.Size())
		}
	}
	if !job.single {
		items, total, _, roots, status, msg := s.zipSources(role, user, virts)
		closeRoots(roots)
		if status != 0 {
			sendError(w, r, status, msg)
			return
		}
		for _, it := range items {
			if !it.dir {
				job.files++
			}
		}
		job.total.Store(total)
		job.name = dlZipName(virts)
	}

	if !s.downloads.add(job) {
		sendError(w, r, http.StatusTooManyRequests, "demasiadas descargas a la vez")
		return
	}
	sendJSON(w, r, http.StatusOK, map[string]any{
		"id": job.id, "name": job.name, "total": job.total.Load(), "files": job.files,
	})
}

// dlZipName is what a zip download is saved as: one folder -> "Fotos.zip";
// several items -> named after the folder they are in, "Drive.zip" at the top
// ("files", "shared"... are the tree's own roots, never a name to keep).
func dlZipName(virts []string) string {
	if len(virts) == 1 {
		return path.Base(virts[0]) + ".zip"
	}
	dir := path.Dir(virts[0])
	if !strings.Contains(dir, "/") {
		return "Drive.zip"
	}
	return path.Base(dir) + ".zip"
}

// dlSend is the GET the browser's downloader makes.
func (s *Server) dlSend(w http.ResponseWriter, r *http.Request, job *dlJob) {
	job.mu.Lock()
	// A file may be fetched again (a browser resuming it); a zip is written once.
	if job.state == dlRunning || (!job.single && job.state != dlWaiting) {
		job.mu.Unlock()
		sendError(w, r, http.StatusConflict, "esta descarga ya se hizo")
		return
	}
	ctx, stop := context.WithCancel(r.Context())
	defer stop()
	job.state, job.stop = dlRunning, stop
	job.sent.Store(0)
	job.done.Store(0)
	job.mu.Unlock()

	// Every byte goes through out: a write that fails is the browser gone.
	out := &dlWriter{ResponseWriter: w, ctx: ctx}
	var err error
	if job.single {
		err = s.dlSendFile(ctx, out, r, job)
	} else {
		err = s.dlSendZip(ctx, out, job)
	}

	state := dlDone
	switch {
	case ctx.Err() != nil || out.err != nil:
		state = dlStopped
	case err != nil:
		state = dlFailed
	}
	job.mu.Lock()
	job.state, job.ended, job.stop = state, time.Now(), nil
	job.mu.Unlock()

	var refused *dlRefusal
	switch {
	case errors.As(err, &refused):
		sendError(w, r, refused.status, refused.msg)
	case state == dlDone:
		s.log.Info("download: sent", "user", job.user, "name", job.name,
			"files", job.done.Load(), "bytes", job.sent.Load())
	case state == dlFailed:
		s.log.Warn("download: failed", "user", job.user, "name", job.name, "err", err)
		panic(http.ErrAbortHandler) // broken, never "complete"
	default:
		panic(http.ErrAbortHandler)
	}
}

// dlSendFile sends one file as it is; http.ServeContent answers a Range too.
func (s *Server) dlSendFile(ctx context.Context, w *dlWriter, r *http.Request, job *dlJob) error {
	src, ok := s.users.Resolve(job.role, job.user, job.virts[0])
	if !ok {
		return &dlRefusal{http.StatusForbidden, "forbidden"}
	}
	// What is sent is what was OPENED (OpenRegular). A home the admin moved
	// since the POST: 503, never 404 (missingStatus).
	f, info, err := src.OpenRegular()
	if err != nil {
		status, msg := missingStatus(err, "no existe")
		return &dlRefusal{status, msg}
	}
	defer f.Close()
	job.total.Store(info.Size())

	dlHeaders(w, ContentType(src.Abs), job.name)
	w.sent = &job.sent // a file's progress is what went out
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
	if w.err != nil {
		return w.err
	}
	job.done.Store(1)
	return nil
}

// dlSendZip writes the zip into the response while it reads the files.
func (s *Server) dlSendZip(ctx context.Context, w *dlWriter, job *dlJob) error {
	items, total, _, roots, status, msg := s.zipSources(job.role, job.user, job.virts)
	defer closeRoots(roots)
	if status != 0 {
		return &dlRefusal{status, msg}
	}
	job.total.Store(total)

	dlHeaders(w, "application/zip", job.name)
	w.WriteHeader(http.StatusOK)

	// A zip's progress is the bytes of its files READ: what went out is
	// smaller, deflated.
	count := func(in io.Reader) io.Reader { return &dlReader{r: in, ctx: ctx, read: &job.sent} }
	zw := zip.NewWriter(w)
	for _, it := range items {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Gone since the walk (deleted, moved): left out, not the whole download.
		if !it.dir {
			if _, err := it.root.Stat(it.rel); errors.Is(err, fs.ErrNotExist) {
				continue
			}
		}
		if err := addToZip(zw, it, count); err != nil {
			return err
		}
		if !it.dir {
			job.done.Add(1)
		}
	}
	return zw.Close()
}

// dlHeaders makes the response a download named `name`.
func dlHeaders(w http.ResponseWriter, ctype, name string) {
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Content-Disposition", attachmentHeader(name))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
}

// dlWriter is the response of a download: it refuses to go on once the job is
// stopped (http.ServeContent has no context of its own to watch), remembers the
// first write that failed, and counts what went out when `sent` is set.
type dlWriter struct {
	http.ResponseWriter
	ctx  context.Context
	sent *atomic.Int64 // nil: not counted here
	err  error
}

func (d *dlWriter) Write(p []byte) (int, error) {
	if d.err == nil {
		d.err = d.ctx.Err()
	}
	if d.err != nil {
		return 0, d.err
	}
	n, err := d.ResponseWriter.Write(p)
	if d.sent != nil {
		d.sent.Add(int64(n))
	}
	if err != nil {
		d.err = err
	}
	return n, err
}

// dlReader counts the bytes of a file as the zip reads it, and stops a big
// file half way once the job is stopped.
type dlReader struct {
	r    io.Reader
	ctx  context.Context
	read *atomic.Int64
}

func (d *dlReader) Read(p []byte) (int, error) {
	if err := d.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := d.r.Read(p)
	d.read.Add(int64(n))
	return n, err
}
