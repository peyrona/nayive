package main

// =============================================================================
// limitListener: one address cannot take every slot (#14, the review).
// =============================================================================

import (
	"errors"
	"net"
	"testing"
)

// addrConn is a connection from a chosen remote address.
type addrConn struct {
	net.Conn
	remote net.Addr
}

func (c addrConn) RemoteAddr() net.Addr { return c.remote }

// queueListener hands out connections from the addresses queued in `from`,
// then fails.
type queueListener struct {
	from   []string
	closed int // connections it handed out that were closed by the listener
}

func (q *queueListener) Accept() (net.Conn, error) {
	if len(q.from) == 0 {
		return nil, errors.New("no more")
	}
	addr, _ := net.ResolveTCPAddr("tcp", q.from[0])
	q.from = q.from[1:]
	a, b := net.Pipe()
	b.Close()
	return addrConn{Conn: a, remote: addr}, nil
}

func (q *queueListener) Close() error   { return nil }
func (q *queueListener) Addr() net.Addr { return nil }

// fill accepts n connections from `from` and fails the test if any is refused.
func fill(t *testing.T, l net.Listener, q *queueListener, from string, n int) []net.Conn {
	t.Helper()
	var held []net.Conn
	for i := 0; i < n; i++ {
		q.from = []string{from}
		c, err := l.Accept()
		if err != nil {
			t.Fatalf("connection %d from %s refused", i+1, from)
		}
		held = append(held, c)
	}
	return held
}

// TestLimitListenerPerAddress: one address gets a quarter of the slots, and
// the rest stay free for everyone else; an IPv6 client's whole /64 is one
// address; this machine itself is not capped; a closed connection gives its
// slot back.
func TestLimitListenerPerAddress(t *testing.T) {
	q := &queueListener{}
	l := newLimitListener(q, 20) // 5 per address
	per := 20 / 4

	held := fill(t, l, q, "203.0.113.5:1000", per)
	q.from = []string{"203.0.113.5:1001"}
	if _, err := l.Accept(); err == nil {
		t.Fatal("one address took more than its share")
	}
	other := fill(t, l, q, "198.51.100.7:1000", 1)

	// An IPv6 /64 is one address.
	six := fill(t, l, q, "[2001:db8:1:2::1]:1000", per-1)
	q.from = []string{"[2001:db8:1:2:ffff::9]:1000"}
	c, err := l.Accept()
	if err != nil {
		t.Fatal("the /64's last share was refused")
	}
	six = append(six, c)
	q.from = []string{"[2001:db8:1:2:abcd::5]:1000"}
	if _, err := l.Accept(); err == nil {
		t.Fatal("a /64 took more than its share")
	}

	// A freed slot comes back to its address.
	held[0].Close()
	held = append(held[1:], fill(t, l, q, "203.0.113.5:1002", 1)...)

	// Loopback is only held by the global cap.
	for _, c := range append(append(held, other...), six...) {
		c.Close()
	}
	local := fill(t, l, q, "127.0.0.1:1000", 20)
	q.from = []string{"127.0.0.1:1000"}
	if _, err := l.Accept(); err == nil {
		t.Fatal("the global cap no longer holds")
	}
	for _, c := range local {
		c.Close()
	}
	fill(t, l, q, "203.0.113.5:1003", per) // everything came back
}
