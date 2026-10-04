package main

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"
)

// chatJSONReadOnly makes ana's chat.json impossible to save (its folder may
// not be written) until the returned func runs.
func chatJSONReadOnly(t *testing.T, f *chatFixture) func() {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("root writes into a 0500 folder")
	}
	dir := f.srv.chat.chatDir("ana")
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	return func() { os.Chmod(dir, 0o755) }
}

// TestBug_SF2_AutoDeleteFailedSaveKeepsOld: a new "delete after N days" that
// could not be saved is not used either - the hourly auto-delete reads memory.
func TestBug_SF2_AutoDeleteFailedSaveKeepsOld(t *testing.T) {
	f := newChatFixture(t)
	f.call(t, f.owner, "PUT", "/api/chat/autodelete", `{"days":30}`, 200, nil)
	undo := chatJSONReadOnly(t, f)
	f.call(t, f.owner, "PUT", "/api/chat/autodelete", `{"days":1}`, 500, nil)
	undo()
	h := f.srv.chat
	h.mu.Lock()
	days := h.owners["ana"].data.DeleteAfter
	h.mu.Unlock()
	if days != 30 {
		t.Fatalf("after a failed save the auto-delete uses %d days, want 30", days)
	}
}

// TestBug_SF3_LaterSentOnce: a scheduled text goes, but chat.json - which
// lists it as waiting - cannot be saved. After a restart it is not sent a
// second time.
func TestBug_SF3_LaterSentOnce(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	api := "/api/c/" + f.carmen + "/conv/" + conv + "/later"
	// A first message makes the chat's own folder, which stays writable.
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/conv/"+conv+"/messages", `{"kind":"text","text":"hola"}`, 201, nil)
	f.call(t, anonymous(), "POST", api, fmt.Sprintf(`{"text":"una vez","at":%d}`, time.Now().Add(time.Hour).UnixMilli()), 201, nil)

	undo := chatJSONReadOnly(t, f)
	f.srv.chat.sendDue(time.Now().Add(2 * time.Hour))
	undo()

	srv2, ts2 := f.restart(t)
	srv2.chat.sendDue(time.Now().Add(2 * time.Hour))
	resp := do(t, anonymous(), "GET", ts2.URL+"/api/c/"+f.carmen+"/conv/"+conv+"/messages", nil, nil)
	var list msgList
	if err := json.Unmarshal(readBody(t, resp), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Msgs) != 2 || list.Msgs[1].Text != "una vez" {
		t.Fatalf("after a restart the chat holds %d messages, want 2: %+v", len(list.Msgs), list.Msgs)
	}
	// Taken out of the list now that chat.json saves again.
	srv2.chat.mu.Lock()
	n := len(srv2.chat.owners["ana"].data.Later)
	srv2.chat.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d texts still waiting", n)
	}
}
