package main

// =============================================================================
// Group calls (chat_call.go GROUP CALLS): ringing every member, joining up to
// chatCallMax, signals page to page, leaving, a lost page, the bubble.
// =============================================================================

import (
	"net/http"
	"testing"
	"time"
)

type groupWait struct {
	Calls []chatCallOut `json:"calls"`
	Sig   []struct {
		Seq  int64  `json:"seq"`
		Call string `json:"call"`
		From string `json:"from"`
	} `json:"sig"`
}

func TestChatGroupCall(t *testing.T) {
	f := newCallFixture(t)
	tokens := map[string]string{"Carmen": f.carmen, "Javi": f.javi}
	for _, name := range []string{"Luis", "Marta"} {
		var c chatContactOut
		f.call(t, f.owner, "POST", "/api/chat/contacts", `{"name":"`+name+`"}`, 201, &c)
		f.ids[name], tokens[name] = c.ID, c.Token
	}
	var g struct{ ID string }
	f.call(t, f.owner, "POST", "/api/chat/groups", `{"name":"Karaoke","members":["`+f.ids["Carmen"]+`","`+
		f.ids["Javi"]+`","`+f.ids["Luis"]+`","`+f.ids["Marta"]+`"]}`, 201, &g)
	conv := "g-" + g.ID
	who := map[string]*http.Client{}
	prefix := func(n string) string { return "/api/c/" + tokens[n] }
	for n := range tokens {
		who[n] = anonymous()
	}
	wait := func(n, dev string) groupWait {
		t.Helper()
		var out groupWait
		f.call(t, who[n], "GET", prefix(n)+"/wait?v=-1&dev="+dev+"&s=0", "", 200, &out)
		return out
	}

	var start struct {
		ID string `json:"id"`
	}
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/call", `{"video":true,"dev":"owner-page-1"}`, 201, &start)
	id := start.ID
	callPath := func(n string) string {
		if n == "o" {
			return "/api/chat/call/" + id
		}
		return prefix(n) + "/call/" + id
	}

	// It rings for Carmen, who is not in it yet; a signal from her is refused.
	w := wait("Carmen", "carmen-page-1")
	if len(w.Calls) != 1 || !w.Calls[0].Group || !w.Calls[0].Ring || w.Calls[0].State != "ringing" ||
		len(w.Calls[0].In) != 1 || w.Calls[0].In[0] != (chatCallIn{"o", "owner-page-1"}) {
		t.Fatalf("Carmen sees %+v", w.Calls)
	}
	f.call(t, who["Carmen"], "POST", callPath("Carmen")+"/sig", `{"dev":"carmen-page-1","to":"owner-page-1","data":{"t":"x"}}`, 409, nil)

	// Pressing the group's phone while it is on joins it.
	var again struct {
		ID       string `json:"id"`
		Incoming bool   `json:"incoming"`
	}
	f.call(t, who["Carmen"], "POST", prefix("Carmen")+"/conv/"+conv+"/call", `{"dev":"carmen-page-1"}`, 200, &again)
	if again.ID != id || !again.Incoming {
		t.Fatalf("second start = %+v", again)
	}

	// Carmen joins: it is on; she offers to the owner's page.
	var joined struct {
		In []chatCallIn `json:"in"`
	}
	f.call(t, who["Carmen"], "POST", callPath("Carmen")+"/answer", `{"dev":"carmen-page-1"}`, 200, &joined)
	if len(joined.In) != 2 {
		t.Fatalf("after Carmen joined: %+v", joined)
	}
	f.call(t, who["Carmen"], "POST", callPath("Carmen")+"/answer", `{"dev":"carmen-page-2"}`, 409, nil) // her other page
	f.call(t, who["Carmen"], "POST", callPath("Carmen")+"/sig", `{"dev":"carmen-page-1","to":"owner-page-1","data":{"t":"offer"}}`, 204, nil)
	f.call(t, who["Carmen"], "POST", callPath("Carmen")+"/sig", `{"dev":"carmen-page-1","to":"nobody-page","data":{"t":"offer"}}`, 409, nil)
	f.call(t, who["Carmen"], "POST", callPath("Carmen")+"/sig", `{"dev":"carmen-page-1","to":"carmen-page-1","data":{"t":"offer"}}`, 409, nil)
	var ow groupWait
	f.call(t, f.owner, "GET", "/api/chat/wait?v=-1&dev=owner-page-1&s=0", "", 200, &ow)
	if len(ow.Sig) != 1 || ow.Sig[0].From != "carmen-page-1" {
		t.Fatalf("owner's page got %+v", ow.Sig)
	}
	if !ow.Calls[0].Mine || ow.Calls[0].State != "active" {
		t.Fatalf("owner sees %+v", ow.Calls)
	}

	// Javi and Luis make four; Marta finds it full, and declines.
	f.call(t, who["Javi"], "POST", callPath("Javi")+"/answer", `{"dev":"javi-page-1"}`, 200, nil)
	f.call(t, who["Luis"], "POST", callPath("Luis")+"/answer", `{"dev":"luis-page-1"}`, 200, nil)
	var full struct {
		Full bool `json:"full"`
	}
	f.call(t, who["Marta"], "POST", callPath("Marta")+"/answer", `{"dev":"marta-page-1"}`, 409, &full)
	if !full.Full {
		t.Fatal("a fifth person got in, or no 'full'")
	}
	f.call(t, who["Marta"], "POST", callPath("Marta")+"/end", `{"dev":"marta-page-1"}`, 200, nil)
	if w := wait("Marta", "marta-page-1"); w.Calls[0].Ring || w.Calls[0].State != "active" {
		t.Fatalf("Marta still rung, or the call stopped: %+v", w.Calls)
	}

	// Luis leaves: three talk on, and nobody may signal his page any more.
	f.call(t, who["Luis"], "POST", callPath("Luis")+"/end", `{"dev":"luis-page-1"}`, 200, nil)
	f.call(t, who["Carmen"], "POST", callPath("Carmen")+"/sig", `{"dev":"carmen-page-1","to":"luis-page-1","data":{"t":"offer"}}`, 409, nil)
	if w := wait("Carmen", "carmen-page-1"); w.Calls[0].State != "active" || len(w.Calls[0].In) != 3 {
		t.Fatalf("after Luis left: %+v", w.Calls)
	}

	// Javi's page is lost: he leaves, the call goes on.
	h := f.srv.chat
	h.mu.Lock()
	o := h.owners["ana"]
	cs := o.cs()
	cs.waits["javi-page-1"] = 0
	cs.seen["javi-page-1"] = time.Now().Add(-chatCallLost - time.Second)
	h.callTick(o, time.Now())
	c := cs.byID[id]
	if _, in := c.In[f.ids["Javi"]]; in || c.State != "active" || len(c.In) != 2 {
		h.mu.Unlock()
		t.Fatalf("after Javi was lost: state %s, in %v", c.State, c.In)
	}
	h.mu.Unlock()

	// The owner leaves: Carmen is alone, it ends. One bubble, four people.
	f.call(t, f.owner, "POST", callPath("o")+"/end", `{"dev":"owner-page-1"}`, 200, nil)
	if w := wait("Carmen", "carmen-page-1"); w.Calls[0].State != "ended" {
		t.Fatalf("Carmen alone, still %+v", w.Calls)
	}
	msgs := f.convMsgs(t, f.owner, "/api/chat/conv/"+conv+"/messages")
	last := msgs[len(msgs)-1]
	if last.Kind != "call" || last.From != "o" || last.Call == nil || last.Call.N != 4 || last.Call.Secs < 1 || last.Call.End != "" {
		t.Fatalf("bubble = %+v %+v", last, last.Call)
	}

	// Nobody comes: when the ringing time is over it is a missed call.
	f.call(t, who["Javi"], "POST", prefix("Javi")+"/conv/"+conv+"/call", `{"dev":"javi-page-1"}`, 201, &start)
	h.mu.Lock()
	h.callTick(o, time.Now().Add(chatCallRing+time.Second))
	state := cs.byID[start.ID].State
	h.mu.Unlock()
	if state != "ended" {
		t.Fatalf("unanswered group call is %s", state)
	}
	msgs = f.convMsgs(t, f.owner, "/api/chat/conv/"+conv+"/messages")
	if last := msgs[len(msgs)-1]; last.Call == nil || last.Call.End != "missed" || last.From != f.ids["Javi"] {
		t.Fatalf("missed bubble = %+v", last)
	}

	// Somebody outside the group sees none of it.
	var other struct {
		ID string `json:"id"`
	}
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/call", `{"dev":"owner-page-1"}`, 201, &other)
	f.call(t, f.owner, "PATCH", "/api/chat/groups/"+g.ID, `{"members":["`+f.ids["Carmen"]+`"]}`, 200, nil)
	if w := wait("Luis", "luis-page-1"); len(w.Calls) != 0 {
		t.Fatalf("Luis, out of the group, sees %+v", w.Calls)
	}
	f.call(t, who["Luis"], "POST", prefix("Luis")+"/call/"+other.ID+"/answer", `{"dev":"luis-page-1"}`, 404, nil)
}
