package main

// =============================================================================
// Server - everything the process owns, and the URL table.
// =============================================================================
//
// lib/config.py builds module-level CONFIG, SESSIONS and a logger that every
// other module imports: a set of singletons. Here they are FIELDS OF Server and
// are passed in at construction, which is what lets a test - or a side-by-side
// parity run against the Python - stand two servers up in one process.
//
// ROUTING. The Python funnels every method into one _dispatch() with a chain of
// `if path == ...` tests, so the ORDER of that chain is the priority and moving
// a line changes behaviour. http.ServeMux sorts patterns by specificity
// instead, so "/api/login" beats "/api/" no matter what order they were
// registered in. The registrations below are still written in the Python's
// order, purely so the two files read the same way.

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Server holds the running server's collaborators.
type Server struct {
	cfg      *Config
	log      Logger
	sessions *SessionStore
	users    *Users
	shares   *Shares
	trackers *Trackers
	tree     *FileTree
	trash    *Trash
	push     *VapidStore
	convert  *Converter
	office   *Office
	static   *StaticFiles

	httpd  *http.Server
	scheme string // "http" or "https", decided at construction

	// authMu serialises every credential check across the whole process. One at
	// a time, plus the ~0.4 s penalty on a wrong guess, caps password guessing
	// at roughly 2 tries a second no matter how many connections or source IPs
	// an attacker uses. A per-request sleep alone did nothing: 250 workers meant
	// 250 parallel guesses.
	authMu sync.Mutex
}

const authFailDelay = 400 * time.Millisecond

// NewServer wires everything up. It does NOT listen yet - Start does that.
func NewServer(cfg *Config, log Logger) (*Server, error) {
	shares := NewShares(cfg.ConfigDir, cfg.HomesDir, log)
	users := NewUsers(cfg, shares, log)
	tree := NewFileTree(cfg.BaseDir, cfg.HomesDir, cfg.ConfigDir, shares)
	trash := NewTrash(cfg.BaseDir, cfg.HomesDir, users, log)

	var contact string
	cfg.Read(func(s *ServerConfig) { contact = s.PushContact })
	push := NewVapidStore(cfg.ConfigDir, contact, log)

	static, err := NewStaticFiles(cfg.AppsDir, log)
	if err != nil {
		return nil, err
	}

	s := &Server{
		cfg:      cfg,
		log:      log,
		sessions: NewSessionStore(cfg.SessionTTL),
		users:    users,
		shares:   shares,
		trackers: NewTrackers(cfg.ConfigDir, log),
		tree:     tree,
		trash:    trash,
		push:     push,
		convert:  NewConverter(cfg, users, trash, push, log),
		office:   NewOffice(log),
		static:   static,
		scheme:   "http",
	}

	// TIMEOUTS. ReadHeaderTimeout is the one that matters: it stops a client
	// that opens a socket and dribbles headers forever (Slowloris). IdleTimeout
	// reaps a kept-alive connection nobody is using any more.
	//
	// ReadTimeout and WriteTimeout are deliberately ZERO, and that is not
	// laziness. net/http applies both as an ABSOLUTE deadline stamped on the
	// socket when the request arrives - not as an idle timeout. A 10-minute
	// WriteTimeout therefore cuts any response still being written ten minutes
	// in, however fast the bytes are actually flowing: a film streamed by
	// Movies, a 500 MB download over a slow line, a phone uploading a video.
	// The client cannot tell that from the network dropping.
	//
	// The Python has no such cap. Its sock.settimeout(30) is an IDLE timeout -
	// it resets on every read or write that makes progress - so a transfer may
	// take as long as it takes while it keeps moving. Zero here is the closest
	// honest equivalent, and it leaves the two servers behaving the same.
	//
	// TODO: the real fix is an idle deadline of our own, pushed forward as
	// bytes move, via http.ResponseController (Go 1.20+): SetReadDeadline from
	// cappedWriter.Write on the upload path, SetWriteDeadline from a wrapper
	// around the ReadSeeker that ServeContent copies from. See
	// docs/go-port-review.md, B1.
	s.httpd = &http.Server{
		Addr:              cfg.Addr(),
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       0, // absolute, not idle - see above
		WriteTimeout:      0, // absolute, not idle - see above
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}

	if err := s.configureTLS(); err != nil {
		// Missing file, unreadable key (letsencrypt directories are root-only),
		// bad PEM. Do not crash - say why and serve plain HTTP, like server.py.
		log.Warn("TLS disabled, serving plain HTTP", "err", err)
	}
	return s, nil
}

func (s *Server) configureTLS() error {
	var cert, key string
	s.cfg.Read(func(c *ServerConfig) { cert, key = c.TLS.CertFile, c.TLS.KeyFile })
	if cert == "" || key == "" {
		return nil // not an error: TLS was simply not asked for
	}
	pair, err := tls.LoadX509KeyPair(absUnder(s.cfg.Here, cert), absUnder(s.cfg.Here, key))
	if err != nil {
		return err
	}
	s.httpd.TLSConfig = &tls.Config{
		Certificates: []tls.Certificate{pair},
		MinVersion:   tls.VersionTLS12,
	}
	s.scheme = "https"
	return nil
}

// URL is the address to print in the startup banner.
func (s *Server) URL() string {
	host := s.cfg.Server.Host
	if host == "" || host == "0.0.0.0" {
		host = "localhost"
	}
	return s.scheme + "://" + host + ":" + strconv.Itoa(s.cfg.Server.Port)
}

// Start listens and serves until `ctx` is cancelled, then shuts down cleanly.
// It BLOCKS, like serve_forever().
func (s *Server) Start(ctx context.Context) error {
	listener, err := net.Listen("tcp", s.cfg.Addr())
	if err != nil {
		return err
	}
	listener = newLimitListener(listener, maxConcurrent)

	go func() {
		<-ctx.Done()
		// Give in-flight requests a moment to finish before we pull the rug.
		// Shutdown stops accepting, then waits for the live ones - the Python's
		// server_close() does neither.
		grace, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.httpd.Shutdown(grace); err != nil {
			s.log.Warn("shutdown was not clean", "err", err)
		}
	}()

	s.log.Info("serving", "url", s.URL(), "base_dir", s.cfg.BaseDir,
		"log_level", s.cfg.LogLevelName)

	if s.httpd.TLSConfig != nil {
		err = s.httpd.ServeTLS(listener, "", "")
	} else {
		err = s.httpd.Serve(listener)
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil // the normal end of a graceful shutdown
	}
	return err
}

// Close releases what the server owns.
func (s *Server) Close() error {
	s.office.Close()
	return s.static.Close()
}

// -----------------------------------------------------------------------------
// the URL table
// -----------------------------------------------------------------------------

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	// --- sessions ----------------------------------------------------------
	// Registered WITHOUT a method in the pattern, so a GET to /api/login gets
	// the Python's answer rather than the mux's own 405.
	mux.HandleFunc("/api/login", s.apiLogin)
	mux.HandleFunc("/api/logout", s.apiLogout)
	mux.HandleFunc("/api/whoami", s.apiWhoami)
	mux.HandleFunc("/api/password", s.apiPassword)

	// --- per-account settings ----------------------------------------------
	mux.HandleFunc("/api/lang", s.apiLang)
	mux.HandleFunc("/api/tz", s.apiTZ)
	mux.HandleFunc("/api/push", s.apiPush)

	// --- the admin panel ---------------------------------------------------
	// NOT wrapped in a session guard: while no admin account exists this route
	// is deliberately open, so the very first admin can be created.
	mux.HandleFunc("/api/admin", s.apiAdmin)

	// --- sharing -----------------------------------------------------------
	mux.HandleFunc("/api/shares", s.apiShares)
	mux.HandleFunc("/api/users", s.apiUsers)

	// --- public trip links: NO session (see api_public.go) -----------------
	mux.HandleFunc("/s/{token}", s.publicPage)
	mux.HandleFunc("/api/public/{token}", s.apiPublic)
	mux.HandleFunc("/api/public/{token}/{kind}/{name}", s.apiPublicFile)
	mux.HandleFunc("/api/location", s.apiLocation)               // a Nayive page reports where it is
	mux.HandleFunc("/api/owntracks", s.apiOwnTracks)             // the owner's OwnTracks URL
	mux.HandleFunc("/api/owntracks/{key}", s.apiOwnTracksReport) // the app itself: no session

	// --- the file API ------------------------------------------------------
	mux.HandleFunc("/api/files", s.apiFiles)
	mux.HandleFunc("/api/convert", s.apiConvert) // Go only - see convert.go
	mux.HandleFunc("/api/office", s.apiOffice)   // Go only - see office.go

	// Anything else under /api/ is a 404 in JSON, never an HTML error page: the
	// browser apps parse every /api/ answer as JSON.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		sendError(w, r, http.StatusNotFound, "no such endpoint")
	})

	// "/api" with NO trailing slash has to be registered explicitly, and this is
	// not a stylistic choice. Without it http.ServeMux sees a request for the
	// subtree pattern "/api/" minus its slash and answers its own 307 redirect
	// to "/api/" - where handler.py, whose `path.startswith("/api/")` is simply
	// false for "/api", falls through to the same plain-text 404 as any other
	// unknown URL. Registering the exact pattern is what suppresses the mux's
	// redirect. (Same reason URLPrefix is registered both with and without its
	// slash, a few lines down.)
	mux.HandleFunc("/api", s.handleRoot)

	// --- the static apps ---------------------------------------------------
	mux.HandleFunc(URLPrefix+"/{path...}", s.serveStatic)
	mux.HandleFunc(URLPrefix, s.serveStatic)

	// Old mount point: 301 every /apps/... to the same path under /nayive/, so
	// existing bookmarks and links keep working.
	mux.HandleFunc("/apps/{path...}", func(w http.ResponseWriter, r *http.Request) {
		redirect(w, http.StatusMovedPermanently, URLPrefix+"/"+r.PathValue("path"))
	})
	mux.HandleFunc("/apps", func(w http.ResponseWriter, r *http.Request) {
		redirect(w, http.StatusMovedPermanently, URLPrefix)
	})

	// --- the front door ----------------------------------------------------
	mux.HandleFunc("/", s.handleRoot)

	// Read the chain INSIDE OUT: recoverPanic runs first, then the request log,
	// then the security headers, then the chunked refusal, then the traversal
	// guard, then the mux. The security headers must sit OUTSIDE both guards, or
	// a refused request would go out without them - which is the one response
	// where they matter most. Wrapping in the other order would put the panic
	// guard inside the logger and a panic would skip the log line.
	//
	// collapsePath goes INSIDE refuseTraversal, so the ".." guard still reads the
	// raw path: collapsing first would let "/nayive/..//config" past it.
	//
	// refuseChunked goes OUTSIDE refuseTraversal because _dispatch tests
	// Transfer-Encoding before it looks at the path at all: a chunked request to
	// a traversal URL is a 411 on both servers, not a 403.
	var h http.Handler = mux
	h = collapsePath(h)
	h = refuseTraversal(h)
	h = refuseChunked(h)
	h = securityHeaders(h)
	h = logRequest(s.log, h)
	h = recoverPanic(s.log, h)
	return h
}

// handleRoot sends a visitor to the launcher, or to the login page.
func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		sendText(w, r, http.StatusNotFound, "Not found.\n")
		return
	}
	home := URLPrefix + "/"
	if _, signedIn := s.session(r); signedIn {
		redirect(w, http.StatusFound, home)
		return
	}
	redirect(w, http.StatusFound, URLPrefix+"/login.html?return="+quotePath(home))
}

// session resolves the request's cookie.
func (s *Server) session(r *http.Request) (Session, bool) {
	return s.sessions.Get(tokenFrom(r))
}

// requireSession answers 401 and reports false when nobody is signed in. Every
// API route starts with it, mirroring the Python's `if not session:` prelude.
func (s *Server) requireSession(w http.ResponseWriter, r *http.Request) (Session, bool) {
	sess, ok := s.session(r)
	if !ok {
		sendError(w, r, http.StatusUnauthorized, "not signed in")
		return Session{}, false
	}
	return sess, true
}
