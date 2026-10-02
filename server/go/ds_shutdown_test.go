package main

// Data-safety seal (cleanup Phase 3, batch S1): a stop waits for the requests
// still running (K6).

import (
	"context"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// TestDS_K6_StartWaitsForShutdown: Start must not return - main exits right
// after it - while a request is still being served; once that request ends,
// it returns.
func TestDS_K6_StartWaitsForShutdown(t *testing.T) {
	_, cfg, _ := newTestUsers(t)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	cfg.Server.Port = port
	srv, err := NewServer(cfg, quietLog())
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- srv.Start(ctx) }()

	var conn net.Conn
	deadline := time.Now().Add(5 * time.Second)
	for conn == nil && time.Now().Before(deadline) {
		conn, _ = net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if conn == nil {
			time.Sleep(10 * time.Millisecond) // polling for the listener to come up
		}
	}
	if conn == nil {
		t.Fatal("the server never listened")
	}
	defer conn.Close()

	// A request in flight: its body is still arriving.
	body := `{"user":"ana","password":"abc"}`
	fmt.Fprintf(conn, "POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s",
		len(body), body[:8])
	// Wait until the server has the request (its handler is reading the body):
	// a fixed pause, as nothing observable marks that moment from outside.
	time.Sleep(200 * time.Millisecond)

	cancel()
	// Start must still be waiting: the grace is 10 s, and the request runs.
	// A bounded wait proves a negative; before the fix it returned in µs.
	select {
	case err := <-done:
		t.Fatalf("Start returned (%v) with a request still running", err)
	case <-time.After(500 * time.Millisecond):
	}

	// The rest of the body: the request ends, answered.
	fmt.Fprint(conn, body[8:])
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 64)
	n, _ := conn.Read(buf)
	if !strings.HasPrefix(string(buf[:n]), "HTTP/1.1 ") {
		t.Errorf("the request in flight got no answer: %q", buf[:n])
	}
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Start = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Error("Start did not return after the last request ended")
	}
}

// TestDS_K6_LoopsWaited: main's background loops are waited for on the way
// out - up to the grace, never for ever.
func TestDS_K6_LoopsWaited(t *testing.T) {
	var loops backgroundLoops
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan struct{})
	loops.Go(ctx, func(ctx context.Context) {
		<-ctx.Done()
		time.Sleep(50 * time.Millisecond) // a write still in progress
		close(finished)
	})
	cancel()
	if !loops.Wait(5 * time.Second) {
		t.Fatal("Wait gave up on a loop that ends")
	}
	select {
	case <-finished:
	default:
		t.Error("Wait returned before the loop had finished")
	}

	var stuck backgroundLoops
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	stuck.Go(context.Background(), func(context.Context) { <-release })
	if stuck.Wait(50 * time.Millisecond) {
		t.Error("Wait claims a loop that never ends has finished")
	}
}
