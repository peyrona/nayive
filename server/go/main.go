package main

// =============================================================================
// nayive - a small multi-user file server for the "Nayive" personal web apps.
// =============================================================================
//
// Go, the standard library plus vendored go-imap / go-message / x/text for
// eMail (vendor/). The build output is a single static binary that runs on any
// Linux with nothing installed.
//
//	go build -o nayive .    &&    ./nayive
//
// It began as a port of an older Python server, and kept its URLs, its JSON
// and its files on disk. Go's standard library covers the rest - TLS, ECDH,
// ECDSA, HKDF, AES-GCM for Web Push - so nothing is installed
// beside the binary (ffmpeg and LibreOffice only for the optional video and
// Office conversions).
//
// DESIGN RULE: the server does as little as possible - it stores and serves
// bytes, checks the session and the path sandbox, and that is it. Everything
// that can run in the browser does (EXIF / ID3 scans, Photos thumbnails). What
// remains here is kept cheap: pre-built .gz sidecars for the static apps, a
// bounded gzip for text API answers, disk usage cached per user, calendars
// parsed only when they change.
//
// It serves:
//
//  1. The static single-page apps, from the folder "apps_dir" names in
//     config/server.json (default ./apps/), at /nayive/ in the browser; old
//     /apps/... URLs are 301-redirected there.
//  2. A JSON API under /api/ that those apps use to read and write their data.
//  3. The few pages that need no Nayive account: a public trip link (/s/...),
//     a person's chat link (/c/...), the location apps' reports
//     (/api/location/<key>/...), a phone's own API (/api/device, by its
//     token), and the static web sites beside Nayive (sites.go).
//
// Everything else needs a session. A visitor signs in at /nayive/login.html
// with a user name and a password; on success the server sets an HttpOnly
// `nayive_session` cookie and every later request is authorised from it.
//
//   - The ADMIN account lives in ./config/server.json ("admin" block). Admin
//     sees and can edit the whole tree in the Drive app. If that block is empty
//     on a fresh install (no users yet), the admin panel at /nayive/admin.html
//     opens with NO login so the first admin can be created.
//   - A REGULAR USER "alice" has a folder ./homes/alice/ whose
//     ./homes/alice/data/config.json holds {"password": "...", "quota": <GiB>}.
//
// Per-user path model (what the ?file= API accepts), resolved from the session:
//
//	data/<x>    ->  ./homes/<user>/data/<x>     app data; hidden from Drive
//	files/<x>   ->  ./homes/<user>/files/<x>    the user's documents
//	apps/<x>    ->  <apps_dir>/<x>              shared, read-only
//	shared/<x>  ->  another user's file, read-only (see shares.go)
//
//	(admin: any path is resolved straight under the server root)
//
// Files, one concern each (the _test.go files beside them test them):
//
//	main.go, server.go      the entry point; the Server struct, TLS, the URL table
//	config.go               config/server.json, the derived paths, the atomic write
//	listener.go, waitcap.go the connection cap; long-polls per credential
//	middleware.go           the panic guard, the request log, the security headers
//	response.go, query.go   answering (JSON, text, gzip, body cap); the query string
//	sessions.go             the session table (kept across restarts) and its cookie
//	password_hash.go        stored passwords (PBKDF2)
//	users.go                accounts, the API path sandbox, quota, push subs
//	paths.go, sandbox.go    the segment arithmetic; the kernel-enforced sandbox
//	orderedjson.go          settings files that keep their key order
//	store_owner.go          one browser, two accounts: whose save is this
//	api_auth.go             login / logout / whoami / password / lang / tz / users
//	api_admin.go            the admin panel
//	api_files.go, upload.go the file API; PUT streamed to disk
//	filetree.go, search.go  the tree, disk sizes, content types; Drive's search
//	fnmatch.go              shell-style wildcards
//	copy.go, api_download.go  Drive's "Copy to..."; "Download", sent by the server
//	api_zip.go              a .zip: its contents, "Extract here", "Compress"
//	trash.go                the trash can (.trash/ + index.json)
//	shares.go, api_shares.go  sharing between users; public trip links
//	photos_notes_b4.go      a shared album's photo notes, lent read-only
//	api_public.go           what a public trip link shows
//	exifmeta.go, exifstrip.go, exifstrip_avif.go
//	                        a photo's place and time; its GPS taken out
//	photo_position.go       a photo's GPS as a trip position
//	positions.go, journey.go  where a trip's owner has been; the Journey map
//	location.go             the location apps (Overland, GPSLogger)
//	devices.go              the Android app's phones: find, ring, report
//	reminders.go, reminders_location.go
//	                        the background loop: events, trips, location alerts, sweeps
//	ics.go                  a tiny read-only iCalendar reader
//	webpush.go, push_send.go, api_push.go
//	                        Web Push crypto; one push in the user's words; their devices
//	chat.go, api_chat.go, chat_call.go, keptindex.go
//	                        Chat: conversations, links, calls, kept photos
//	vcard_photo.go          a Contacts picture set from Chat
//	mail*.go, api_mail.go   eMail: IMAP, JMAP, SMTP, labels, pushes
//	api_bookmarks.go        Bookmarks: a page's title and icon, fetched here
//	convert.go, api_convert.go  videos browsers cannot play, turned into .mp4
//	office.go, api_office.go    LibreOffice documents, given an Office twin
//	fileid_unix.go, fileid_other.go  a file's identity (inode) where there is one
//	static.go, sites.go     the /nayive/ apps; the static web sites
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
	// drift. This costs ~450 KB.
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
		fatal("start: %v (is %s a real directory? \"apps_dir\" in %s says where the apps are)",
			err, cfg.AppsDir, cfg.Path)
	}
	defer server.Close()

	// Clear any temp file a previous run left behind (a kill -9 mid-write).
	if removed := server.tree.SweepStaleTemp(); removed > 0 {
		fmt.Printf("[i] removed %d stale temp file(s)\n", removed)
	}
	if removed := SweepOfficeTemp(); removed > 0 {
		fmt.Printf("[i] removed %d stale LibreOffice folder(s)\n", removed)
	}

	// The only visible sign that a restart signed nobody out (sessions.go).
	fmt.Printf("[i] %d session(s) kept from the last run\n", server.sessions.Count())

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
	// INT; a server that caught only INT would be killed mid-request. Both are
	// covered here.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	reminders := NewReminders(cfg, server.users, server.trash, server.sessions,
		server.push, server.trackers, log)
	reminders.devices = server.devices // a phone with the app needs no "turn location on" alert
	go reminders.Run(ctx)

	// Chat's auto-delete: messages older than each owner's "delete after N days".
	go server.chat.RunExpiry(ctx)
	// Chat's scheduled texts ("Schedule message"), sent when their time comes.
	go server.chat.RunLater(ctx)
	// eMail: every account's unread count, for the launcher's badge.
	go server.mail.RunPoller(ctx)
	// eMail: the Trash deletes for good what is older than each user's days.
	go server.mail.RunPurge(ctx)

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
			// "2006-01-02 15:04:05": no zone, no fractions - short enough to
			// read down a log.
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
