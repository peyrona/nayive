package main

// =============================================================================
// limitListener under a flood (audit #15).
// =============================================================================

import (
	"errors"
	"net"
	"runtime"
	"testing"
)

// floodListener hands out `left` connections, then fails. It records the
// deepest call stack Accept was ever called from.
type floodListener struct {
	left  int
	depth int
}

func (f *floodListener) Accept() (net.Conn, error) {
	pcs := make([]uintptr, 8192)
	if d := runtime.Callers(0, pcs); d > f.depth {
		f.depth = d
	}
	if f.left == 0 {
		return nil, errors.New("no more")
	}
	f.left--
	a, b := net.Pipe()
	b.Close()
	return a, nil
}

func (f *floodListener) Close() error   { return nil }
func (f *floodListener) Addr() net.Addr { return nil }

// TestLimitListenerFloodKeepsStackFlat: while every slot is taken, each refused
// connection must not add a stack frame - a flood would otherwise grow the
// stack until the runtime aborts the whole server.
func TestLimitListenerFloodKeepsStackFlat(t *testing.T) {
	inner := &floodListener{left: 1}
	l := newLimitListener(inner, 1)

	held, err := l.Accept() // takes the only slot
	if err != nil {
		t.Fatalf("first Accept: %v", err)
	}
	base := inner.depth

	inner.left = 2000 // all refused: the slot is full
	if _, err := l.Accept(); err == nil {
		t.Fatal("Accept after the flood should return the listener's error")
	}
	if grew := inner.depth - base; grew > 8 {
		t.Fatalf("stack grew by %d frames over 2000 refused connections", grew)
	}

	// The slot comes back when the held connection closes.
	held.Close()
	inner.left = 1
	if c, err := l.Accept(); err != nil {
		t.Fatalf("Accept after a slot freed: %v", err)
	} else {
		c.Close()
	}
}
