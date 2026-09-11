package main

// =============================================================================
// nayive - a small multi-user file server for the "Nayive" personal web apps.
// =============================================================================
//
// Go, standard library only. `go list -m all` prints one line; the build output
// is a single static binary that runs on any Linux with nothing installed.
//
//	go build -o nayive .    &&    ./nayive
//
// This is a port of the Python server that came before it (todeploy/server.py +
// todeploy/lib/), kept behaviour-for-behaviour compatible: the same URLs, the
// same JSON, the same files on disk. The one thing that changed for the better
// is that NOTHING has to be installed any more - lib/webpush.py needed
// python3-cryptography from apt, and Go's standard library covers ECDH, ECDSA,
// HKDF and AES-GCM on its own.
//
// DESIGN RULE, unchanged: the server does as little as possible - it stores and
// serves bytes, checks the session and the path sandbox, and that is it.
// Everything that can run in the browser does (EXIF / ID3 scans, Photos
// thumbnails, the trip and birthday reminder tasks). What remains here is kept
// cheap: pre-built .gz sidecars for the static apps, a bounded gzip for text API
// answers, disk usage cached per user, calendars parsed only when they change.
//
// It serves two things:
//
//  1. The static single-page apps under ./apps/ (calc, calendar, contact,
//     drive, planner, tasks, text, trips, write, and the index.html launcher).
//  2. A JSON file API under /api/ that those apps use to read and write their
//     data.
//
// The apps are mounted in the browser at /nayive/ (the disk folder stays
// ./apps/); old /apps/... URLs are 301-redirected to /nayive/...
//
// Every request needs a session. A visitor signs in at /nayive/login.html with a
// user name and a password; on success the server sets an HttpOnly
// `nayive_session` cookie and every later request is authorised from it.
//
//   - The ADMIN account lives in ./config/server.json ("admin" block). Admin
//     sees and can edit the whole tree in the Drive app. If that block is empty
//     (a fresh install), the admin panel at /nayive/admin.html opens with NO
//     login so the first admin can be created.
//   - A REGULAR USER "alice" has a folder ./homes/alice/ whose
//     ./homes/alice/data/config.json holds {"password": "...", "quota": <GiB>}.
//
// Per-user path model (what the ?file= API accepts), resolved from the session:
//
//	data/<x>    ->  ./homes/<user>/data/<x>     app data; hidden from Drive
//	files/<x>   ->  ./homes/<user>/files/<x>    the user's documents
//	apps/<x>    ->  ./apps/<x>                  shared, read-only
//	shared/<x>  ->  another user's file, read-only (see shares.go)
//
//	(admin: any path is resolved straight under the server root)
//
// File layout of the port, one file per concern:
//
//	main.go        the entry point: flags, logging, signals
//	config.go      config/server.json, the derived paths, the atomic write
//	server.go      the Server struct, timeouts, TLS, the URL table
//	listener.go    the connection cap
//	middleware.go  the panic guard, the request log, the security headers
//	response.go    sendJSON / sendText / the gzip tiers / the body cap
//	query.go       the query string, read the way Python's parse_qs reads it
//	sessions.go    the in-memory session table and its cookie
//	users.go       authentication, accounts, the path sandbox, quota, push subs
//	shares.go      read-only sharing between users
//	filetree.go    the /api/files tree, disk sizes, content types
//	fnmatch.go     Python's shell-style wildcard matcher, ported
//	paths.go       the segment arithmetic every sandbox check is built on
//	trash.go       the trash can (.trash/ + index.json)
//	ics.go         a tiny read-only iCalendar reader
//	webpush.go     Web Push crypto and sending
//	reminders.go   the background loop: reminders, session and trash sweeps
//	api_auth.go    login / logout / whoami / password / lang / tz / users
//	api_push.go    this user's devices
//	api_admin.go   the admin panel
//	api_shares.go  sharing
//	api_files.go   the file API
//	upload.go      PUT: streaming an upload to disk
//	static.go      the /nayive/ apps: Range, 304, .gz sidecars, path sandbox
//
// Testing from the shell:
//
//	# sign in, keep the cookie
//	curl -kc jar.txt -X POST https://localhost:4343/api/login \
//	     -H 'Content-Type: application/json' -d '{"user":"ana","password":"..."}'
//
//	# then use it
//	curl -kb jar.txt 'https://localhost:4343/api/files?file=data/tasks.json'
//	curl -kb jar.txt  https://localhost:4343/api/files          # the file tree

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	// java: a BLANK IMPORT is loaded only for the side effect of its init()
	// code - here, embedding the IANA time-zone database in the binary. Without
	// it, a box with no tzdata package installed would silently read every
	// user's "Europe/Madrid" as UTC, and every floating calendar time would
	// drift. Python gets the database from the OS and has the same weakness;
	// this closes it, and costs ~450 KB.
	_ "time/tzdata"
)

func main() {
	configPath := flag.String("config", "config/server.json", "path to the config file")
	flag.Parse()

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		// A malformed config file is fatal, and this is the only place in the
		// program that exits. Everything else RETURNS an error and lets the
		// caller decide.
		fatal("config: %v", err)
	}

	log := newLogger(cfg.LogLevel)

	server, err := NewServer(cfg, log)
	if err != nil {
		fatal("start: %v (is %s a real directory?)", err, cfg.AppsDir)
	}
	defer server.Close()

	// Clear any temp file a previous run left behind (a kill -9 mid-write).
	if removed := server.tree.SweepStaleTemp(); removed > 0 {
		fmt.Printf("[i] removed %d stale temp file(s)\n", removed)
	}

	// Load (or, on a brand-new install, create) the Web Push signing key before
	// anything can use it, and print it. Seeing this key CHANGE between restarts
	// is the only visible sign that every device's notifications just died - see
	// VapidStore.
	if key, err := server.push.PublicKey(); err == nil {
		fmt.Printf("[i] push notifications ready\n    VAPID public key: %s\n", key)
	} else {
		fmt.Printf("[!] push notifications DISABLED: %v\n", err)
	}

	// signal.NotifyContext cancels the context when one of these arrives.
	// SIGTERM is the one that matters in production - systemd sends TERM, not
	// INT, so the Python's KeyboardInterrupt handler never actually ran on the
	// VPS and it was killed mid-request. Both are covered here.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go NewReminders(cfg, server.users, server.trash, server.sessions,
		server.push, log).Run(ctx)

	// Converting uploaded videos needs ffmpeg + ffprobe on the machine
	// (`sudo apt install ffmpeg`). Without them Drive simply never offers it.
	if server.convert.Available() {
		fmt.Println("[i] video conversion ready (ffmpeg found)")
	} else {
		fmt.Println("[!] video conversion OFF: ffmpeg/ffprobe not installed")
	}
	go server.convert.Run(ctx)

	// LibreOffice documents (.odt, .ods) become .docx / .xlsx beside the
	// original (`sudo apt install --no-install-recommends
	// libreoffice-writer-nogui libreoffice-calc-nogui`). Without it Drive
	// uploads them as they are and says it cannot convert.
	if server.office.Available() {
		fmt.Println("[i] LibreOffice conversion ready (soffice found)")
	} else {
		fmt.Println("[!] LibreOffice conversion OFF: soffice not installed")
	}

	// The startup banner goes to stdout directly, so it shows even when
	// log_level hides INFO - which the default "error" does.
	fmt.Printf("nayive serving %s on %s  (log_level=%s)\n",
		cfg.BaseDir, server.URL(), cfg.LogLevelName)
	if cfg.AdminIsConfigured() {
		fmt.Printf("    sign in at %s%s/login.html\n", server.URL(), URLPrefix)
	} else {
		fmt.Printf("    NO admin account yet - create one at %s%s/admin.html\n",
			server.URL(), URLPrefix)
	}

	if err := server.Start(ctx); err != nil {
		fatal("serve: %v", err)
	}
	fmt.Println("[!] stopped.")
}

// newLogger builds the structured logger at the level the config asked for.
//
// java: log/slog is the standard library's slf4j. One handler, key/value pairs,
// no XML. slog.LevelError is the project default: quiet unless something broke.
func newLogger(level slog.Level) *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			// Match the Python's "%Y-%m-%d %H:%M:%S" stamp, so the two servers'
			// logs interleave readably during a parity run.
			if a.Key == slog.TimeKey {
				a.Value = slog.StringValue(a.Value.Time().Format(time.DateTime))
			}
			return a
		},
	}))
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[!] "+format+"\n", args...)
	os.Exit(1)
}
