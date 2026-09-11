package main

// =============================================================================
// limitListener - a hard ceiling on connections being served at once.
// =============================================================================
//
// server.py caps worker threads with a BoundedSemaphore and DROPS a connection
// that arrives with every slot taken, rather than queueing it. Same rule here,
// and the same number: far above anything this handful of users produces (a
// browser opens ~6 sockets; the service-worker precache is ~60 sequential
// fetches over those), low enough that a flood of slow clients cannot spawn
// thousands of goroutines.
//
// java: WHAT WE NO LONGER NEED. server.py has a long comment about not running
// the TLS handshake on the accept loop, because one stalled client would wedge
// the whole server. net/http accepts a connection and immediately hands it to
// its own goroutine, handshake included, so that failure mode does not exist in
// Go. This file is only the connection cap.

import (
	"net"
	"sync"
)

// maxConcurrent is the ceiling. Over it, new connections are closed at once.
const maxConcurrent = 250

// limitListener wraps a net.Listener and refuses to hold more than N live
// connections.
//
// java: net.Listener is an INTERFACE (Accept/Close/Addr). Go interfaces are
// satisfied IMPLICITLY - there is no `implements` clause. Any type with those
// three methods IS a net.Listener, which is why we can slot this wrapper
// underneath http.Server without it knowing anything about us. That is the
// decorator pattern with no ceremony.
type limitListener struct {
	net.Listener
	// java: EMBEDDING. Writing the interface as a nameless field means every
	// method we do not define ourselves (Close, Addr) is forwarded to it
	// automatically. It is the closest thing Go has to `extends`, and it is
	// composition: the wrapped value is a field, not a superclass.

	slots chan struct{} // a buffered channel used as a counting semaphore
	// java: a channel is a BlockingQueue. `struct{}` is a zero-byte type, so
	// this queue of 250 of them costs nothing - only the count matters.
}

// newLimitListener wraps `inner`.
func newLimitListener(inner net.Listener, limit int) net.Listener {
	return &limitListener{
		Listener: inner,
		slots:    make(chan struct{}, limit),
	}
}

// Accept takes a slot, then a connection.
//
// java: the `select` with a `default` branch is a NON-BLOCKING send - it takes
// a slot if one is free and falls through instantly if not, the same as
// Python's acquire(blocking=False). Without the default branch it would block
// until a slot freed up, which is exactly the accept-loop stall server.py
// warns about.
func (l *limitListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}

	select {
	case l.slots <- struct{}{}:
		// Got a slot. Hand back a connection that returns it on Close.
		return &limitConn{Conn: conn, release: l.slots}, nil
	default:
		// Full: drop this client instead of queueing it.
		conn.Close()
		// java: returning the NEXT Accept keeps http.Server's loop going. It is
		// a tail call in effect; Go does not optimise those away, but a flood
		// deep enough to matter would have to arrive between two instructions.
		return l.Accept()
	}
}

// limitConn returns its slot exactly once, when the connection closes.
type limitConn struct {
	net.Conn
	release chan struct{}
	once    sync.Once
}

// Close releases the slot.
//
// java: net/http may call Close more than once on the same connection, and NOT
// always from the same goroutine - Shutdown closes idle connections from the
// shutdown goroutine while the one serving that connection is closing it too.
// Releasing twice would hand back a slot we never took and the cap would drift
// upward until it meant nothing; Python catches that with BoundedSemaphore
// raising on an over-release.
//
// java: sync.Once is the fix, and it is AtomicBoolean.compareAndSet wrapped in
// a nicer shape: whichever goroutine gets there first runs the function, the
// others block until it has finished and then carry on. A plain bool here would
// be a real data race - the sort `go test -race` exists to find.
func (c *limitConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() {
		<-c.release // take one out of the queue = free a slot
	})
	return err
}
