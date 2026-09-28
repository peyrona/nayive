package main

// Audit #14 (second half): a cap on the long-polls ONE credential holds open
// (waitcap.go).

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"
)

// waitHeld reports whether `key` still has an entry at all (0 must delete it).
func waitHeld(key string) bool {
	waits.mu.Lock()
	defer waits.mu.Unlock()
	_, ok := waits.open[key]
	return ok
}

// waitFor polls until cond is true, or fails the test.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

// openWaits starts n requests in the background; each sends its status (or
// -1 when the request was cancelled) to the returned channel.
func openWaits(ctx context.Context, n int, client *http.Client, url string, hdr map[string]string) chan int {
	done := make(chan int, n)
	for i := 0; i < n; i++ {
		go func() {
			req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
			for k, v := range hdr {
				req.Header.Set(k, v)
			}
			resp, err := client.Do(req)
			if err != nil {
				done <- -1
				return
			}
			resp.Body.Close()
			done <- resp.StatusCode
		}()
	}
	return done
}

// refusedFast: one more wait is answered 429 + Retry-After, at once.
func refusedFast(t *testing.T, client *http.Client, url string, hdr map[string]string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("extra wait: %v", err)
	}
	raw := readBody(t, resp)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("extra wait = %d, want 429: %s", resp.StatusCode, raw)
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 without Retry-After")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("the refusal took %v", d)
	}
}

// openChatWaits opens n Chat waits on `path` (".../wait") that all hold. The
// first one brings the participant online, which moves the version, so the
// rest ask with the version after that. It returns the channel of their
// answers and a URL one more wait would hold on.
func openChatWaits(t *testing.T, ctx context.Context, n int, client *http.Client, path, key string) (chan int, string) {
	t.Helper()
	version := func() int64 {
		resp := do(t, client, "GET", path+"?v=-1", nil, nil)
		var out struct {
			V int64 `json:"v"`
		}
		json.Unmarshal(readBody(t, resp), &out)
		return out.V
	}
	done := make(chan int, n)
	first := openWaits(ctx, 1, client, fmt.Sprintf("%s?v=%d", path, version()), nil)
	go func() { done <- <-first }()
	waitFor(t, "the first wait", func() bool { return waits.count(key) == 1 })
	url := fmt.Sprintf("%s?v=%d", path, version())
	rest := openWaits(ctx, n-1, client, url, nil)
	go func() {
		for i := 0; i < n-1; i++ {
			done <- <-rest
		}
	}()
	waitFor(t, "every wait", func() bool { return waits.count(key) == n })
	return done, url
}

func TestWaitCapCounter(t *testing.T) {
	c := newWaitCap(3)
	for i := 0; i < 3; i++ {
		if !c.acquire("a") {
			t.Fatalf("acquire %d refused", i)
		}
	}
	if c.acquire("a") {
		t.Fatal("4th acquire allowed")
	}
	if !c.acquire("b") {
		t.Fatal("another key refused")
	}
	for i := 0; i < 3; i++ {
		c.release("a")
	}
	c.release("b")
	if c.size() != 0 {
		t.Fatalf("%d keys left after every release", c.size())
	}
	if !c.acquire("a") {
		t.Fatal("key not usable again")
	}
}

// A person's link: cap waits hold, one more is refused at once, another link
// and the owner are untouched, and a client that goes away leaves nothing.
func TestWaitCapChatLink(t *testing.T) {
	f := newChatFixture(t)
	key := "chat-link:" + tokenKey(f.carmen)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done, url := openChatWaits(t, ctx, waitCapMax, anonymous(), f.base+"/api/c/"+f.carmen+"/wait", key)

	refusedFast(t, anonymous(), url, nil)
	if n := waits.count(key); n != waitCapMax {
		t.Fatalf("the refusal changed the count: %d", n)
	}

	// Javi's link and the owner still wait normally.
	other, cancelOther := context.WithCancel(context.Background())
	javiKey := "chat-link:" + tokenKey(f.javi)
	otherDone, _ := openChatWaits(t, other, 1, anonymous(), f.base+"/api/c/"+f.javi+"/wait", javiKey)
	ownerDone, _ := openChatWaits(t, other, 1, f.owner, f.base+"/api/chat/wait", ownerWaitKey(t, f, ""))
	cancelOther()
	<-otherDone
	<-ownerDone

	// Javi and the owner coming online woke Carmen's waits (the version
	// moved); each answered and gave its slot back.
	for i := 0; i < waitCapMax; i++ {
		<-done
	}
	waitFor(t, "no key left", func() bool { return waits.size() == 0 })

	// Every client hangs up mid-wait: nothing stays counted.
	ctx2, cancel2 := context.WithCancel(context.Background())
	done, _ = openChatWaits(t, ctx2, waitCapMax, anonymous(), f.base+"/api/c/"+f.carmen+"/wait", key)
	cancel2()
	for i := 0; i < waitCapMax; i++ {
		if st := <-done; st != -1 {
			t.Fatalf("a held wait answered %d before the hang-up", st)
		}
	}
	waitFor(t, "no key left", func() bool { return waits.size() == 0 })
	if waitHeld(key) || waitHeld(javiKey) {
		t.Fatal("an entry at 0 was kept")
	}

	// And the link works again.
	again, cancelAgain := context.WithCancel(context.Background())
	defer cancelAgain()
	openChatWaits(t, again, 1, anonymous(), f.base+"/api/c/"+f.carmen+"/wait", key)
	cancelAgain()
	waitFor(t, "released", func() bool { return !waitHeld(key) })
}

// ownerWaitKey is the key of the owner's waits on `home` ("" = their own).
func ownerWaitKey(t *testing.T, f *chatFixture, home string) string {
	t.Helper()
	u, _ := url.Parse(f.base)
	for _, c := range f.owner.Jar.Cookies(u) {
		if c.Name == CookieName {
			return "chat:" + tokenKey(c.Value) + ":" + home
		}
	}
	t.Fatal("no session cookie")
	return ""
}

// Waits that END (a change wakes them, then a shutdown) also give their slot
// back.
func TestWaitCapChatEnds(t *testing.T) {
	f := newChatFixture(t)
	key := ownerWaitKey(t, f, "")
	path := f.base + "/api/chat/wait"

	// A change: every wait answers 200.
	done, url := openChatWaits(t, context.Background(), waitCapMax, f.owner, path, key)
	refusedFast(t, f.owner, url, nil)
	f.call(t, f.owner, "PUT", "/api/chat/me", `{"name":"Ana Nueva"}`, 200, nil)
	for i := 0; i < waitCapMax; i++ {
		if st := <-done; st != 200 {
			t.Fatalf("woken wait = %d", st)
		}
	}
	waitFor(t, "no key left", func() bool { return waits.size() == 0 })

	// A shutdown: every wait answers, nothing stays counted.
	done, _ = openChatWaits(t, context.Background(), 3, f.owner, path, key)
	f.srv.chat.Close()
	for i := 0; i < 3; i++ {
		<-done
	}
	waitFor(t, "no key left", func() bool { return waits.size() == 0 })
}

// The phone: same cap on its token; another phone is not touched; a hold
// that runs out and a hang-up both give the slot back.
func TestWaitCapDevice(t *testing.T) {
	_, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	enrolPhone(t, client, base)
	v := phoneWait(t, base, phoneToken, "").V
	url := base + "/api/device/wait?v=" + v
	hdr := map[string]string{deviceHeader: phoneToken}
	key := "device:" + tokenHash(phoneToken)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := openWaits(ctx, waitCapMax, anonymous(), url, hdr)
	waitFor(t, "cap phone waits", func() bool { return waits.count(key) == waitCapMax })
	refusedFast(t, anonymous(), url, hdr)

	// The Android app reads a 429 as "try later", not as "not enrolled".
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set(deviceHeader, phoneToken)
	resp, err := anonymous().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, resp)
	if resp.StatusCode == http.StatusUnauthorized {
		t.Fatal("a refused wait must not look like a revoked phone")
	}

	cancel()
	for i := 0; i < waitCapMax; i++ {
		<-done
	}
	waitFor(t, "no key left", func() bool { return waits.size() == 0 })

	// A hold that runs out ends the wait and frees the slot.
	old := deviceHold
	deviceHold = 300 * time.Millisecond
	defer func() { deviceHold = old }()
	st := phoneWait(t, base, phoneToken, v)
	if st.V != v {
		t.Fatalf("the state moved: %q -> %q", v, st.V)
	}
	waitFor(t, "the timed-out wait's slot", func() bool { return waits.size() == 0 })
}
