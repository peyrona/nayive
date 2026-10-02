package main

// Data-safety seal (cleanup Phase 3, batch S1): Chat never rewrites from
// memory a file that failed to load (F5), and never answers "sent" for a
// message that is not on disk (J5).

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// dsChatConv sends n messages from ana to Carmen and answers the conversation,
// its folder and the current month's file.
func dsChatConv(t *testing.T, f *chatFixture, n int) (string, string, string) {
	t.Helper()
	conv := "d-" + f.ids["Carmen"]
	for i := 1; i <= n; i++ {
		f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", fmt.Sprintf(`{"kind":"text","text":"mensaje %d"}`, i), 201, nil)
	}
	dir := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "conv", conv)
	return conv, dir, filepath.Join(dir, time.Now().UTC().Format("2006-01")+".json")
}

// TestDS_F5_DamagedMonthNotRewritten: a month file cut short (a disk error, a
// cut copy from a restore): after a restart the next message in that chat is
// refused with an error - never written as a month of one - and the file
// keeps its bytes. Another chat of the same owner is not affected.
func TestDS_F5_DamagedMonthNotRewritten(t *testing.T) {
	f := newChatFixture(t)
	conv, _, month := dsChatConv(t, f, 5)
	raw, _ := os.ReadFile(month)
	cut := raw[:len(raw)-3]
	os.WriteFile(month, cut, 0o644)
	f.srv.chat.DropUser("ana") // as a restart

	code, body := callJSON(t, anonymous(), "POST", f.base+"/api/c/"+f.carmen+"/conv/"+conv+"/messages", `{"kind":"text","text":"hola"}`)
	if code == http.StatusCreated || code == http.StatusOK {
		t.Errorf("a message into a damaged month = %d %s", code, body)
	}
	if after, _ := os.ReadFile(month); string(after) != string(cut) {
		t.Errorf("the damaged month was rewritten: %d bytes, had %d", len(after), len(cut))
	}
	// Reading still works, and Javi's chat takes messages.
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, nil)
	f.call(t, f.owner, "POST", "/api/chat/conv/d-"+f.ids["Javi"]+"/messages", `{"kind":"text","text":"hola Javi"}`, 201, nil)
}

// TestDS_F5_DamagedStateNotRewritten: a state.json cut short (read cursors,
// kept links): no change of that conversation is taken, and the file stays.
func TestDS_F5_DamagedStateNotRewritten(t *testing.T) {
	f := newChatFixture(t)
	conv, dir, _ := dsChatConv(t, f, 2)
	state := filepath.Join(dir, "state.json")
	raw, _ := os.ReadFile(state)
	cut := raw[:len(raw)-2]
	os.WriteFile(state, cut, 0o644)
	f.srv.chat.DropUser("ana")

	for _, c := range []struct{ path, body string }{
		{"/api/chat/conv/" + conv + "/messages", `{"kind":"text","text":"otra"}`},
		{"/api/chat/conv/" + conv + "/read", `{"id":2}`},
		{"/api/chat/conv/" + conv + "/prefs", `{"pin":true}`},
	} {
		if code, body := callJSON(t, f.owner, "POST", f.base+c.path, c.body); code < 400 {
			t.Errorf("POST %s with a damaged state.json = %d %s", c.path, code, body)
		}
	}
	if after, _ := os.ReadFile(state); string(after) != string(cut) {
		t.Errorf("state.json was rewritten:\n%s", after)
	}
}

// TestDS_F5_DamagedChatJSONNotRewritten: chat.json cut short (every person,
// link and group): the owner's next change is refused, the file stays.
func TestDS_F5_DamagedChatJSONNotRewritten(t *testing.T) {
	f := newChatFixture(t)
	path := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "chat.json")
	raw, _ := os.ReadFile(path)
	cut := raw[:len(raw)-2]
	os.WriteFile(path, cut, 0o644)
	f.srv.chat.DropUser("ana")

	if code, body := callJSON(t, f.owner, "PUT", f.base+"/api/chat/me", `{"name":"Ana"}`); code == http.StatusOK {
		t.Errorf("PUT me over a damaged chat.json = 200 %s", body)
	}
	if code, body := callJSON(t, f.owner, "POST", f.base+"/api/chat/contacts", `{"name":"Lola"}`); code < 400 {
		t.Errorf("a new person over a damaged chat.json = %d %s", code, body)
	}
	if after, _ := os.ReadFile(path); string(after) != string(cut) {
		t.Errorf("chat.json was rewritten: %d bytes, had %d", len(after), len(cut))
	}
}

// TestDS_J5_FailedWriteNotSent: a message whose month cannot be written (disk
// full, I/O error - here a folder the server may not write) is answered with
// an error, and is not left in memory to appear "sent" until a restart.
func TestDS_J5_FailedWriteNotSent(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes into a 0500 folder")
	}
	f := newChatFixture(t)
	conv, dir, _ := dsChatConv(t, f, 2)
	var before msgList
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &before)

	os.Chmod(dir, 0o500)
	code, body := callJSON(t, f.owner, "POST", f.base+"/api/chat/conv/"+conv+"/messages", `{"kind":"text","text":"no cabe","cid":"c-1"}`)
	os.Chmod(dir, 0o755)
	if code == http.StatusCreated || code == http.StatusOK {
		t.Errorf("a message that could not be written = %d %s", code, body)
	}
	var after msgList
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &after)
	if len(after.Msgs) != len(before.Msgs) {
		t.Errorf("the unsaved message is shown: %d messages, had %d", len(after.Msgs), len(before.Msgs))
	}
	// The retry, with the same cid, now goes - as a new message, not a "dup".
	var m chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"kind":"text","text":"no cabe","cid":"c-1"}`, 201, &m)
	f.srv.chat.DropUser("ana")
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &after)
	if len(after.Msgs) != len(before.Msgs)+1 {
		t.Errorf("after the retry and a restart: %d messages, want %d", len(after.Msgs), len(before.Msgs)+1)
	}
}
