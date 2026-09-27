package main

// =============================================================================
// Chat between two Nayive users: no link, each reads it from their own Chat
// (ChatContact.User, the /api/chat/via/<home> door in api_chat.go).
// =============================================================================

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type chatUserStart struct {
	Conv    string          `json:"conv"`
	Via     string          `json:"via"`
	Contact *chatContactOut `json:"contact"`
}

// signedIn is a new cookie jar signed in as `user`.
func (f *chatFixture) signedIn(t *testing.T, user, password string) *http.Client {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar, Transport: &http.Transport{DisableCompression: true}}
	signIn(t, c, f.base, user, password)
	return c
}

// addHome makes one more account on the test server.
func (f *chatFixture) addHome(t *testing.T, user, password string) {
	t.Helper()
	home := filepath.Join(f.srv.cfg.HomesDir, user)
	os.MkdirAll(filepath.Join(home, "data"), 0o755)
	os.MkdirAll(filepath.Join(home, "files"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "config.json"), []byte(`{"password":"`+password+`"}`), 0o644)
}

// TestChatUserStart: ana starts a chat with beto (another account). beto sees
// it in his own Chat, both talk, and starting it again from either side opens
// the same chat.
func TestChatUserStart(t *testing.T) {
	f := newChatFixture(t)
	beto := f.signedIn(t, "beto", "xyz")

	// beto's "Nuevo chat" lists ana by her Chat name; nothing to read yet.
	var bsum struct {
		Via   []string            `json:"via"`
		Users []map[string]string `json:"users"`
	}
	f.call(t, beto, "GET", "/api/chat", "", 200, &bsum)
	if len(bsum.Via) != 0 || len(bsum.Users) != 1 || bsum.Users[0]["user"] != "ana" || bsum.Users[0]["name"] != "Ana" {
		t.Fatalf("beto's summary before = %+v", bsum)
	}

	var st chatUserStart
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"beto"}`, 201, &st)
	if st.Via != "" || st.Contact == nil || st.Contact.User != "beto" || st.Contact.Token != "" ||
		st.Contact.Name != "Beto" || st.Conv != "d-"+st.Contact.ID {
		t.Fatalf("start = %+v %+v", st, st.Contact)
	}
	x := st.Contact.ID

	f.call(t, beto, "GET", "/api/chat", "", 200, &bsum)
	if len(bsum.Via) != 1 || bsum.Via[0] != "ana" {
		t.Fatalf("beto's via = %v", bsum.Via)
	}
	var vsum map[string]any
	f.call(t, beto, "GET", "/api/chat/via/ana", "", 200, &vsum)
	if vsum["me"] != x || vsum["owner"] != "Ana" {
		t.Fatalf("beto's view of ana's home = %v", vsum)
	}
	if _, leaks := vsum["contacts"]; leaks {
		t.Fatal("beto must not get ana's people and links")
	}

	vp := "/api/chat/via/ana/conv/" + st.Conv
	var m chatMsgOut
	f.call(t, beto, "POST", vp+"/messages", `{"kind":"text","text":"hola Ana"}`, 201, &m)
	var list msgList
	f.call(t, f.owner, "GET", "/api/chat/conv/"+st.Conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 1 || list.Msgs[0].From != x || list.Msgs[0].Text != "hola Ana" {
		t.Fatalf("ana sees %+v", list.Msgs)
	}
	f.call(t, f.owner, "POST", "/api/chat/conv/"+st.Conv+"/messages", `{"kind":"text","text":"hola Beto"}`, 201, nil)

	// The launcher badge counts what waits for beto in ana's home.
	var unread map[string]int
	f.call(t, beto, "GET", "/api/chat/unread", "", 200, &unread)
	if unread["n"] != 1 {
		t.Fatalf("beto's unread = %v, want 1", unread)
	}

	// Once per pair: from beto's side it is ana's chat...
	var again chatUserStart
	f.call(t, beto, "POST", "/api/chat/contacts", `{"user":"ana"}`, 200, &again)
	if again.Conv != st.Conv || again.Via != "ana" || again.Contact != nil {
		t.Fatalf("beto starting it again = %+v", again)
	}
	// ...and from ana's side the same contact.
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"beto"}`, 200, &again)
	if again.Conv != st.Conv || again.Via != "" {
		t.Fatalf("ana starting it again = %+v", again)
	}
	h := f.srv.chat
	h.mu.Lock()
	n := 0
	for _, c := range h.owner("ana").data.Contacts {
		if c.User == "beto" {
			n++
		}
	}
	betoHas := len(h.owner("beto").data.Contacts)
	h.mu.Unlock()
	if n != 1 || betoHas != 0 {
		t.Fatalf("ana holds beto %d times, beto holds %d contacts", n, betoHas)
	}

	// Nobody, a made-up account, or yourself.
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"nadie"}`, 404, nil)
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"../beto"}`, 404, nil)
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"ana"}`, 400, nil)

	// A restart reads it all back (the index is rebuilt from disk).
	h.DropUser("ana")
	f.call(t, beto, "GET", "/api/chat", "", 200, &bsum)
	if len(bsum.Via) != 1 || bsum.Via[0] != "ana" {
		t.Fatalf("after a reload beto's via = %v", bsum.Via)
	}
}

// TestChatUserWalls: only the user a contact is FOR reaches it through the via
// door, and only a person's routes.
func TestChatUserWalls(t *testing.T) {
	f := newChatFixture(t)
	f.addHome(t, "carla", "ccc")
	beto := f.signedIn(t, "beto", "xyz")
	carla := f.signedIn(t, "carla", "ccc")
	var st chatUserStart
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"beto"}`, 201, &st)
	x := st.Contact.ID
	vp := "/api/chat/via/ana"

	f.call(t, beto, "GET", vp+"/conv/"+st.Conv+"/messages", "", 200, nil)
	// carla holds no contact in ana's home: nothing at all.
	f.call(t, carla, "GET", vp, "", 404, nil)
	f.call(t, carla, "GET", vp+"/conv/"+st.Conv+"/messages", "", 404, nil)
	f.call(t, carla, "POST", vp+"/conv/"+st.Conv+"/messages", `{"kind":"text","text":"x"}`, 404, nil)
	// beto cannot reach ana's other chats, nor act as her.
	f.call(t, beto, "GET", vp+"/conv/d-"+f.ids["Carmen"]+"/messages", "", 403, nil)
	f.call(t, beto, "POST", vp+"/contacts", `{"name":"Intruso"}`, 403, nil)
	f.call(t, beto, "POST", vp+"/contacts/"+x+"/link", "", 403, nil)
	f.call(t, beto, "PUT", vp+"/autodelete", `{"days":1}`, 403, nil)
	f.call(t, beto, "GET", vp+"/push", "", 404, nil) // his devices are his account's
	f.call(t, beto, "GET", "/api/chat/via/beto", "", 404, nil)
	f.call(t, anonymous(), "GET", vp, "", 401, nil)
	// A user contact has no link to renew.
	f.call(t, f.owner, "POST", "/api/chat/contacts/"+x+"/link", "", 404, nil)

	// The admin has no chat.
	admin := f.signedIn(t, "jefe", "secreto")
	f.call(t, admin, "GET", vp, "", 403, nil)

	// ana deletes him: the door closes at once and his list forgets her home.
	f.call(t, f.owner, "DELETE", "/api/chat/contacts/"+x, "", 200, nil)
	f.call(t, beto, "GET", vp, "", 404, nil)
	var bsum struct{ Via []string }
	f.call(t, beto, "GET", "/api/chat", "", 200, &bsum)
	if len(bsum.Via) != 0 {
		t.Fatalf("after the delete beto's via = %v", bsum.Via)
	}
	// Starting again makes a new chat.
	var st2 chatUserStart
	f.call(t, beto, "POST", "/api/chat/contacts", `{"user":"ana"}`, 201, &st2)
	if st2.Via != "" || st2.Conv == st.Conv {
		t.Fatalf("a new start after the delete = %+v", st2)
	}
}

// TestChatUserGroupAndPresence: a user contact is a member like any person, and
// his waits show him online to the owner.
func TestChatUserGroupAndPresence(t *testing.T) {
	f := newChatFixture(t)
	beto := f.signedIn(t, "beto", "xyz")
	var st chatUserStart
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"beto"}`, 201, &st)
	x := st.Contact.ID
	var g struct{ ID string }
	f.call(t, f.owner, "POST", "/api/chat/groups", `{"name":"Familia","members":["`+x+`","`+f.ids["Carmen"]+`"]}`, 201, &g)

	var vsum struct {
		Convs  []chatConvOut     `json:"convs"`
		People map[string]string `json:"people"`
	}
	f.call(t, beto, "GET", "/api/chat/via/ana", "", 200, &vsum)
	if len(vsum.Convs) != 2 || vsum.People[f.ids["Carmen"]] != "Carmen" {
		t.Fatalf("beto's view = %+v", vsum)
	}
	gp := "/api/chat/via/ana/conv/g-" + g.ID
	f.call(t, beto, "POST", gp+"/messages", `{"kind":"text","text":"hola a todos"}`, 201, nil)
	var list msgList
	f.call(t, anonymous(), "GET", "/api/c/"+f.carmen+"/conv/g-"+g.ID+"/messages", "", 200, &list)
	if len(list.Msgs) != 1 || list.Msgs[0].From != x {
		t.Fatalf("carmen sees %+v", list.Msgs)
	}

	// beto's page waits on ana's home: ana sees him online.
	var first struct{ V int64 }
	f.call(t, beto, "GET", "/api/chat/via/ana/wait?v=-1", "", 200, &first)
	short := &http.Client{Jar: beto.Jar, Timeout: 1500 * time.Millisecond} // the test server's Close waits for it
	go func() {
		resp, err := short.Get(f.base + "/api/chat/via/ana/wait?v=" + itoa(int(first.V)))
		if err == nil {
			resp.Body.Close()
		}
	}()
	var on bool
	for i := 0; i < 50 && !on; i++ {
		time.Sleep(20 * time.Millisecond)
		var sum struct{ Online []string }
		f.call(t, f.owner, "GET", "/api/chat", "", 200, &sum)
		on = contains(sum.Online, x)
	}
	if !on {
		t.Fatal("beto waiting on ana's home does not show online to ana")
	}
}

// TestChatUserPush: a Nayive user is notified on his ACCOUNT's devices, with a
// link to his own Chat; a ringing call too.
func TestChatUserPush(t *testing.T) {
	f := newCallFixture(t)
	var mu sync.Mutex
	hits := map[string]int{}
	push := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits[r.URL.Path]++
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	}))
	defer push.Close()
	count := func(p string) int { mu.Lock(); defer mu.Unlock(); return hits[p] }
	// The endpoint must name a real push service (cleanSub); dial the test
	// server whatever host the request names.
	tr := push.Client().Transport.(*http.Transport).Clone()
	tr.TLSClientConfig.InsecureSkipVerify = true
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, push.Listener.Addr().String())
	}
	f.srv.chat.push.client = &http.Client{Transport: tr}

	key, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	sub := PushSub{Endpoint: "https://fcm.googleapis.com/beto", Lang: "es", Keys: PushKeys{
		P256dh: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		Auth:   base64.RawURLEncoding.EncodeToString(auth)}}
	raw, _ := json.Marshal(map[string]any{"subs": []PushSub{sub}})
	os.WriteFile(filepath.Join(f.srv.cfg.HomesDir, "beto", "data", "push.json"), raw, 0o644)

	var st chatUserStart
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"beto"}`, 201, &st)
	if !st.Contact.Push {
		t.Fatal("beto's account has a device, but his contact says no notifications")
	}

	h := f.srv.chat
	h.mu.Lock()
	o := h.owner("ana")
	c := h.conv(o, st.Conv)
	jobs := h.pushTargets(o, c, &ChatMsg{ID: c.st.Next, From: "o", Kind: "text", Text: "hola"}, "")
	h.mu.Unlock()
	if len(jobs) != 1 || jobs[0].owner != "beto" || jobs[0].person != "" || jobs[0].token != "" {
		t.Fatalf("push jobs = %+v", jobs)
	}

	f.call(t, f.owner, "POST", "/api/chat/conv/"+st.Conv+"/messages", `{"kind":"text","text":"hola"}`, 201, nil)
	for i := 0; i < 50 && count("/beto") < 1; i++ {
		time.Sleep(40 * time.Millisecond)
	}
	if count("/beto") != 1 {
		t.Fatalf("beto's device got %d pushes, want 1", count("/beto"))
	}

	// A call rings on his account's devices and links to his own Chat.
	h.mu.Lock()
	calls := h.callPushes(o, &chatCall{ID: "c1", Conv: st.Conv, From: "o", To: st.Contact.ID, Rang: time.Now()}, "ring")
	h.mu.Unlock()
	if len(calls) != 1 || !calls[0].mine || calls[0].user != "beto" || calls[0].payload["url"] != URLPrefix+"/chat/?c="+st.Conv {
		t.Fatalf("call pushes = %+v", calls)
	}
}

// TestChatUserCall: beto calls ana from his own Chat, through her home.
func TestChatUserCall(t *testing.T) {
	f := newCallFixture(t)
	beto := f.signedIn(t, "beto", "xyz")
	var st chatUserStart
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"beto"}`, 201, &st)
	vp := "/api/chat/via/ana"

	var start struct{ ID string }
	f.call(t, beto, "POST", vp+"/conv/"+st.Conv+"/call", `{"video":false,"dev":"beto-page-1"}`, 201, &start)
	if w := f.wait(t, f.owner, "/api/chat", "ana-page-1", 0); len(w.Calls) != 1 || w.Calls[0].From != st.Contact.ID || w.Calls[0].State != "ringing" {
		t.Fatalf("ana sees %+v", w.Calls)
	}
	f.call(t, f.owner, "POST", "/api/chat/call/"+start.ID+"/answer", `{"dev":"ana-page-1"}`, 200, nil)
	f.call(t, f.owner, "POST", "/api/chat/call/"+start.ID+"/sig", `{"dev":"ana-page-1","data":{"t":"answer"}}`, 204, nil)
	if w := f.wait(t, beto, vp, "beto-page-1", 0); len(w.Sig) != 1 || len(w.Calls) != 1 || w.Calls[0].State != "active" {
		t.Fatalf("beto's page got %+v", w)
	}
	f.call(t, beto, "POST", vp+"/call/"+start.ID+"/end", `{}`, 200, nil)
	msgs := f.convMsgs(t, beto, vp+"/conv/"+st.Conv+"/messages")
	if last := msgs[len(msgs)-1]; last.Kind != "call" || last.From != st.Contact.ID {
		t.Fatalf("bubble = %+v", last)
	}
}

// TestChatUserAdmin: the admin renames or deletes an account; the chats other
// homes hold with it follow.
func TestChatUserAdmin(t *testing.T) {
	f := newChatFixture(t)
	var st chatUserStart
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"beto"}`, 201, &st)
	x := st.Contact.ID
	h := f.srv.chat

	home := f.srv.cfg.HomesDir
	if err := os.Rename(filepath.Join(home, "beto"), filepath.Join(home, "bruno")); err != nil {
		t.Fatal(err)
	}
	h.RenameUser("beto", "bruno")
	bruno := f.signedIn(t, "bruno", "xyz")
	var vsum map[string]any
	f.call(t, bruno, "GET", "/api/chat/via/ana", "", 200, &vsum)
	if vsum["me"] != x {
		t.Fatalf("after the rename bruno sees %v", vsum)
	}
	var disk chatData
	loadJSONFile(filepath.Join(home, "ana", "data", "chat", "chat.json"), &disk)
	if len(disk.Contacts) != 3 || disk.Contacts[2].User != "bruno" {
		t.Fatalf("ana's chat.json after the rename = %+v", disk.Contacts[2])
	}

	os.RemoveAll(filepath.Join(home, "bruno"))
	h.DeleteUser("bruno")
	h.mu.Lock()
	c := h.owner("ana").contact(x)
	gone := c.Deleted
	h.mu.Unlock()
	if !gone {
		t.Fatal("a deleted account is still a live contact")
	}
}
