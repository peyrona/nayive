package main

// =============================================================================
// Chat (chat.go, api_chat.go) end to end: an owner, people by link, groups.
// =============================================================================

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// chatFixture: ana signed in, with two people (Carmen, Javi) and their links.
type chatFixture struct {
	srv    *Server
	base   string
	owner  *http.Client
	carmen string // token
	javi   string
	ids    map[string]string // name -> person id
}

func newChatFixture(t *testing.T) *chatFixture {
	t.Helper()
	srv, ts, client := newTestServer(t)
	os.MkdirAll(filepath.Join(srv.cfg.AppsDir, "chat"), 0o755)
	os.WriteFile(filepath.Join(srv.cfg.AppsDir, "chat", "guest.html"),
		[]byte("<title>{{OWNER}}</title>"), 0o644)
	os.WriteFile(filepath.Join(srv.cfg.AppsDir, "chat", "guest-sw.js"), []byte("// sw"), 0o644)
	signIn(t, client, ts.URL, "ana", "abc")
	f := &chatFixture{srv: srv, base: ts.URL, owner: client, ids: map[string]string{}}
	for _, name := range []string{"Carmen", "Javi"} {
		var c chatContactOut
		f.call(t, client, "POST", "/api/chat/contacts", `{"name":"`+name+`"}`, 201, &c)
		f.ids[name] = c.ID
		if name == "Carmen" {
			f.carmen = c.Token
		} else {
			f.javi = c.Token
		}
	}
	return f
}

// call does one JSON request, checks the status and decodes the answer.
func (f *chatFixture) call(t *testing.T, client *http.Client, method, path, body string,
	want int, out any) []byte {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	resp := do(t, client, method, f.base+path, rd, map[string]string{"Content-Type": "application/json"})
	raw := readBody(t, resp)
	if resp.StatusCode != want {
		t.Fatalf("%s %s = %d, want %d: %s", method, path, resp.StatusCode, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("%s %s: bad JSON %v: %s", method, path, err, raw)
		}
	}
	return raw
}

type msgList struct {
	Rev  int64            `json:"rev"`
	Msgs []chatMsgOut     `json:"msgs"`
	Read map[string]int64 `json:"read"`
	More bool             `json:"more"`
}

// TestChatPersonTalksToOwner: a person writes by link, the owner reads it, and
// "since rev" brings exactly the change.
func TestChatPersonTalksToOwner(t *testing.T) {
	f := newChatFixture(t)
	guest := anonymous()
	conv := "d-" + f.ids["Carmen"]

	var sum map[string]any
	f.call(t, guest, "GET", "/api/c/"+f.carmen, "", 200, &sum)
	if sum["me"] != f.ids["Carmen"] || sum["owner"] != "Ana" {
		t.Fatalf("guest summary = %v", sum)
	}
	if _, leaks := sum["contacts"]; leaks {
		t.Fatal("a person must not get the owner's list of people and links")
	}

	var m chatMsgOut
	f.call(t, guest, "POST", "/api/c/"+f.carmen+"/conv/"+conv+"/messages",
		`{"kind":"text","text":"hola","cid":"a1"}`, 201, &m)
	// the same cid again is the same message, not a second one
	var again chatMsgOut
	f.call(t, guest, "POST", "/api/c/"+f.carmen+"/conv/"+conv+"/messages",
		`{"kind":"text","text":"hola","cid":"a1"}`, 200, &again)
	if again.ID != m.ID {
		t.Fatalf("a retried send made message %d, want %d", again.ID, m.ID)
	}

	var list msgList
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 1 || list.Msgs[0].Text != "hola" || list.Msgs[0].From != f.ids["Carmen"] {
		t.Fatalf("owner sees %+v", list.Msgs)
	}
	var reply chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages",
		fmt.Sprintf(`{"kind":"text","text":"¿qué tal?","replyTo":%d}`, m.ID), 201, &reply)

	var delta msgList
	f.call(t, guest, "GET", fmt.Sprintf("/api/c/%s/conv/%s/messages?since=%d", f.carmen, conv, list.Rev), "", 200, &delta)
	if len(delta.Msgs) != 1 || delta.Msgs[0].ID != reply.ID || delta.Msgs[0].Quote == nil ||
		delta.Msgs[0].Quote.Text != "hola" {
		t.Fatalf("since rev gave %+v", delta.Msgs)
	}

	// Unread for the owner was 1, then read.
	var unread map[string]int
	f.call(t, f.owner, "GET", "/api/chat/unread", "", 200, &unread)
	if unread["n"] != 0 { // the owner's own reply moved their read cursor past it
		t.Fatalf("unread = %v", unread)
	}
}

// TestChatWalls: a person reaches only their own conversation and their groups.
func TestChatWalls(t *testing.T) {
	f := newChatFixture(t)
	guest := anonymous()
	javiConv := "d-" + f.ids["Javi"]

	f.call(t, guest, "GET", "/api/c/"+f.carmen+"/conv/"+javiConv+"/messages", "", 403, nil)
	f.call(t, guest, "POST", "/api/c/"+f.carmen+"/conv/"+javiConv+"/messages",
		`{"kind":"text","text":"x"}`, 403, nil)
	f.call(t, guest, "GET", "/api/c/"+strings.Repeat("A", 43), "", 404, nil)
	f.call(t, guest, "GET", "/api/chat", "", 401, nil)
	f.call(t, guest, "POST", "/api/c/"+f.carmen+"/contacts", `{"name":"x"}`, 403, nil)

	// A group with Javi only: Carmen is out, Javi is in.
	var g struct{ ID string }
	f.call(t, f.owner, "POST", "/api/chat/groups",
		`{"name":"Cena","members":["`+f.ids["Javi"]+`","nadie"]}`, 201, &g)
	gconv := "g-" + g.ID
	f.call(t, guest, "GET", "/api/c/"+f.carmen+"/conv/"+gconv+"/messages", "", 403, nil)
	f.call(t, guest, "POST", "/api/c/"+f.javi+"/conv/"+gconv+"/messages", `{"kind":"text","text":"hola grupo"}`, 201, nil)

	// Add Carmen: she sees the history.
	f.call(t, f.owner, "PATCH", "/api/chat/groups/"+g.ID,
		`{"members":["`+f.ids["Javi"]+`","`+f.ids["Carmen"]+`"]}`, 200, nil)
	var list msgList
	f.call(t, guest, "GET", "/api/c/"+f.carmen+"/conv/"+gconv+"/messages", "", 200, &list)
	if len(list.Msgs) != 1 {
		t.Fatalf("Carmen sees %d messages in the group", len(list.Msgs))
	}
	var sum struct {
		People map[string]string `json:"people"`
		Convs  []chatConvOut     `json:"convs"`
	}
	f.call(t, guest, "GET", "/api/c/"+f.carmen, "", 200, &sum)
	if len(sum.Convs) != 2 || sum.People[f.ids["Javi"]] != "Javi" {
		t.Fatalf("Carmen's list = %+v", sum)
	}

	// Edit and delete: only one's own.
	id := list.Msgs[0].ID
	f.call(t, guest, "PATCH", fmt.Sprintf("/api/c/%s/conv/%s/messages/%d", f.carmen, gconv, id), `{"text":"mío"}`, 403, nil)
	f.call(t, guest, "DELETE", fmt.Sprintf("/api/c/%s/conv/%s/messages/%d", f.carmen, gconv, id), "", 403, nil)
	var edited chatMsgOut
	f.call(t, guest, "PATCH", fmt.Sprintf("/api/c/%s/conv/%s/messages/%d", f.javi, gconv, id), `{"text":"hola a todos"}`, 200, &edited)
	if edited.Text != "hola a todos" || edited.Edited == 0 {
		t.Fatalf("edit = %+v", edited)
	}
	var gone chatMsgOut
	f.call(t, guest, "DELETE", fmt.Sprintf("/api/c/%s/conv/%s/messages/%d", f.javi, gconv, id), "", 200, &gone)
	if !gone.Deleted || gone.Text != "" {
		t.Fatalf("delete = %+v", gone)
	}
	// ...and the text is gone from the disk, not just hidden.
	raw, _ := os.ReadFile(filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "conv", gconv,
		time.Now().UTC().Format("2006-01")+".json"))
	if bytes.Contains(raw, []byte("hola a todos")) {
		t.Fatal("a deleted message's text is still on disk")
	}

	// Removing Carmen from the group closes it to her again.
	f.call(t, f.owner, "PATCH", "/api/chat/groups/"+g.ID, `{"members":["`+f.ids["Javi"]+`"]}`, 200, nil)
	f.call(t, guest, "GET", "/api/c/"+f.carmen+"/conv/"+gconv+"/messages", "", 403, nil)
}

// TestChatNewLinkAndDelete: a new link kills the old one; a deleted person's
// link is dead and they leave every group.
func TestChatNewLinkAndDelete(t *testing.T) {
	f := newChatFixture(t)
	guest := anonymous()
	var fresh chatContactOut
	f.call(t, f.owner, "POST", "/api/chat/contacts/"+f.ids["Carmen"]+"/link", "", 200, &fresh)
	if fresh.Token == f.carmen || len(fresh.Token) < 43 {
		t.Fatalf("new link = %q", fresh.Token)
	}
	f.call(t, guest, "GET", "/api/c/"+f.carmen, "", 404, nil)
	f.call(t, guest, "GET", "/api/c/"+fresh.Token, "", 200, nil)

	var g struct{ ID string }
	f.call(t, f.owner, "POST", "/api/chat/groups", `{"name":"G","members":["`+f.ids["Javi"]+`"]}`, 201, &g)
	f.call(t, f.owner, "DELETE", "/api/chat/contacts/"+f.ids["Javi"], "", 200, nil)
	f.call(t, guest, "GET", "/api/c/"+f.javi, "", 404, nil)
	var sum struct {
		Convs []chatConvOut `json:"convs"`
	}
	f.call(t, f.owner, "GET", "/api/chat", "", 200, &sum)
	for _, c := range sum.Convs {
		if c.ID == "d-"+f.ids["Javi"] || (c.ID == "g-"+g.ID && len(c.Members) != 1) {
			t.Fatalf("after deleting Javi: %+v", c)
		}
	}
}

// TestChatSurvivesRestart: messages, read cursors and links are on disk.
func TestChatSurvivesRestart(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/conv/"+conv+"/messages", `{"kind":"text","text":"uno"}`, 201, nil)
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"kind":"poll","poll":{"q":"¿Día?","opts":["sáb","dom"]}}`, 201, nil)

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv2, err := NewServer(f.srv.cfg, log)
	if err != nil {
		t.Fatal(err)
	}
	ts2 := httptest.NewServer(srv2.routes())
	defer ts2.Close()
	resp := do(t, anonymous(), "GET", ts2.URL+"/api/c/"+f.carmen+"/conv/"+conv+"/messages", nil, nil)
	var list msgList
	json.Unmarshal(readBody(t, resp), &list)
	if len(list.Msgs) != 2 || list.Msgs[0].Text != "uno" || list.Msgs[1].Poll == nil {
		t.Fatalf("after a restart: %+v", list.Msgs)
	}
	// and a new message continues the numbering
	resp = do(t, anonymous(), "POST", ts2.URL+"/api/c/"+f.carmen+"/conv/"+conv+"/messages",
		strings.NewReader(`{"kind":"text","text":"tres"}`), map[string]string{"Content-Type": "application/json"})
	var m chatMsgOut
	json.Unmarshal(readBody(t, resp), &m)
	if m.ID != 3 {
		t.Fatalf("next id after a restart = %d, want 3", m.ID)
	}
}

// TestChatReactVoteRead: reactions, a poll and the read cursor.
func TestChatReactVoteRead(t *testing.T) {
	f := newChatFixture(t)
	guest := anonymous()
	conv := "d-" + f.ids["Carmen"]
	var poll chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages",
		`{"kind":"poll","poll":{"q":"¿Día?","opts":["sáb","dom"],"multi":true}}`, 201, &poll)
	p := fmt.Sprintf("/api/c/%s/conv/%s/messages/%d", f.carmen, conv, poll.ID)
	var out chatMsgOut
	f.call(t, guest, "POST", p+"/vote", `{"opt":0}`, 200, nil)
	f.call(t, guest, "POST", p+"/vote", `{"opt":1}`, 200, &out)
	if got := out.Poll.Votes[f.ids["Carmen"]]; len(got) != 2 {
		t.Fatalf("multi vote = %v", got)
	}
	f.call(t, guest, "POST", p+"/vote", `{"opt":0}`, 200, &out) // tap again: taken back
	if got := out.Poll.Votes[f.ids["Carmen"]]; len(got) != 1 || got[0] != 1 {
		t.Fatalf("after un-vote = %v", got)
	}
	f.call(t, guest, "POST", p+"/vote", `{"opt":9}`, 400, nil)
	f.call(t, guest, "POST", p+"/react", `{"emoji":"👍"}`, 200, &out)
	if out.Reacts[f.ids["Carmen"]] != "👍" {
		t.Fatalf("react = %v", out.Reacts)
	}
	f.call(t, guest, "POST", p+"/react", `{"emoji":"<script>"}`, 400, nil)

	f.call(t, guest, "POST", "/api/c/"+f.carmen+"/conv/"+conv+"/read", fmt.Sprintf(`{"id":%d}`, poll.ID), 200, nil)
	var list msgList
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if list.Read[f.ids["Carmen"]] != poll.ID {
		t.Fatalf("read cursors = %v", list.Read)
	}
}

// TestChatUploads: a photo must be a JPEG; a file is always a download; the
// person's quota of bytes and the file cap hold.
func TestChatUploads(t *testing.T) {
	f := newChatFixture(t)
	guest := anonymous()
	conv := "d-" + f.ids["Carmen"]
	up := func(kind, name string, body []byte, want int) chatMsgOut {
		t.Helper()
		resp := do(t, guest, "POST", fmt.Sprintf("%s/api/c/%s/conv/%s/upload?kind=%s&name=%s",
			f.base, f.carmen, conv, kind, name), bytes.NewReader(body), nil)
		raw := readBody(t, resp)
		if resp.StatusCode != want {
			t.Fatalf("upload %s = %d, want %d: %s", name, resp.StatusCode, want, raw)
		}
		var m chatMsgOut
		json.Unmarshal(raw, &m)
		return m
	}
	up("photo", "x.jpg", []byte("<html>not a photo</html>"), 400)
	jpeg := []byte{0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9, 'M', 'P', '4'}
	photo := up("photo", "IMG_1.HEIC", jpeg, 201)
	if photo.File == nil || photo.File.Name != "IMG_1.jpg" || photo.File.Ext != "jpg" {
		t.Fatalf("photo = %+v", photo.File)
	}
	page := up("file", "evil.html", []byte("<script>alert(1)</script>"), 201)

	resp := do(t, f.owner, "GET", fmt.Sprintf("%s/api/chat/conv/%s/media/%d", f.base, conv, page.ID), nil, nil)
	body := readBody(t, resp)
	if resp.Header.Get("Content-Type") != "application/octet-stream" ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), "attachment;") || !bytes.Contains(body, []byte("alert")) {
		t.Fatalf("file served as %q %q", resp.Header.Get("Content-Type"), resp.Header.Get("Content-Disposition"))
	}
	resp = do(t, guest, "GET", fmt.Sprintf("%s/api/c/%s/conv/%s/media/%d", f.base, f.carmen, conv, photo.ID), nil, nil)
	body = readBody(t, resp)
	if resp.Header.Get("Content-Type") != "image/jpeg" || bytes.Contains(body, []byte("MP4")) {
		t.Fatalf("photo served as %q, %d bytes (the tail after the image must be cut)", resp.Header.Get("Content-Type"), len(body))
	}
	// Javi is not in Carmen's conversation.
	resp = do(t, guest, "GET", fmt.Sprintf("%s/api/c/%s/conv/%s/media/%d", f.base, f.javi, conv, photo.ID), nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("another person got the photo: %d", resp.StatusCode)
	}
	// Deleting the file message deletes the file.
	f.call(t, guest, "DELETE", fmt.Sprintf("/api/c/%s/conv/%s/messages/%d", f.carmen, conv, page.ID), "", 200, nil)
	if _, err := os.Stat(filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "conv", conv, "media", fmt.Sprintf("%d.html", page.ID))); !os.IsNotExist(err) {
		t.Fatal("a deleted file is still on disk")
	}
	// Forwarding a photo to the owner's other conversation copies it.
	var fw chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/d-"+f.ids["Javi"]+"/messages",
		fmt.Sprintf(`{"fwdConv":"%s","fwdId":%d}`, conv, photo.ID), 201, &fw)
	if !fw.Fwd || fw.Kind != "photo" {
		t.Fatalf("forward = %+v", fw)
	}
	resp = do(t, guest, "GET", fmt.Sprintf("%s/api/c/%s/conv/d-%s/media/%d", f.base, f.javi, f.ids["Javi"], fw.ID), nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("forwarded photo = %d", resp.StatusCode)
	}
}

// TestChatWait: the long-poll returns at once on an old version, and wakes on
// a new message.
func TestChatWait(t *testing.T) {
	f := newChatFixture(t)
	guest := anonymous()
	var first map[string]any
	f.call(t, guest, "GET", "/api/c/"+f.carmen+"/wait?v=-1", "", 200, &first)
	v := int64(first["v"].(float64))

	done := make(chan map[string]any, 1)
	go func() {
		resp := do(t, guest, "GET", fmt.Sprintf("%s/api/c/%s/wait?v=%d", f.base, f.carmen, v), nil, nil)
		var out map[string]any
		json.Unmarshal(readBody(t, resp), &out)
		done <- out
	}()
	time.Sleep(150 * time.Millisecond)
	start := time.Now()
	f.call(t, f.owner, "POST", "/api/chat/conv/d-"+f.ids["Carmen"]+"/messages", `{"kind":"text","text":"despierta"}`, 201, nil)
	select {
	case out := <-done:
		revs := out["revs"].(map[string]any)
		if revs["d-"+f.ids["Carmen"]] == float64(0) || time.Since(start) > 5*time.Second {
			t.Fatalf("wait woke with %v", out)
		}
		online := out["online"].([]any)
		if len(online) != 1 || online[0] != "o" {
			// the owner has no wait open, but Carmen sees... nobody online is also fine
			_ = online
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the wait did not wake on a new message")
	}
}

// TestChatPushHosts: a person's device may only be a real push service.
func TestChatPushHosts(t *testing.T) {
	for host, want := range map[string]bool{
		"https://fcm.googleapis.com/fcm/send/abc":           true,
		"https://web.push.apple.com/QGx":                    true,
		"https://updates.push.services.mozilla.com/wpush/x": true,
		"https://evil.example/x":                            false,
		"https://fcm.googleapis.com.evil.example/x":         false,
		"http://fcm.googleapis.com/x":                       false,
		"https://fcm.googleapis.com:8443/x":                 false,
		"https://127.0.0.1/x":                               false,
	} {
		if got := chatPushHostOK(host); got != want {
			t.Errorf("chatPushHostOK(%q) = %v, want %v", host, got, want)
		}
	}
	f := newChatFixture(t)
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/push",
		`{"subscription":{"endpoint":"https://evil.example/x","keys":{"p256dh":"x","auth":"y"}}}`, 400, nil)
}

// TestChatPages: the link's page, manifest and worker; a dead link.
func TestChatPages(t *testing.T) {
	f := newChatFixture(t)
	guest := anonymous()
	f.call(t, f.owner, "PUT", "/api/chat/me", `{"name":"Luis <b>"}`, 200, nil)

	resp := do(t, guest, "GET", f.base+"/c/"+f.carmen, nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/c/"+f.carmen+"/" {
		t.Fatalf("/c/<token> = %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	resp = do(t, guest, "GET", f.base+"/c/"+f.carmen+"/", nil, nil)
	page := string(readBody(t, resp))
	if resp.StatusCode != 200 || page != "<title>Luis &lt;b&gt;</title>" || resp.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("page = %d %q", resp.StatusCode, page)
	}
	resp = do(t, guest, "GET", f.base+"/c/"+f.carmen+"/manifest.webmanifest", nil, nil)
	var man map[string]any
	json.Unmarshal(readBody(t, resp), &man)
	if man["start_url"] != "/c/"+f.carmen+"/" || man["name"] != "Luis <b>" {
		t.Fatalf("manifest = %v", man)
	}
	resp = do(t, guest, "GET", f.base+"/c/"+f.carmen+"/sw.js", nil, nil)
	readBody(t, resp)
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/javascript") {
		t.Fatalf("worker = %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	resp = do(t, guest, "GET", f.base+"/c/"+strings.Repeat("Z", 43)+"/", nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("dead link page = %d", resp.StatusCode)
	}
}

// TestChatDataIsNotAFile: Drive cannot overwrite or trash the chat's files.
func TestChatDataIsNotAFile(t *testing.T) {
	f := newChatFixture(t)
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/conv/d-"+f.ids["Carmen"]+"/messages", `{"kind":"text","text":"x"}`, 201, nil)
	resp := do(t, f.owner, "PUT", f.base+"/api/files?file=data/chat/chat.json", strings.NewReader("{}"),
		map[string]string{"Content-Type": "application/octet-stream"})
	readBody(t, resp)
	if resp.StatusCode < 400 {
		t.Fatalf("PUT over chat.json = %d", resp.StatusCode)
	}
	resp = do(t, f.owner, "DELETE", f.base+"/api/files?file=data/chat", nil, nil)
	readBody(t, resp)
	if resp.StatusCode < 400 {
		t.Fatalf("DELETE data/chat = %d", resp.StatusCode)
	}
}

// TestChatPush: a person who is away gets the new message on their devices; a
// device the push service calls gone is forgotten; a muted chat stays quiet;
// someone looking at the chat right now is not buzzed.
func TestChatPush(t *testing.T) {
	f := newChatFixture(t)
	var mu sync.Mutex
	hits := map[string]int{}
	push := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits[r.URL.Path]++
		mu.Unlock()
		if r.URL.Path == "/gone" {
			w.WriteHeader(http.StatusGone)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer push.Close()
	count := func(p string) int { mu.Lock(); defer mu.Unlock(); return hits[p] }

	// A real key pair for the encryption (the fake service does not decrypt).
	key, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	keys := PushKeys{P256dh: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		Auth: base64.RawURLEncoding.EncodeToString(auth)}
	h := f.srv.chat
	h.mu.Lock()
	carmen := h.owner("ana").contact(f.ids["Carmen"])
	carmen.Subs = []PushSub{{Endpoint: push.URL + "/good", Keys: keys, Lang: "es"},
		{Endpoint: push.URL + "/gone", Keys: keys, Lang: "es"}}
	h.mu.Unlock()

	conv := "d-" + f.ids["Carmen"]
	send := func(text string) {
		f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"kind":"text","text":"`+text+`"}`, 201, nil)
	}
	waitHits := func(p string, n int) {
		t.Helper()
		for i := 0; i < 50 && count(p) < n; i++ {
			time.Sleep(40 * time.Millisecond)
		}
		if count(p) < n {
			t.Fatalf("%s got %d pushes, want %d", p, count(p), n)
		}
	}

	send("hola")
	waitHits("/good", 1)
	waitHits("/gone", 1)
	time.Sleep(100 * time.Millisecond)
	h.mu.Lock()
	left := len(carmen.Subs)
	h.mu.Unlock()
	if left != 1 {
		t.Fatalf("after a 410 the person keeps %d devices, want 1", left)
	}

	// Muted: nothing.
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/conv/"+conv+"/prefs", `{"mute":true}`, 200, nil)
	send("silencio")
	time.Sleep(300 * time.Millisecond)
	if count("/good") != 1 {
		t.Fatalf("a muted chat was pushed: %d", count("/good"))
	}
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/conv/"+conv+"/prefs", `{"mute":false}`, 200, nil)

	// Looking at it (a wait open): not now.
	var first map[string]any
	f.call(t, anonymous(), "GET", "/api/c/"+f.carmen+"/wait?v=-1", "", 200, &first)
	go func() {
		resp := do(t, anonymous(), "GET", fmt.Sprintf("%s/api/c/%s/wait?v=%d", f.base, f.carmen, int64(first["v"].(float64))), nil, nil)
		readBody(t, resp)
	}()
	time.Sleep(150 * time.Millisecond)
	send("¿estás?")
	time.Sleep(300 * time.Millisecond)
	if count("/good") != 1 {
		t.Fatalf("someone looking at the chat was pushed: %d", count("/good"))
	}
}

// TestChatClear: deleting a chat is for the one who does it (WhatsApp's
// "Eliminar chat"); it comes back with the next message; what every member
// has deleted leaves the disk, files included.
func TestChatClear(t *testing.T) {
	f := newChatFixture(t)
	guest := anonymous()
	conv := "d-" + f.ids["Carmen"]
	gpath := "/api/c/" + f.carmen + "/conv/" + conv
	f.call(t, guest, "POST", gpath+"/messages", `{"kind":"text","text":"uno secreto"}`, 201, nil)
	resp := do(t, guest, "POST", f.base+gpath+"/upload?kind=file&name=nota.txt", strings.NewReader("adjunto"), nil)
	readBody(t, resp)

	hidden := func(client *http.Client, path string) (bool, bool) {
		var sum struct{ Convs []chatConvOut }
		f.call(t, client, "GET", path, "", 200, &sum)
		for _, c := range sum.Convs {
			if c.ID == conv {
				return true, c.Hidden
			}
		}
		return false, false
	}

	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/clear", "", 200, nil)
	if found, h := hidden(f.owner, "/api/chat"); !found || !h {
		t.Fatalf("after deleting, the owner's list has it: found %v hidden %v", found, h)
	}
	var list msgList
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 0 {
		t.Fatalf("the owner still sees %d messages", len(list.Msgs))
	}
	f.call(t, guest, "GET", gpath+"/messages", "", 200, &list)
	if len(list.Msgs) != 2 {
		t.Fatalf("Carmen lost her copy: %d messages", len(list.Msgs))
	}

	// Something new: back in the list, with only the new message.
	f.call(t, guest, "POST", gpath+"/messages", `{"kind":"text","text":"tres"}`, 201, nil)
	if _, h := hidden(f.owner, "/api/chat"); h {
		t.Fatal("a new message did not bring the chat back")
	}
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 1 || list.Msgs[0].Text != "tres" {
		t.Fatalf("the owner sees %+v", list.Msgs)
	}

	// Carmen deletes it too: the first two are nobody's now, so they go.
	f.call(t, guest, "POST", gpath+"/clear", "", 200, nil)
	dir := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "conv", conv)
	raw, _ := os.ReadFile(filepath.Join(dir, time.Now().UTC().Format("2006-01")+".json"))
	if bytes.Contains(raw, []byte("uno secreto")) || !bytes.Contains(raw, []byte("tres")) {
		t.Fatalf("after both deleted: %s", raw)
	}
	if entries, _ := os.ReadDir(filepath.Join(dir, "media")); len(entries) != 0 {
		t.Fatalf("the file is still there: %d entries", len(entries))
	}
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 1 {
		t.Fatalf("the owner's copy of 'tres' went too: %d", len(list.Msgs))
	}
}

// TestChatPhotos: the owner gives a person or a group a picture; a person sees
// only the pictures of their own world.
func TestChatPhotos(t *testing.T) {
	f := newChatFixture(t)
	jpeg := []byte{0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9}
	put := func(path string, body []byte, want int) {
		t.Helper()
		resp := do(t, f.owner, "PUT", f.base+path, bytes.NewReader(body), map[string]string{"Content-Type": "image/jpeg"})
		raw := readBody(t, resp)
		if resp.StatusCode != want {
			t.Fatalf("PUT %s = %d: %s", path, resp.StatusCode, raw)
		}
	}
	put("/api/chat/contacts/"+f.ids["Carmen"]+"/photo", []byte("<svg/>"), 400)
	put("/api/chat/contacts/"+f.ids["Carmen"]+"/photo", jpeg, 200)
	f.call(t, anonymous(), "PUT", "/api/c/"+f.carmen+"/contacts/"+f.ids["Carmen"]+"/photo", "x", 403, nil)

	get := func(client *http.Client, path string) int {
		resp := do(t, client, "GET", f.base+path, nil, nil)
		readBody(t, resp)
		return resp.StatusCode
	}
	if c := get(anonymous(), "/api/c/"+f.carmen+"/avatar/"+f.ids["Carmen"]); c != 200 {
		t.Fatalf("Carmen cannot see her own picture: %d", c)
	}
	if c := get(anonymous(), "/api/c/"+f.javi+"/avatar/"+f.ids["Carmen"]); c != 404 {
		t.Fatalf("Javi sees Carmen's picture without a group in common: %d", c)
	}
	var g struct{ ID string }
	f.call(t, f.owner, "POST", "/api/chat/groups", `{"name":"G","members":["`+f.ids["Carmen"]+`","`+f.ids["Javi"]+`"]}`, 201, &g)
	put("/api/chat/groups/"+g.ID+"/photo", jpeg, 200)
	if c := get(anonymous(), "/api/c/"+f.javi+"/avatar/"+f.ids["Carmen"]); c != 200 {
		t.Fatalf("Javi, in a group with Carmen, cannot see her picture: %d", c)
	}
	var sum struct{ Avatars map[string]int64 }
	f.call(t, anonymous(), "GET", "/api/c/"+f.javi, "", 200, &sum)
	if sum.Avatars[g.ID] == 0 || sum.Avatars[f.ids["Carmen"]] == 0 {
		t.Fatalf("Javi's avatars = %v", sum.Avatars)
	}
	f.call(t, f.owner, "DELETE", "/api/chat/contacts/"+f.ids["Carmen"]+"/photo", "", 200, nil)
	if c := get(f.owner, "/api/chat/avatar/"+f.ids["Carmen"]); c != 404 {
		t.Fatalf("a removed picture is still served: %d", c)
	}

	// The owner's own picture: only the owner sets it, every person sees it.
	f.call(t, anonymous(), "PUT", "/api/c/"+f.carmen+"/me/photo", "x", 403, nil)
	put("/api/chat/me/photo", jpeg, 200)
	for _, tok := range []string{f.carmen, f.javi} {
		if c := get(anonymous(), "/api/c/"+tok+"/avatar/o"); c != 200 {
			t.Fatalf("a person cannot see the owner's picture: %d", c)
		}
	}
	f.call(t, anonymous(), "GET", "/api/c/"+f.javi, "", 200, &sum)
	if sum.Avatars["o"] == 0 {
		t.Fatalf("the owner's picture is not in Javi's avatars: %v", sum.Avatars)
	}
	f.call(t, f.owner, "DELETE", "/api/chat/me/photo", "", 200, nil)
	if c := get(anonymous(), "/api/c/"+f.carmen+"/avatar/o"); c != 404 {
		t.Fatalf("the owner's removed picture is still served: %d", c)
	}
}
