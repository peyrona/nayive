package main

// Bugs audit 2 (cleanup Phase 5, batch F3): the culture lockers' proxy.

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// TestBug_SS5_CultureQueueCapped: one user asking thousands of distinct URLs
// and hanging up piled up one waiting fetch each, without end - every
// locker got nothing meanwhile. Past cuUserMax fetches of one user, or
// cuRunMax of all, a new URL is refused at once (503), and nothing more
// waits; a URL already in flight is still shared.
func TestBug_SS5_CultureQueueCapped(t *testing.T) {
	bmSetFor(t, &cuRunMax, 6)
	bmSetFor(t, &cuUserMax, 4)
	release := make(chan struct{})
	cuFake(t, func(string) (string, []byte, error) {
		<-release
		return "json", []byte(`{}`), nil
	})
	t.Cleanup(func() {
		close(release)
		for i := 0; i < 200; i++ { // the fetches end, for the next test
			cuMu.Lock()
			left := len(cuRunning)
			cuMu.Unlock()
			if left == 0 {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
	running := func() int {
		cuMu.Lock()
		defer cuMu.Unlock()
		return len(cuRunning)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the asker hangs up at once; the fetch stays in flight
	u := func(who string, i int) string {
		return "https://en.wikipedia.org/wiki/" + who + "?n=" + strconv.Itoa(i)
	}
	for i := 0; i < 4; i++ {
		cuShared(ctx, "ana", u("ana", i))
	}
	if _, _, err := cuShared(ctx, "ana", u("ana", 99)); !errors.Is(err, errCuBusy) {
		t.Fatalf("ana's fetch past her cap: %v, want busy", err)
	}
	if _, _, err := cuShared(ctx, "ana", u("ana", 0)); errors.Is(err, errCuBusy) {
		t.Fatal("a URL already in flight refused")
	}
	for i := 0; i < 2; i++ {
		if _, _, err := cuShared(ctx, "bob", u("bob", i)); errors.Is(err, errCuBusy) {
			t.Fatalf("bob refused while ana holds her cap: %v", err)
		}
	}
	if _, _, err := cuShared(ctx, "bob", u("bob", 99)); !errors.Is(err, errCuBusy) {
		t.Fatalf("fetch past the total cap: %v, want busy", err)
	}
	if n := running(); n != 6 {
		t.Fatalf("%d fetches in flight, want 6", n)
	}

	// over HTTP: 503, and no fetch started
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	if code, _ := bmGet(t, client, cuURL(ts.URL, "https://en.wikipedia.org/wiki/Y", 600)); code != http.StatusServiceUnavailable {
		t.Errorf("past the cap over HTTP: %d, want 503", code)
	}
	if n := running(); n != 6 {
		t.Errorf("%d fetches in flight after the 503, want 6", n)
	}
}
