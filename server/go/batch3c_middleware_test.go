package main

import (
	"io"
	"net"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// TestBodyAllowanceBounded: the deadline a declared length buys. A login's
// largest body (maxBody) gets about a minute and a half, not the ~17 minutes
// that let a few hundred dribbling clients hold every slot; a big upload still
// gets time for a slow line.
func TestBodyAllowanceBounded(t *testing.T) {
	if got := bodyAllowance(maxBody); got > bodyReadBase+100*time.Second {
		t.Errorf("bodyAllowance(1 MiB) = %v, want at most %v", got, bodyReadBase+100*time.Second)
	}
	gib := int64(1 << 30)
	if got, want := bodyAllowance(gib), time.Duration(gib/(16<<10))*time.Second; got < want {
		t.Errorf("bodyAllowance(1 GiB) = %v, want at least %v", got, want)
	}
	if got := bodyAllowance(-1); got != bodyReadBase {
		t.Errorf("bodyAllowance(unknown) = %v, want the base %v", got, bodyReadBase)
	}
}

// TestSlowBigLoginBodyIsCut: the reviewer's attack on the wire - a login that
// declares a long body and dribbles it. At 1 KiB/s its 48 KiB bought 48 s; at
// the rate now asked for it is cut after about 3.
func TestSlowBigLoginBodyIsCut(t *testing.T) {
	shortBodyDeadline(t, 300*time.Millisecond)
	srv, _, _ := newTestServer(t)
	ts := httptest.NewServer(srv.httpd.Handler)
	t.Cleanup(ts.Close)

	conn, err := net.Dial("tcp", ts.Listener.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	io.WriteString(conn, "POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"+
		"Content-Length: "+strconv.Itoa(48<<10)+"\r\n\r\n{\"user\":")

	started := time.Now()
	for time.Since(started) < 10*time.Second {
		time.Sleep(500 * time.Millisecond)
		if _, err := io.WriteString(conn, " "); err != nil {
			break // the server hung up
		}
		conn.SetReadDeadline(time.Now().Add(10 * time.Millisecond))
		if _, err := conn.Read(make([]byte, 1)); err != nil {
			if ne, ok := err.(net.Error); !ok || !ne.Timeout() {
				break // closed, or answered and closing
			}
		} else {
			break
		}
	}
	if held := time.Since(started); held > 6*time.Second {
		t.Fatalf("the server held a dribbling 48 KiB body for %v", held)
	}
}
