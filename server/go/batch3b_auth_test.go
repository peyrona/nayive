package main

// =============================================================================
// The sign-in throttle is per name and per address (audit #18); sign-out is
// POST only (audit #54).
// =============================================================================

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// loginFrom posts a sign-in straight into the handler chain, from `ip` - an
// httptest client always comes from 127.0.0.1.
func loginFrom(h http.Handler, user, password, ip string) int {
	req := httptest.NewRequest("POST", "/api/login",
		strings.NewReader(`{"user":"`+user+`","password":"`+password+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = ip + ":40000"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

// guessAll runs one wrong sign-in per (name, ip) pair at once and reports how
// long the whole batch took.
func guessAll(h http.Handler, pairs [][2]string) time.Duration {
	started := time.Now()
	var wg sync.WaitGroup
	for _, p := range pairs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			loginFrom(h, p[0], "wrong", p[1])
		}()
	}
	wg.Wait()
	return time.Since(started)
}

// TestWrongGuessesDoNotQueueOthers: someone hammering "beto" from five
// addresses must not make "ana", signing in from her own, wait behind them.
func TestWrongGuessesDoNotQueueOthers(t *testing.T) {
	srv, _, _ := newTestServer(t)
	h := srv.routes()

	done := make(chan time.Duration)
	go func() {
		done <- guessAll(h, [][2]string{
			{"beto", "10.0.0.1"}, {"beto", "10.0.0.2"}, {"beto", "10.0.0.3"},
			{"beto", "10.0.0.4"}, {"beto", "10.0.0.5"},
		})
	}()
	time.Sleep(50 * time.Millisecond) // the guesses are in, one holding the lock

	started := time.Now()
	if code := loginFrom(h, "ana", "abc", "10.0.0.9"); code != http.StatusOK {
		t.Fatalf("ana's sign-in = %d, want 200", code)
	}
	if waited := time.Since(started); waited > authFailDelay/2 {
		t.Errorf("ana waited %v behind somebody else's wrong guesses", waited)
	}

	// The guesses at ONE name still take their 0.4 s each, one after another,
	// however many addresses they come from.
	if took := <-done; took < 5*authFailDelay-50*time.Millisecond {
		t.Errorf("5 wrong guesses at one name took %v, want >= %v", took, 5*authFailDelay)
	}
}

// TestWrongGuessesFromOneAddressQueue: one address trying many names is
// throttled too.
func TestWrongGuessesFromOneAddressQueue(t *testing.T) {
	srv, _, _ := newTestServer(t)
	h := srv.routes()

	took := guessAll(h, [][2]string{
		{"uno", "10.0.0.1"}, {"dos", "10.0.0.1"}, {"tres", "10.0.0.1"},
	})
	if took < 3*authFailDelay-50*time.Millisecond {
		t.Errorf("3 wrong guesses from one address took %v, want >= %v", took, 3*authFailDelay)
	}
}

// TestKeyedMutexForgetsIdleKeys: the names are the attacker's to choose, so a
// key nobody holds must not stay in the map.
func TestKeyedMutexForgetsIdleKeys(t *testing.T) {
	var k keyedMutex
	for _, key := range []string{"a", "b", "a"} {
		k.Lock(key)()
	}
	if n := len(k.locks); n != 0 {
		t.Fatalf("%d idle keys kept", n)
	}
}

// TestLogoutIsPostOnly: a GET to /api/logout - a link, an <img> on another
// site - must leave the session alone; a POST ends it.
func TestLogoutIsPostOnly(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	resp := do(t, client, "GET", ts.URL+"/api/logout", nil, nil)
	resp.Body.Close()
	resp = do(t, client, "GET", ts.URL+"/api/whoami", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("after GET /api/logout, whoami = %d, want 200 (still signed in)", resp.StatusCode)
	}

	resp = do(t, client, "POST", ts.URL+"/api/logout", nil, nil)
	resp.Body.Close()
	resp = do(t, client, "GET", ts.URL+"/api/whoami", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("after POST /api/logout, whoami = %d, want 401", resp.StatusCode)
	}
}
