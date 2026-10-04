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
// locker got nothing meanwhile. Past cuRunMax fetches in flight a new URL
// is refused at once (503), and nothing more waits.
func TestBug_SS5_CultureQueueCapped(t *testing.T) {
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

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the asker hangs up at once; the fetch stays in flight
	for i := 0; i < cuRunMax; i++ {
		cuShared(ctx, "https://en.wikipedia.org/wiki/X?n="+strconv.Itoa(i))
	}
	if _, _, err := cuShared(ctx, "https://en.wikipedia.org/wiki/X?n=more"); !errors.Is(err, errCuBusy) {
		t.Fatalf("fetch past the cap: %v, want busy", err)
	}
	cuMu.Lock()
	running := len(cuRunning)
	cuMu.Unlock()
	if running != cuRunMax {
		t.Fatalf("%d fetches in flight, want %d", running, cuRunMax)
	}

	// over HTTP: 503, and no fetch started
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	if code, _ := bmGet(t, client, cuURL(ts.URL, "https://en.wikipedia.org/wiki/Y", 600)); code != http.StatusServiceUnavailable {
		t.Errorf("past the cap over HTTP: %d, want 503", code)
	}
}
