package main

// =============================================================================
// The request log keeps secrets out (audit #24); a slow body cannot hold a
// connection forever, while a long-poll still can (audit #14).
// =============================================================================

import (
	"bytes"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// lockedBuffer is a bytes.Buffer the server's goroutines and the test may use
// at once.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestRequestLogRedactsTokens: the DEBUG line of a chat link, a public trip
// link or a location URL must not carry the token that opens it.
func TestRequestLogRedactsTokens(t *testing.T) {
	_, cfg, _ := newTestUsers(t)
	var out lockedBuffer
	log := slog.New(slog.NewTextHandler(&out, &slog.HandlerOptions{Level: slog.LevelDebug}))
	srv, err := NewServer(cfg, log)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	t.Cleanup(func() { srv.Close() })
	ts := httptest.NewServer(srv.routes())
	t.Cleanup(ts.Close)

	paths := []string{
		"/s/SECRETs1",
		"/c/SECRETc1",
		"/c/SECRETc2/index.html",
		"/api/c/SECRETc3",
		"/api/c/SECRETc4/wait",
		"/api/public/SECRETp1",
		"/api/public/SECRETp2/photo/a.jpg",
		"/api/location/SECRETl1/overland",
	}
	for _, p := range paths {
		resp, err := http.Get(ts.URL + p)
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}

	logged := out.String()
	if strings.Contains(logged, "SECRET") {
		t.Fatalf("a token reached the log:\n%s", logged)
	}
	// ...but the line is still there, and still says what kind of URL it was.
	for _, want := range []string{"path=/s/", "path=/api/location/", "/overland"} {
		if !strings.Contains(logged, want) {
			t.Errorf("log lacks %q:\n%s", want, logged)
		}
	}
}

// TestRedactPath pins the exact shapes.
func TestRedactPath(t *testing.T) {
	for in, want := range map[string]string{
		"/":                          "/",
		"/nayive/drive/":             "/nayive/drive/",
		"/s/abc":                     "/s/-",
		"/c/abc/":                    "/c/-/",
		"/c/abc/app.js":              "/c/-/app.js",
		"/api/c/abc/wait":            "/api/c/-/wait",
		"/api/public/abc/photo/x":    "/api/public/-/photo/x",
		"/api/location/abc/gpslog":   "/api/location/-/gpslog",
		"/api/location":              "/api/location",
		"/api/files":                 "/api/files",
		"/api/chat/via/ana/messages": "/api/chat/via/ana/messages",
	} {
		if got := redactPath(in); got != want {
			t.Errorf("redactPath(%q) = %q, want %q", in, got, want)
		}
	}
}

// shortBodyDeadline shrinks the body read deadline for one test.
func shortBodyDeadline(t *testing.T, d time.Duration) {
	t.Helper()
	old := bodyReadBase
	bodyReadBase = d
	t.Cleanup(func() { bodyReadBase = old })
}

// TestSlowLoginBodyIsCut: a client that sends the headers of a POST
// /api/login and then dribbles its body must lose the connection once the body
// deadline passes - not hold one of the 250 slots for as long as it likes.
func TestSlowLoginBodyIsCut(t *testing.T) {
	shortBodyDeadline(t, 300*time.Millisecond)
	srv, _, _ := newTestServer(t)
	ts := httptest.NewServer(srv.httpd.Handler)
	t.Cleanup(ts.Close)

	// The whole-request timeouts stay off (they would cut long-polls and big
	// transfers); the header and idle ones stay on.
	h := srv.httpd
	if h.ReadTimeout != 0 || h.WriteTimeout != 0 || h.ReadHeaderTimeout == 0 || h.IdleTimeout == 0 {
		t.Fatalf("server timeouts: read %v write %v header %v idle %v",
			h.ReadTimeout, h.WriteTimeout, h.ReadHeaderTimeout, h.IdleTimeout)
	}

	conn, err := net.Dial("tcp", ts.Listener.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	io.WriteString(conn, "POST /api/login HTTP/1.1\r\nHost: x\r\n"+
		"Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"user\":")

	// The server must give up well before the client does.
	started := time.Now()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	io.Copy(io.Discard, conn) // returns when the server closes, or at 5 s
	if waited := time.Since(started); waited > 3*time.Second {
		t.Fatalf("the server held a dribbling body for %v", waited)
	}
}

// TestLongPollSurvivesBodyDeadline: the deadline covers READING the body, never
// the wait after it. A POST that sent its body and a GET with none must both be
// able to wait far past the deadline and still answer.
func TestLongPollSurvivesBodyDeadline(t *testing.T) {
	shortBodyDeadline(t, 200*time.Millisecond)

	wait := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		select {
		case <-time.After(1 * time.Second): // 5x the deadline
			w.Write([]byte("still here"))
		case <-r.Context().Done():
			// The request was cancelled under us: the client sees no answer.
			panic(http.ErrAbortHandler)
		}
	})
	ts := httptest.NewServer(bodyDeadline(wait))
	t.Cleanup(ts.Close)

	for _, c := range []struct {
		method string
		body   io.Reader
	}{
		{"POST", strings.NewReader(`{"since":1}`)},
		{"GET", nil},
	} {
		req, _ := http.NewRequest(c.method, ts.URL, c.body)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s long-poll: %v", c.method, err)
		}
		got, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(got) != "still here" {
			t.Fatalf("%s long-poll answered %q", c.method, got)
		}
	}
}
