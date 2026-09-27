package main

// =============================================================================
// Middleware - the wrappers every request passes through before routing.
// =============================================================================
//
// java: these are SERVLET FILTERS. The shape is always the same: take an
// http.Handler, return an http.Handler that does something and then calls the
// one it was given. `next.ServeHTTP(w, r)` is `chain.doFilter(req, res)`.
//
// java: http.Handler is a one-method interface - ServeHTTP(ResponseWriter,
// *Request). That is HttpServlet.service(). http.HandlerFunc is an adapter that
// turns a plain function into one, so a route can be written as a function
// instead of a type. Go has no lambdas-with-interfaces magic; HandlerFunc is
// just a named function type with a ServeHTTP method on it.

import (
	"net/http"
	"net/url"
	"strings"
	"time"
)

// recoverPanic turns a crash in a route into a clean 500, and logs the stack.
//
// java: a PANIC is a RuntimeException. Unhandled, it unwinds the goroutine -
// and net/http already recovers panics per request, so one bad route cannot
// take the process down. We install our own anyway for two reasons: to log it
// the way this project logs everything else, and to answer with the same
// {"error": ...} JSON shape the browser apps expect, which is what handler.py's
// catch-all does.
//
// java: `recover()` only works inside a deferred function, and returns nil when
// nothing is panicking. There is no `catch`; this is the whole mechanism.
func recoverPanic(log Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				// http.ErrAbortHandler is net/http's own "the client went away"
				// signal. Re-panic so the server handles it as usual instead of
				// logging a false alarm.
				if err == http.ErrAbortHandler {
					panic(err)
				}
				log.Error("request panicked",
					"method", r.Method, "path", redactPath(r.URL.Path), "err", err)
				sendError(w, r, http.StatusInternalServerError, "error interno")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// logRequest writes one line per request at DEBUG, and the slow ones at INFO.
//
// java: log/slog is the stdlib's structured logger - slf4j without the
// dependency or the four competing backends. Key/value pairs, not string
// concatenation, so a log line can be parsed later.
//
// java: to log the STATUS we have to wrap the ResponseWriter, because it will
// not tell us what was written. statusRecorder below is that wrapper.
func logRequest(log Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(rec, r)

		log.Debug("request",
			"method", r.Method,
			"path", redactPath(r.URL.Path), // never a link's token
			"status", rec.status,
			"bytes", rec.written,
			"ms", time.Since(started).Milliseconds())
	})
}

// refuseChunked rejects a request body sent with Transfer-Encoding: chunked.
//
// java: handler.py refuses these because BaseHTTPRequestHandler does NOT
// de-chunk, so the body would be left in the socket and parsed as the next
// request - request smuggling. net/http de-chunks correctly, so the danger is
// gone in Go. The refusal stays only so the two servers answer identically
// while both are running; the real port can drop this filter.
//
// It sits OUTSIDE refuseTraversal and INSIDE securityHeaders, which is where
// _dispatch does the same test: before the URL is looked at, after the headers
// every response carries. A chunked PUT reaches this before streamToFile's own
// length check, so both servers give the same reason for the same 411.
func refuseChunked(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, enc := range r.TransferEncoding {
			if strings.EqualFold(enc, "chunked") {
				// The Python drops the connection here: its unread body would
				// be parsed as the next request on a kept-alive socket. Go has
				// no such hazard, but the header keeps the answers identical.
				w.Header().Set("Connection", "close")
				sendError(w, r, http.StatusLengthRequired, "usa Content-Length (no chunked)")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// collapsePath rewrites a URL path with repeated slashes or "." segments into
// the single-slash form, IN PLACE, so the router never sees the odd shape.
//
// java: http.ServeMux runs path.Clean() on every request and, when the result
// differs, answers its own 307 to the cleaned URL instead of routing. That is
// one round trip the Python never asks for, and it is visible: it turns a
// served page into a redirect.
//
// The Python arrives at the same place by two different routes, and this
// reproduces both:
//
//   - a LEADING "//" is collapsed by BaseHTTPRequestHandler.parse_request
//     itself, so "//nayive/login.html" reaches the handler as
//     "/nayive/login.html" (without that, urlparse would read "nayive" as a
//     netloc and the path would come out as just "/login.html");
//   - an INTERIOR "//" or "." is left alone in self.path and absorbed later,
//     when the path is split into segments and the empty and "." ones are
//     dropped - the same rule splitPath applies here.
//
// ".." never reaches this: refuseTraversal wraps it and answers 403 first, on
// the raw path. That ordering matters - collapsing first would let
// "/nayive/..//config" past a guard looking for a literal ".." segment.
func collapsePath(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := r.URL.EscapedPath()
		cleaned := collapseSegments(raw)
		if cleaned == raw {
			next.ServeHTTP(w, r)
			return
		}
		// java: the shallow copy is what net/http's own StripPrefix does - a
		// handler must not mutate the request it was given, because the caller
		// (here, the logger) still holds it.
		parsed, err := url.Parse(cleaned)
		if err != nil {
			next.ServeHTTP(w, r) // unparseable: leave it exactly as it came
			return
		}
		u := *r.URL
		u.Path, u.RawPath = parsed.Path, parsed.RawPath
		r2 := new(http.Request)
		*r2 = *r
		r2.URL = &u
		next.ServeHTTP(w, r2)
	})
}

// collapseSegments drops the empty and "." segments of a path, keeping the
// leading slash and any trailing one. "/a//b/./c/" -> "/a/b/c/".
//
// It is splitPath's rule written back out as a path, and deliberately does NOT
// touch "..": that is refuseTraversal's business, and this never sees one.
func collapseSegments(p string) string {
	if p == "" || (!strings.Contains(p, "//") &&
		!strings.Contains(p, "/./") && !strings.HasSuffix(p, "/.")) {
		return p
	}
	trailing := strings.HasSuffix(p, "/") || strings.HasSuffix(p, "/.")

	out := make([]string, 0, 8)
	for _, seg := range strings.Split(p, "/") {
		if seg != "" && seg != "." {
			out = append(out, seg)
		}
	}
	cleaned := "/" + strings.Join(out, "/")
	if trailing && cleaned != "/" {
		cleaned += "/"
	}
	return cleaned
}

// statusRecorder remembers the status code and body size that went out.
//
// java: embedding http.ResponseWriter forwards Header() and anything else we do
// not override, so this stays three lines instead of a full delegating class.
type statusRecorder struct {
	http.ResponseWriter
	status  int
	written int
}

func (s *statusRecorder) WriteHeader(status int) {
	s.status = status
	s.ResponseWriter.WriteHeader(status)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	n, err := s.ResponseWriter.Write(b)
	s.written += n
	return n, err
}

// securityHeaders adds the three headers handler.py puts on every response.
//
// java: a filter is the right place for these - one line each, applied
// everywhere, impossible for a new route to forget. There is deliberately no
// Content-Security-Policy here: it is easy to break the vendored libraries with
// one, and handler.py says the same. The two exceptions are content Nayive did
// not write - a user's HTML/SVG (filesRead) and a static site (serveSite) - and
// each sets its own sandbox.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Server", "nayive/2.0")
		next.ServeHTTP(w, r)
	})
}

// refuseTraversal answers 403 for any URL whose RAW path carries a ".."
// segment, before the router ever sees it.
//
// java: http.ServeMux CLEANS the path and answers 301/307 to the cleaned URL,
// so "/nayive/../config/server.json" would quietly become a redirect to
// "/config/server.json". Nothing leaks - that URL is a 404 - but handler.py
// answers a flat 403 there, and a security boundary is the last place two
// servers should disagree. Checked on r.URL.Path, which is already
// percent-decoded, so "%2e%2e" is caught too.
func refuseTraversal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, seg := range strings.Split(r.URL.Path, "/") {
			if seg == ".." {
				sendText(w, r, http.StatusForbidden, "Forbidden.\n")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// redactPath is a URL path fit for the log: the segment that IS a secret - a
// chat link's token (/c/..., /api/c/...), a public trip link's (/s/...,
// /api/public/...), a location app's key (/api/location/...) - becomes "-".
// Anyone reading the log could otherwise open the chat, the trip or post
// positions as its owner.
func redactPath(p string) string {
	parts := strings.Split(collapseSegments(p), "/")
	at := -1
	switch {
	case len(parts) > 2 && (parts[1] == "c" || parts[1] == "s"):
		at = 2
	case len(parts) > 3 && parts[1] == "api" &&
		(parts[2] == "c" || parts[2] == "public" || parts[2] == "location"):
		at = 3
	}
	if at < 0 || parts[at] == "" {
		return p
	}
	parts[at] = "-"
	return strings.Join(parts, "/")
}

// bodyReadBase is how long a request body may take to arrive, plus one second
// for every bodyMinRate bytes it declares. A var so a test can shorten it.
var bodyReadBase = 30 * time.Second

// bodyMinRate is the slowest upload, in bytes a second, that still finishes:
// 16 KiB/s, what even a bad mobile line sends. Lower and a login's 1 MiB body
// buys minutes per connection (at 1 KiB/s it was 17), which a few dozen
// dribbling clients turn into everyone locked out.
const bodyMinRate = 16 << 10

// bodyAllowance is how long a body of `length` bytes (-1: not said) may take.
func bodyAllowance(length int64) time.Duration {
	allowed := bodyReadBase
	if length > 0 {
		secs := min(length/bodyMinRate, 30*24*3600) // no overflow
		allowed += time.Duration(secs) * time.Second
	}
	return allowed
}

// bodyDeadline puts a read deadline on a request's BODY, and only there.
//
// ReadHeaderTimeout covers the headers; nothing covered the body, so a client
// could send the headers of a POST /api/login and then one byte a minute, and
// 250 of those held every connection slot. The deadline grows with the declared
// length (bodyAllowance), so a big upload on a slow line still gets through. A
// request with no body gets none at all. What one client can hold at once is
// capped too, by address (listener.go).
//
// It never reaches a long-poll (the chat's 25 s, a phone's minutes): once the
// body has been read to the end, net/http lifts the deadline itself as it
// starts the background read that notices a client hanging up - HTTP/2's is
// per stream and ends with the body. TestLongPollSurvivesBodyDeadline holds
// that in place. A body the handler never reads keeps its deadline, which is
// what bounds the server draining it after the answer.
//
// java: http.ResponseController reaches the connection behind a
// ResponseWriter. It must be given the server's OWN writer, which is why this
// is the outermost filter - statusRecorder does not pass it through.
func bodyDeadline(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength != 0 && r.Body != nil && r.Body != http.NoBody {
			// An error only means this writer cannot reach a socket (a test's
			// recorder): nothing to bound.
			http.NewResponseController(w).SetReadDeadline(time.Now().Add(bodyAllowance(r.ContentLength)))
		}
		next.ServeHTTP(w, r)
	})
}
