package main

// =============================================================================
// Writing responses - the four helpers every route uses.
// =============================================================================
//
// These are the Go copies of handler.py's _send_bytes / _send_json / _send_text
// / _redirect, and they keep its rules:
//
//   * a text-ish body between 1400 and 4 000 000 bytes is gzipped at level 1
//     (fastest) - below one packet compression is a net loss, and above the
//     ceiling we refuse to hold the copy in RAM;
//   * JSON goes out compact, no spaces after ":" or ",";
//   * HEAD sends the headers and no body.
//
// java: net/http gives us the last point for free. Writes to the ResponseWriter
// of a HEAD request are discarded by the server, so no route has to ask "was
// this a HEAD?" the way BaseHTTPRequestHandler does.

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// The gzip tier-2 bounds, copied from handler.py so behaviour matches.
const (
	gzMin   = 1400      // below ~one packet, compressing is a net loss
	gzMax   = 4_000_000 // never hold more than this in RAM to compress it
	gzLevel = gzip.BestSpeed
)

// maxBody caps a request body, like handler.py's MAX_BODY.
const maxBody = 1 << 20 // 1 MiB

// gzTypes are the content types worth compressing.
//
// java: `[]string{...}` is a SLICE literal - a growable view over an array,
// which is what Go uses where Java uses List. `var` at package level with no
// mutation after init is as close as this code gets to `static final`.
var gzTypes = []string{
	"text/",
	"application/json",
	"application/javascript",
	"application/manifest+json",
	"image/svg+xml",
}

// compressible reports whether a Content-Type is worth gzipping.
func compressible(ctype string) bool {
	for _, prefix := range gzTypes {
		if strings.HasPrefix(ctype, prefix) {
			return true
		}
	}
	return false
}

// acceptsGzip is the same loose check handler.py makes: we do not parse q-values.
func acceptsGzip(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
}

// sendBytes writes one complete response, gzipping it when that is worthwhile.
//
// java: HEADERS BEFORE STATUS BEFORE BODY, always, and in that order.
// w.Header().Set(...) after w.WriteHeader(...) is silently ignored - the
// headers are already on the wire. This is the single easiest mistake to make
// in net/http, so the order below is deliberate everywhere in this package.
func sendBytes(w http.ResponseWriter, r *http.Request, status int, ctype string, body []byte) {
	if acceptsGzip(r) && len(body) >= gzMin && len(body) <= gzMax && compressible(ctype) {
		if packed, err := gzipBytes(body); err == nil {
			body = packed
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Accept-Encoding")
		}
	}

	w.Header().Set("Content-Type", ctype)
	// java: strconv.Itoa is Integer.toString. Setting Content-Length ourselves
	// keeps the connection re-usable; without it net/http may fall back to
	// chunked encoding for larger bodies.
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)

	// java: we deliberately ignore the write error. The only realistic cause is
	// the client hanging up mid-response (Python's BrokenPipeError), there is
	// nothing left to tell them, and net/http has already logged it.
	_, _ = w.Write(body)
}

// sendJSON marshals `payload` compactly and sends it.
//
// java: json.Marshal escapes <, > and & into their \u00XX forms by default - a
// defence for JSON pasted straight into HTML, which nothing here does, and it
// would make byte-for-byte comparison with Python's output pointlessly noisy.
// An Encoder with SetEscapeHTML(false) turns it off. Encoder also appends a
// "\n", which we trim so the bytes match json.dumps().
func sendJSON(w http.ResponseWriter, r *http.Request, status int, payload any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)

	if err := enc.Encode(payload); err != nil {
		// Encoding our own reply failed: that is a bug, not a client problem.
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	body := bytes.TrimRight(buf.Bytes(), "\n")
	sendBytes(w, r, status, "application/json; charset=utf-8", body)
}

// sendError is the shape every failing API route returns: {"error": "..."}.
//
// java: `map[string]string{...}` is a map literal - HashMap<String,String>.
// For a one-off payload like this it beats declaring a struct.
func sendError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	sendJSON(w, r, status, map[string]string{"error": msg})
}

// sendText sends plain UTF-8 text.
func sendText(w http.ResponseWriter, r *http.Request, status int, text string) {
	sendBytes(w, r, status, "text/plain; charset=utf-8", []byte(text))
}

// redirect sends a Location and no body. 302 unless told otherwise.
func redirect(w http.ResponseWriter, status int, location string) {
	w.Header().Set("Location", location)
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(status)
}

// readJSON parses a request body into `dst`, refusing anything over maxBody.
//
// java: `dst any` is Object - Go's empty interface, satisfied by every type.
// Callers pass a POINTER to the struct they want filled: readJSON(r, &creds).
//
// java: http.MaxBytesReader is the guard that matters. Without it a client can
// stream gigabytes into json.Decoder and the process grows until it dies. It
// caps the read at the socket, so a 10 GiB upload costs us 1 MiB and an error.
func readJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	if r.Body == nil {
		return errors.New("empty body")
	}
	if err := refuseOversizedBody(w, r); err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)

	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		return err
	}
	// Refuse trailing junk after the first JSON value - two documents in one
	// body is always a bug or an attack, never a browser.
	if err := dec.Decode(new(struct{})); err != io.EOF {
		return errors.New("body must hold exactly one JSON object")
	}
	return nil
}

// errBodyTooLarge is what readJSON returns for a body over maxBody, so the
// caller can answer 413 rather than folding it into "bad JSON".
var errBodyTooLarge = errors.New("request body too large")

// refuseOversizedBody reports a body the caller must not read.
//
// handler.py sizes the body from Content-Length ALONE and answers 413 without
// reading a byte, so a declared length over the cap is refused even when the
// client then sends nothing. Checking r.ContentLength here reproduces that
// exactly; MaxBytesReader stays as the backstop for a body with no declared
// length, or one that lies about it.
//
// The Python also drops the connection, because the unread body would otherwise
// be parsed as the start of the next request on a kept-alive socket. Go does
// not have that hazard, but the header keeps the two servers' answers identical.
func refuseOversizedBody(w http.ResponseWriter, r *http.Request) error {
	if r.ContentLength > maxBody {
		w.Header().Set("Connection", "close")
		return errBodyTooLarge
	}
	return nil
}

// sendBodyError answers a failed readJSON. It exists so that no route has to
// remember the 413 case: 1 MiB of JSON is "petición demasiado grande", anything
// else is "bad JSON".
//
// java: errors.Is walks the wrapped-error chain - the equivalent of testing the
// cause chain of an exception, not `instanceof` on the outermost one. A
// MaxBytesError comes back from ReadAll wrapped, so a bare == would miss it.
func sendBodyError(w http.ResponseWriter, r *http.Request, err error) {
	var tooBig *http.MaxBytesError
	if errors.Is(err, errBodyTooLarge) || errors.As(err, &tooBig) {
		sendError(w, r, http.StatusRequestEntityTooLarge, "petición demasiado grande")
		return
	}
	sendError(w, r, http.StatusBadRequest, "bad JSON")
}

// gzipBytes compresses in memory at the fastest level.
//
// java: `defer zw.Close()` would be WRONG here. gzip.Writer only flushes its
// trailer on Close, and defer runs after the return statement has already read
// buf - so we would return a truncated stream. Close explicitly, then read.
func gzipBytes(raw []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzLevel)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(raw); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// readJSONKeepingRaw is readJSON plus the raw key set, for a handler that must
// tell an ABSENT field from one explicitly sent as null.
//
// java: encoding/json cannot express that difference on its own - both leave a
// pointer field nil - so the body is decoded twice: once into the struct, once
// into a map of raw values whose KEYS answer "was it present?". The admin panel
// needs it: "quota" absent means "leave the quota alone", "quota": null means
// "remove it".
func readJSONKeepingRaw(w http.ResponseWriter, r *http.Request, dst any,
	raw *map[string]json.RawMessage) error {

	if err := refuseOversizedBody(w, r); err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	if len(body) == 0 {
		body = []byte("{}")
	}
	if err := json.Unmarshal(body, dst); err != nil {
		return err
	}
	return json.Unmarshal(body, raw)
}
