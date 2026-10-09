package main

// =============================================================================
// The phone at the ear (devices_ear.go): the page switches it, the phone's
// wait carries it, it ends by itself, and "app" says whether the phone can.
// =============================================================================

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

type earAnswer struct {
	OK  bool `json:"ok"`
	App bool `json:"app"`
}

// earWait is the phone's wait, saying whether it can do the ear.
func earWait(t *testing.T, base, v string, can bool) (string, bool) {
	t.Helper()
	q := "/api/device/wait?v=" + v
	if can {
		q += "&ear=1"
	}
	code, raw := phone(t, base, "GET", q, phoneToken, "")
	if code != http.StatusOK {
		t.Fatalf("wait = %d %s", code, raw)
	}
	var st struct {
		V   string `json:"v"`
		Ear bool   `json:"ear"`
	}
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatalf("wait JSON: %v %s", err, raw)
	}
	return st.V, st.Ear
}

func TestDeviceEar(t *testing.T) {
	shortHold(t)
	oldHeld, oldGap := earHeld, earGap
	t.Cleanup(func() { earHeld, earGap = oldHeld, oldGap })

	_, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	id := enrolPhone(t, client, base)

	// An APK that does not say ear=1 (an old one, or no sensor): the page
	// is told to put up its own padlock.
	v, ear := earWait(t, base, "", false)
	if ear {
		t.Fatal("ear on before anyone asked")
	}
	var a earAnswer
	jsonCall(t, client, "POST", base+"/api/device/"+id+"/ear", `{"on":true}`, 200, &a)
	if !a.OK || a.App {
		t.Fatalf("a phone that cannot = %+v, want app false", a)
	}
	jsonCall(t, client, "POST", base+"/api/device/"+id+"/ear", `{"on":false}`, 200, nil)

	// A phone that can, its wait open: "on" wakes the wait at once.
	v, _ = earWait(t, base, "", true)
	done := make(chan bool, 1)
	go func() {
		var got struct{ Ear bool }
		req, _ := http.NewRequest("GET", base+"/api/device/wait?ear=1&v="+v, nil)
		req.Header.Set(deviceHeader, phoneToken)
		if resp, err := anonymous().Do(req); err == nil {
			json.NewDecoder(resp.Body).Decode(&got)
			resp.Body.Close()
		}
		done <- got.Ear
	}()
	time.Sleep(150 * time.Millisecond)
	jsonCall(t, client, "POST", base+"/api/device/"+id+"/ear", `{"on":true}`, 200, &a)
	if !a.App {
		t.Fatalf("a phone that can, waiting = %+v, want app true", a)
	}
	select {
	case on := <-done:
		if !on {
			t.Fatal("the woken wait did not carry ear: true")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the wait did not wake for the ear")
	}

	// Off: the next wait says so.
	v, _ = earWait(t, base, "", true)
	jsonCall(t, client, "POST", base+"/api/device/"+id+"/ear", `{"on":false}`, 200, nil)
	if _, ear = earWait(t, base, v, true); ear {
		t.Fatal("ear still on after off")
	}

	// A page that dies mid-call: the "on" ends by itself, and the held wait
	// answers then, not at its hold.
	earHeld = 400 * time.Millisecond
	jsonCall(t, client, "POST", base+"/api/device/"+id+"/ear", `{"on":true}`, 200, nil)
	v, ear = earWait(t, base, "", true)
	if !ear {
		t.Fatal("ear not on")
	}
	start := time.Now()
	if _, ear = earWait(t, base, v, true); ear {
		t.Fatal("ear still on after earHeld")
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("the expiry was answered after %v", took)
	}

	// The phone stopped listening a while ago: the page does it itself.
	earGap = 0
	jsonCall(t, client, "POST", base+"/api/device/"+id+"/ear", `{"on":true}`, 200, &a)
	if a.App {
		t.Fatal("app true for a phone whose wait is closed")
	}

	// Only the owner's own phones; never with the wrong verb.
	jsonCall(t, client, "POST", base+"/api/device/nope/ear", `{"on":true}`, 404, nil)
	jsonCall(t, client, "GET", base+"/api/device/"+id+"/ear", "", 405, nil)
	resp := do(t, anonymous(), "POST", base+"/api/device/"+id+"/ear", nil, nil)
	if readBody(t, resp); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no session = %d", resp.StatusCode)
	}
}
