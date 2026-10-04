package main

// =============================================================================
// Bugs audit 2: a phone's wait survives its row changing owner (SF1 + AN2).
// =============================================================================

import (
	"net/http"
	"testing"
	"time"
)

// parkWait opens the phone's long poll in the background and answers its
// status code on the channel.
func parkWait(base, v string) chan int {
	done := make(chan int, 1)
	go func() {
		req, _ := http.NewRequest("GET", base+"/api/device/wait?v="+v, nil)
		req.Header.Set(deviceHeader, phoneToken)
		resp, err := anonymous().Do(req)
		if err != nil {
			done <- 0
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()
	return done
}

// waitCode fails unless the parked wait answers `want` within 5 s.
func waitCode(t *testing.T, done chan int, want int, what string) {
	t.Helper()
	select {
	case code := <-done:
		if code != want {
			t.Fatalf("%s: the parked wait answered %d, want %d", what, code, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("%s: the wait never answered", what)
	}
}

// TestBug_SF1_RenameKeepsPhoneLinked: an admin rename moves the phone's row to
// the new name; the wait that was open must not answer 401 ("revoked"), which
// makes the app throw its token away.
func TestBug_SF1_RenameKeepsPhoneLinked(t *testing.T) {
	shortHold(t)
	deviceHold = 1500 * time.Millisecond
	srv, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	enrolPhone(t, client, base)
	st := phoneWait(t, base, phoneToken, "")

	done := parkWait(base, st.V)
	time.Sleep(150 * time.Millisecond)
	srv.devices.RenameUser("ana", "anabel")
	waitCode(t, done, http.StatusOK, "rename")

	if code, raw := phone(t, base, "GET", "/api/device/wait", phoneToken, ""); code != http.StatusOK {
		t.Fatalf("the next wait = %d %s, want 200", code, raw)
	}
}

// TestBug_AN2_OtherAccountKeepsPhoneLinked: signing in to another account in
// the app moves the same token to it; the open wait must not drop it.
func TestBug_AN2_OtherAccountKeepsPhoneLinked(t *testing.T) {
	shortHold(t)
	deviceHold = 1500 * time.Millisecond
	_, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	enrolPhone(t, client, base)
	st := phoneWait(t, base, phoneToken, "")

	done := parkWait(base, st.V)
	time.Sleep(150 * time.Millisecond)
	beto := signedInClient(t, base, "beto", "xyz")
	enrolPhone(t, beto, base)
	waitCode(t, done, http.StatusOK, "enrol as beto")
}

// TestBug_SF1_RevokeStill401: a phone really removed is still told so.
func TestBug_SF1_RevokeStill401(t *testing.T) {
	shortHold(t)
	srv, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	enrolPhone(t, client, base)
	st := phoneWait(t, base, phoneToken, "")

	done := parkWait(base, st.V)
	time.Sleep(150 * time.Millisecond)
	srv.devices.DropUser("ana")
	waitCode(t, done, http.StatusUnauthorized, "removed")
}
