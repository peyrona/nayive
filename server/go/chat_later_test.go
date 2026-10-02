package main

// =============================================================================
// Chat: "Schedule message" (chat.go LATER, api_chat.go chatLater) and "Send
// without sound".
// =============================================================================

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

type laterSummary struct {
	Convs []chatConvOut `json:"convs"`
}

func laterIn(sum laterSummary, conv string) []*ChatLater {
	for _, c := range sum.Convs {
		if c.ID == conv {
			return c.Later
		}
	}
	return nil
}

// TestChatLater: a person schedules a text; only they see it waiting; it goes,
// as them, once its time has come - and "send now" and "delete" work too.
func TestChatLater(t *testing.T) {
	f := newChatFixture(t)
	guest := anonymous()
	conv := "d-" + f.ids["Carmen"]
	api := "/api/c/" + f.carmen + "/conv/" + conv + "/later"
	at := time.Now().Add(time.Hour).UnixMilli()

	var l ChatLater
	f.call(t, guest, "POST", api, fmt.Sprintf(`{"text":"luego","at":%d,"cid":"x1"}`, at), 201, &l)
	var again ChatLater
	f.call(t, guest, "POST", api, fmt.Sprintf(`{"text":"luego","at":%d,"cid":"x1"}`, at), 200, &again)
	if again.ID != l.ID {
		t.Fatalf("a retried schedule made %s, want %s", again.ID, l.ID)
	}
	f.call(t, guest, "POST", api, fmt.Sprintf(`{"text":"ayer","at":%d}`, time.Now().Add(-time.Hour).UnixMilli()), 400, nil)
	f.call(t, guest, "POST", api, fmt.Sprintf(`{"text":"  ","at":%d}`, at), 400, nil)

	var mine, owners laterSummary
	f.call(t, guest, "GET", "/api/c/"+f.carmen, "", 200, &mine)
	f.call(t, f.owner, "GET", "/api/chat", "", 200, &owners)
	if got := laterIn(mine, conv); len(got) != 1 || got[0].Text != "luego" {
		t.Fatalf("the sender sees %+v waiting", got)
	}
	if got := laterIn(owners, conv); len(got) != 0 {
		t.Fatalf("the owner sees someone else's scheduled text: %+v", got)
	}

	// Not yet: nothing goes.
	f.srv.chat.sendDue(time.Now())
	var list msgList
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 0 {
		t.Fatalf("a text went before its time: %+v", list.Msgs)
	}
	// Its time: it goes, from Carmen.
	f.srv.chat.sendDue(time.Now().Add(2 * time.Hour))
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 1 || list.Msgs[0].Text != "luego" || list.Msgs[0].From != f.ids["Carmen"] {
		t.Fatalf("after its time the owner sees %+v", list.Msgs)
	}
	var after laterSummary
	f.call(t, guest, "GET", "/api/c/"+f.carmen, "", 200, &after)
	if got := laterIn(after, conv); len(got) != 0 {
		t.Fatalf("a sent text is still waiting: %+v", got)
	}

	// Send now, and delete.
	var a, b ChatLater
	f.call(t, guest, "POST", api, fmt.Sprintf(`{"text":"ya","at":%d}`, at), 201, &a)
	f.call(t, guest, "POST", api, fmt.Sprintf(`{"text":"nunca","at":%d}`, at), 201, &b)
	var m chatMsgOut
	f.call(t, guest, "POST", api+"/"+a.ID+"/send", "", 201, &m)
	if m.Text != "ya" {
		t.Fatalf("send now sent %+v", m)
	}
	f.call(t, f.owner, "DELETE", "/api/chat/conv/"+conv+"/later/"+b.ID, "", 404, nil) // not the owner's
	f.call(t, guest, "DELETE", api+"/"+b.ID, "", 204, nil)
	f.call(t, guest, "DELETE", api+"/"+b.ID, "", 404, nil)
	f.srv.chat.sendDue(time.Now().Add(2 * time.Hour))
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 2 {
		t.Fatalf("after send now + delete: %+v", list.Msgs)
	}
}

// TestChatLaterRestart: a text waiting through a restart still goes; one to a
// person deleted meanwhile does not.
func TestChatLaterRestart(t *testing.T) {
	f := newChatFixture(t)
	at := time.Now().Add(time.Hour).UnixMilli()
	carmen, javi := "d-"+f.ids["Carmen"], "d-"+f.ids["Javi"]
	f.call(t, f.owner, "POST", "/api/chat/conv/"+carmen+"/later", fmt.Sprintf(`{"text":"sigo aquí","at":%d}`, at), 201, nil)
	f.call(t, f.owner, "POST", "/api/chat/conv/"+javi+"/later", fmt.Sprintf(`{"text":"adiós","at":%d}`, at), 201, nil)
	f.call(t, f.owner, "DELETE", "/api/chat/contacts/"+f.ids["Javi"], "", 200, nil)

	srv2, ts2 := f.restart(t)
	srv2.chat.sendDue(time.Now().Add(2 * time.Hour))

	resp := do(t, anonymous(), "GET", ts2.URL+"/api/c/"+f.carmen+"/conv/"+carmen+"/messages", nil, nil)
	var list msgList
	if err := json.Unmarshal(readBody(t, resp), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Msgs) != 1 || list.Msgs[0].Text != "sigo aquí" || list.Msgs[0].From != "o" {
		t.Fatalf("after a restart: %+v", list.Msgs)
	}
	srv2.chat.mu.Lock()
	left := len(srv2.chat.owner("ana").data.Later)
	srv2.chat.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d texts still waiting (the deleted person's must go too)", left)
	}
}

// TestChatSilent: "Send without sound" reaches the devices as a quiet push.
func TestChatSilent(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	var m chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"kind":"text","text":"chis","silent":true}`, 201, &m)
	if !m.Silent {
		t.Fatal("the message lost its silent flag")
	}
	h := f.srv.chat
	quiet := h.pushPayload(chatPushJob{msg: *m.ChatMsg, conv: conv})
	loud := h.pushPayload(chatPushJob{msg: ChatMsg{Kind: "text", Text: "hola"}, conv: conv})
	if quiet["quiet"] != true || loud["quiet"] != nil {
		t.Fatalf("quiet = %v, loud = %v", quiet, loud)
	}
}
