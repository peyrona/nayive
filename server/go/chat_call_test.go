package main

// =============================================================================
// Chat calls (chat_call.go): ringing, answering, signals, endings, pushes.
// =============================================================================

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// newCallFixture: the chat fixture with coturn configured.
func newCallFixture(t *testing.T) *chatFixture {
	t.Helper()
	f := newChatFixture(t)
	f.srv.cfg.Read(func(c *ServerConfig) {
		c.TurnURIs = []string{"stun:turn.example:3478", "turn:turn.example:3478?transport=udp",
			"turn:turn.example:3478?transport=tcp"}
	})
	os.WriteFile(filepath.Join(f.srv.cfg.ConfigDir, "turn_secret"), []byte("s3cret\n"), 0o600)
	return f
}

type callWait struct {
	V     int64         `json:"v"`
	Calls []chatCallOut `json:"calls"`
	Sig   []struct {
		Seq  int64           `json:"seq"`
		Call string          `json:"call"`
		Data json.RawMessage `json:"data"`
	} `json:"sig"`
}

// wait is one long-poll that must answer at once (v=-1 always differs).
func (f *chatFixture) wait(t *testing.T, client *http.Client, prefix, dev string, s int64) callWait {
	t.Helper()
	var out callWait
	f.call(t, client, "GET", prefix+"/wait?v=-1&dev="+dev+"&s="+itoa(int(s)), "", 200, &out)
	return out
}

func (f *chatFixture) convMsgs(t *testing.T, client *http.Client, path string) []ChatMsg {
	t.Helper()
	var list struct {
		Msgs []ChatMsg `json:"msgs"`
	}
	f.call(t, client, "GET", path, "", 200, &list)
	return list.Msgs
}

// TestTurnPassword: coturn's use-auth-secret password, and the ICE list.
func TestTurnPassword(t *testing.T) {
	// python3: base64(hmac.new(b"s3cret", b"1700000000:nayive", sha1).digest())
	if got := turnPassword([]byte("s3cret"), "1700000000:nayive"); got != "3IXFNYgDYzhYiXo2hyu24pdoYm8=" {
		t.Fatalf("turnPassword = %q", got)
	}
	f := newCallFixture(t)
	ice := f.srv.chat.iceFor(time.Unix(1700000000-chatCallTurnTTL, 0))
	if len(ice) != 2 || ice[1]["username"] != "1700000000:nayive" || ice[1]["credential"] != "3IXFNYgDYzhYiXo2hyu24pdoYm8=" {
		t.Fatalf("ice = %v", ice)
	}
	if urls := ice[1]["urls"].([]string); len(urls) != 2 || ice[0]["username"] != nil {
		t.Fatalf("turn urls = %v, stun = %v", urls, ice[0])
	}
}

// TestChatCallFlow: the owner rings Carmen, she answers on one page, the offer
// and the answer cross, the owner hangs up, the chat keeps the bubble.
func TestChatCallFlow(t *testing.T) {
	f := newCallFixture(t)
	carmen := anonymous()
	conv := "d-" + f.ids["Carmen"]
	cp := "/api/c/" + f.carmen

	var sum struct {
		CallsOn bool `json:"callsOn"`
	}
	f.call(t, carmen, "GET", cp, "", 200, &sum)
	if !sum.CallsOn {
		t.Fatal("callsOn = false with coturn configured")
	}

	var start struct {
		ID  string           `json:"id"`
		Ice []map[string]any `json:"ice"`
	}
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/call", `{"video":true,"dev":"owner-page-1"}`, 201, &start)
	if start.ID == "" || len(start.Ice) != 2 || start.Ice[1]["credential"] == "" {
		t.Fatalf("start = %+v", start)
	}

	// Both of Carmen's pages see it ringing; the owner's page sees it as its own.
	for _, dev := range []string{"carmen-page-1", "carmen-page-2"} {
		w := f.wait(t, carmen, cp, dev, 0)
		if len(w.Calls) != 1 || w.Calls[0].State != "ringing" || w.Calls[0].From != "o" || !w.Calls[0].Video || w.Calls[0].Mine {
			t.Fatalf("%s sees %+v", dev, w.Calls)
		}
	}
	if w := f.wait(t, f.owner, "/api/chat", "owner-page-1", 0); len(w.Calls) != 1 || !w.Calls[0].Mine {
		t.Fatalf("owner sees %+v", w.Calls)
	}

	// Only the called side answers; the first page wins.
	f.call(t, f.owner, "POST", "/api/chat/call/"+start.ID+"/answer", `{"dev":"owner-page-2"}`, 403, nil)
	f.call(t, carmen, "POST", cp+"/call/"+start.ID+"/answer", `{"dev":"carmen-page-1"}`, 200, nil)
	f.call(t, carmen, "POST", cp+"/call/"+start.ID+"/answer", `{"dev":"carmen-page-2"}`, 409, nil)
	if w := f.wait(t, carmen, cp, "carmen-page-2", 0); w.Calls[0].State != "active" || w.Calls[0].Mine {
		t.Fatalf("the other page sees %+v", w.Calls)
	}

	// Signals: only the bound pages speak, and only to each other.
	f.call(t, f.owner, "POST", "/api/chat/call/"+start.ID+"/sig", `{"dev":"owner-page-2","data":{"t":"offer"}}`, 409, nil)
	f.call(t, carmen, "POST", cp+"/call/"+start.ID+"/sig", `{"dev":"carmen-page-2","data":{"t":"x"}}`, 409, nil)
	f.call(t, f.owner, "POST", "/api/chat/call/"+start.ID+"/sig", `{"dev":"owner-page-1","data":{"t":"offer","sdp":"v=0"}}`, 204, nil)
	w := f.wait(t, carmen, cp, "carmen-page-1", 0)
	if len(w.Sig) != 1 || string(w.Sig[0].Data) != `{"t":"offer","sdp":"v=0"}` {
		t.Fatalf("carmen's page got %+v", w.Sig)
	}
	if other := f.wait(t, carmen, cp, "carmen-page-2", 0); len(other.Sig) != 0 {
		t.Fatalf("the other page got a signal: %+v", other.Sig)
	}

	// An unread signal answers the wait at once, even with v up to date...
	fast := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DisableCompression: true}}
	var now callWait
	f.call(t, fast, "GET", cp+"/wait?v="+itoa(int(w.V))+"&dev=carmen-page-1&s=0", "", 200, &now)
	if len(now.Sig) != 1 {
		t.Fatalf("pending signal not delivered: %+v", now)
	}
	// ...and once read (s = its seq) it is gone and the wait blocks again.
	slow := &http.Client{Timeout: 400 * time.Millisecond, Transport: &http.Transport{DisableCompression: true}}
	if _, err := slow.Get(f.base + cp + "/wait?v=" + itoa(int(now.V)) + "&dev=carmen-page-1&s=" + itoa(int(now.Sig[0].Seq))); err == nil {
		t.Fatal("the wait returned although nothing was new")
	}

	f.call(t, carmen, "POST", cp+"/call/"+start.ID+"/sig", `{"dev":"carmen-page-1","data":{"t":"answer"}}`, 204, nil)
	if w := f.wait(t, f.owner, "/api/chat", "owner-page-1", 0); len(w.Sig) != 1 || string(w.Sig[0].Data) != `{"t":"answer"}` {
		t.Fatalf("owner's page got %+v", w.Sig)
	}

	// Two seconds of talk, without waiting them: the answer moves back.
	h := f.srv.chat
	h.mu.Lock()
	c := h.owner("ana").cs().byID[start.ID]
	c.Answered = c.Answered.Add(-2 * time.Second)
	h.mu.Unlock()
	var end struct{ State, Reason string }
	f.call(t, f.owner, "POST", "/api/chat/call/"+start.ID+"/end", `{}`, 200, &end)
	if end.State != "ended" || end.Reason != "hangup" {
		t.Fatalf("end = %+v", end)
	}
	f.call(t, carmen, "POST", cp+"/call/"+start.ID+"/end", `{}`, 200, nil) // twice is fine
	f.call(t, carmen, "POST", cp+"/call/"+start.ID+"/sig", `{"dev":"carmen-page-1","data":{}}`, 409, nil)

	msgs := f.convMsgs(t, carmen, cp+"/conv/"+conv+"/messages")
	last := msgs[len(msgs)-1]
	if last.Kind != "call" || last.From != "o" || last.Call == nil || !last.Call.Video || last.Call.Secs != 2 || last.Call.End != "" {
		t.Fatalf("bubble = %+v %+v", last, last.Call)
	}
	// A call both had is not unread for either.
	var list struct {
		Convs []chatConvOut `json:"convs"`
	}
	f.call(t, carmen, "GET", cp, "", 200, &list)
	if list.Convs[0].Unread != 0 {
		t.Fatalf("an answered call counts as unread: %d", list.Convs[0].Unread)
	}
}

// TestChatCallRules: who may call whom, busy, both at once, no coturn.
func TestChatCallRules(t *testing.T) {
	f := newCallFixture(t)
	carmen, javi := anonymous(), anonymous()
	cp, jp := "/api/c/"+f.carmen, "/api/c/"+f.javi
	dc, dj := "d-"+f.ids["Carmen"], "d-"+f.ids["Javi"]

	f.call(t, f.owner, "POST", "/api/chat/conv/"+dc+"/call", `{"video":false}`, 400, nil) // no device
	f.call(t, javi, "POST", jp+"/conv/"+dc+"/call", `{"dev":"javi-page-1"}`, 403, nil)    // not his chat
	var g struct{ ID string }
	f.call(t, f.owner, "POST", "/api/chat/groups", `{"name":"G","members":["`+f.ids["Carmen"]+`"]}`, 201, &g)
	f.call(t, f.owner, "POST", "/api/chat/conv/g-"+g.ID+"/call", `{"dev":"owner-page-1"}`, 400, nil)

	// A page cannot write a call bubble itself.
	f.call(t, carmen, "POST", cp+"/conv/"+dc+"/messages", `{"kind":"call","text":"x"}`, 400, nil)

	// The owner rings Carmen; Carmen rings back at the same moment: she gets
	// the owner's call to answer, not a second one.
	var a, b struct {
		ID       string `json:"id"`
		Incoming bool   `json:"incoming"`
	}
	f.call(t, f.owner, "POST", "/api/chat/conv/"+dc+"/call", `{"dev":"owner-page-1"}`, 201, &a)
	f.call(t, carmen, "POST", cp+"/conv/"+dc+"/call", `{"dev":"carmen-page-1"}`, 200, &b)
	if !b.Incoming || b.ID != a.ID {
		t.Fatalf("glare: %+v vs %+v", b, a)
	}

	// The owner is busy: a second call of theirs is refused, Javi hears "busy"
	// and his chat keeps a "busy" bubble.
	f.call(t, f.owner, "POST", "/api/chat/conv/"+dj+"/call", `{"dev":"owner-page-1"}`, 409, nil)
	f.call(t, javi, "POST", jp+"/conv/"+dj+"/call", `{"dev":"javi-page-1"}`, 409, nil)
	msgs := f.convMsgs(t, javi, jp+"/conv/"+dj+"/messages")
	if len(msgs) != 1 || msgs[0].Kind != "call" || msgs[0].Call.End != "busy" || msgs[0].From != f.ids["Javi"] {
		t.Fatalf("busy bubble = %+v", msgs)
	}

	// Carmen declines: a "declined" bubble, and the owner is free again.
	var end struct{ Reason string }
	f.call(t, carmen, "POST", cp+"/call/"+a.ID+"/end", `{}`, 200, &end)
	if end.Reason != "decline" {
		t.Fatalf("reason = %q", end.Reason)
	}
	msgs = f.convMsgs(t, carmen, cp+"/conv/"+dc+"/messages")
	if last := msgs[len(msgs)-1]; last.Call == nil || last.Call.End != "declined" {
		t.Fatalf("declined bubble = %+v", last)
	}
	f.call(t, f.owner, "POST", "/api/chat/conv/"+dj+"/call", `{"dev":"owner-page-1"}`, 201, nil)

	// A call bubble cannot be forwarded.
	f.call(t, f.owner, "POST", "/api/chat/conv/"+dc+"/messages",
		`{"fwdConv":"`+dc+`","fwdId":`+itoa(int(msgs[len(msgs)-1].ID))+`}`, 400, nil)
}

// TestChatCallsOff: no coturn configured -> no calls, and the pages know.
func TestChatCallsOff(t *testing.T) {
	f := newChatFixture(t)
	var sum struct {
		CallsOn bool `json:"callsOn"`
	}
	f.call(t, f.owner, "GET", "/api/chat", "", 200, &sum)
	if sum.CallsOn {
		t.Fatal("callsOn with no turn_uris")
	}
	f.call(t, f.owner, "POST", "/api/chat/conv/d-"+f.ids["Carmen"]+"/call", `{"dev":"owner-page-1"}`, 404, nil)

	// turn_uris without the secret file: still off.
	g := newChatFixture(t)
	g.srv.cfg.Read(func(c *ServerConfig) { c.TurnURIs = []string{"turn:turn.example:3478"} })
	g.call(t, g.owner, "POST", "/api/chat/conv/d-"+g.ids["Carmen"]+"/call", `{"dev":"owner-page-1"}`, 404, nil)
}

// TestChatCallTimeouts: nobody answers; the caller's page vanishes; a page
// is lost mid-call; an ended call is forgotten.
func TestChatCallTimeouts(t *testing.T) {
	f := newCallFixture(t)
	h := f.srv.chat
	carmen := anonymous()
	cp, dc := "/api/c/"+f.carmen, "d-"+f.ids["Carmen"]
	tick := func(after time.Duration) {
		h.mu.Lock()
		jobs := h.callTick(h.owner("ana"), time.Now().Add(after))
		h.mu.Unlock()
		_ = jobs
	}
	callOf := func(id string) *chatCall {
		h.mu.Lock()
		defer h.mu.Unlock()
		return h.owner("ana").cs().byID[id]
	}
	start := func() string {
		var s struct{ ID string }
		f.call(t, f.owner, "POST", "/api/chat/conv/"+dc+"/call", `{"dev":"owner-page-1"}`, 201, &s)
		return s.ID
	}

	// 1. Nobody answers: "missed", and it is unread for Carmen.
	id := start()
	tick(chatCallRing / 2)
	if c := callOf(id); c.State != "ringing" {
		t.Fatalf("ended early: %+v", c)
	}
	tick(chatCallRing + time.Second)
	if c := callOf(id); c.State != "ended" || c.Reason != "noanswer" {
		t.Fatalf("no answer: %+v", c)
	}
	msgs := f.convMsgs(t, carmen, cp+"/conv/"+dc+"/messages")
	if last := msgs[len(msgs)-1]; last.Call == nil || last.Call.End != "missed" {
		t.Fatalf("missed bubble = %+v", last)
	}
	var list struct {
		Convs []chatConvOut `json:"convs"`
	}
	f.call(t, carmen, "GET", cp, "", 200, &list)
	if list.Convs[0].Unread != 1 {
		t.Fatalf("a missed call is not unread: %d", list.Convs[0].Unread)
	}

	// 2. An ended call is forgotten after chatCallKeep.
	tick(chatCallKeep + chatCallRing + 2*time.Second)
	if callOf(id) != nil {
		t.Fatal("an old ended call is still kept")
	}

	// 3. Answered, then Carmen's page is never seen again: "lost", with a duration.
	id = start()
	f.call(t, carmen, "POST", cp+"/call/"+id+"/answer", `{"dev":"carmen-page-1"}`, 200, nil)
	tick(chatCallLost / 2)
	if c := callOf(id); c.State != "active" {
		t.Fatalf("a quiet but recent page ended the call: %+v", c)
	}
	tick(chatCallLost + time.Second)
	if c := callOf(id); c.State != "ended" || c.Reason != "lost" {
		t.Fatalf("lost: %+v", c)
	}
	msgs = f.convMsgs(t, carmen, cp+"/conv/"+dc+"/messages")
	if last := msgs[len(msgs)-1]; last.Call == nil || last.Call.End != "" || last.Call.Secs < 1 {
		t.Fatalf("lost bubble = %+v", last.Call)
	}

	// 4. An open wait keeps a page alive however long it lasts.
	h.mu.Lock()
	cs := h.owner("ana").cs()
	cs.waitStart("owner-page-1")
	h.mu.Unlock()
	id = start()
	h.mu.Lock()
	cs.seen["owner-page-1"] = time.Now().Add(-time.Hour)
	h.mu.Unlock()
	tick(chatCallRing / 2)
	if c := callOf(id); c.State != "ringing" {
		t.Fatalf("a page with an open wait was taken for gone: %+v", c)
	}
	// ...and without it, the ringing caller's page is gone: "cancel".
	h.mu.Lock()
	cs.waitEnd("owner-page-1", time.Now().Add(-time.Hour))
	h.mu.Unlock()
	tick(chatCallRing / 2)
	if c := callOf(id); c.State != "ended" || c.Reason != "cancel" {
		t.Fatalf("vanished caller: %+v", c)
	}
}

// TestChatCallPush: the called side's devices ring, then hear it was missed or
// answered; the words come in the device's language; mute does not silence it.
func TestChatCallPush(t *testing.T) {
	f := newCallFixture(t)
	var mu sync.Mutex
	hits := 0
	push := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	}))
	defer push.Close()
	localPush(f.srv.chat.push) // the fake service is on this machine
	count := func() int { mu.Lock(); defer mu.Unlock(); return hits }
	waitHits := func(n int) {
		t.Helper()
		for i := 0; i < 500 && count() < n; i++ { // up to 10 s: a slow box, not a flake
			time.Sleep(20 * time.Millisecond)
		}
		if count() != n {
			t.Fatalf("pushes = %d, want %d", count(), n)
		}
	}
	key, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	keys := PushKeys{P256dh: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		Auth: base64.RawURLEncoding.EncodeToString(auth)}
	h := f.srv.chat
	evs := traceEvents(t, h)
	dc := "d-" + f.ids["Carmen"]
	h.mu.Lock()
	o := h.owner("ana")
	o.contact(f.ids["Carmen"]).Subs = []PushSub{{Endpoint: push.URL + "/a", Keys: keys, Lang: "es"}}
	h.conv(o, dc).st.Mute = map[string]bool{f.ids["Carmen"]: true}
	h.mu.Unlock()

	var s struct{ ID string }
	f.call(t, f.owner, "POST", "/api/chat/conv/"+dc+"/call", `{"video":true,"dev":"owner-page-1"}`, 201, &s)
	waitHits(1) // rings, muted or not

	h.mu.Lock()
	c := o.cs().byID[s.ID]
	ring := h.callPushes(o, c, "ring")
	missed := h.callPushes(o, c, "missed")
	quiet := h.callPushes(o, c, "quiet")
	h.mu.Unlock()
	p := ring[0].payload
	if p["kind"] != "call" || p["tag"] != "call-"+s.ID || p["title"] != "Ana" || p["body"] == "" ||
		p["late"] == "" || p["until"].(int64) <= time.Now().UnixMilli() || p["url"] != "/c/"+f.carmen+"/?c="+dc {
		t.Fatalf("ring = %v", p)
	}
	if missed[0].payload["quiet"] != nil || missed[0].ttl != chatPushTTL || quiet[0].payload["quiet"] != true {
		t.Fatalf("missed = %v, quiet = %v", missed[0].payload, quiet[0].payload)
	}

	// Answered: the ringing notification is replaced, quietly.
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/call/"+s.ID+"/answer", `{"dev":"carmen-page-1"}`, 200, nil)
	if n := waitEv(t, evs, "call-push"); n != 1 {
		t.Fatalf("the answer sent %d pushes, want 1", n)
	}
	waitHits(2)
	// Hung up while talking: nothing more.
	f.call(t, f.owner, "POST", "/api/chat/call/"+s.ID+"/end", `{}`, 200, nil)
	if n := waitEv(t, evs, "call-push"); n != 0 {
		t.Fatalf("a hang-up while talking sent %d pushes", n)
	}
	waitHits(2)

	// Rings, then the caller gives up: "missed" replaces it.
	f.call(t, f.owner, "POST", "/api/chat/conv/"+dc+"/call", `{"dev":"owner-page-1"}`, 201, &s)
	waitHits(3)
	f.call(t, f.owner, "POST", "/api/chat/call/"+s.ID+"/end", `{}`, 200, nil)
	waitHits(4)
}
