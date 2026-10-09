package main

// =============================================================================
// Chat "watch together" (chat_watch.go): who may start and move a video, what
// the wait carries, and when it goes.
// =============================================================================

import (
	"testing"
	"time"
)

type watchWait struct {
	V     int64                 `json:"v"`
	Now   int64                 `json:"now"`
	Watch map[string]*chatWatch `json:"watch"`
}

func TestChatWatch(t *testing.T) {
	f := newChatFixture(t)
	carmen, javi := anonymous(), anonymous()
	cp, jp := "/api/c/"+f.carmen, "/api/c/"+f.javi

	var g struct{ ID string }
	f.call(t, f.owner, "POST", "/api/chat/groups",
		`{"name":"Karaoke","members":["`+f.ids["Carmen"]+`"]}`, 201, &g)
	conv := "g-" + g.ID
	var m chatMsgOut
	f.call(t, carmen, "POST", cp+"/conv/"+conv+"/messages",
		`{"kind":"text","text":"esta: https://youtu.be/dQw4w9WgXcQ?t=3"}`, 201, &m)
	msg := itoa(int(m.ID))
	play := `{"msg":` + msg + `,"video":"dQw4w9WgXcQ","state":"play","pos":3}`

	// Not her message, a bad id, a video not in the message, an unknown state.
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/watch", play, 403, nil)
	f.call(t, carmen, "POST", cp+"/conv/"+conv+"/watch", `{"msg":`+msg+`,"video":"bad","state":"play"}`, 400, nil)
	f.call(t, carmen, "POST", cp+"/conv/"+conv+"/watch", `{"msg":`+msg+`,"video":"AAAAAAAAAAA","state":"play"}`, 400, nil)
	f.call(t, carmen, "POST", cp+"/conv/"+conv+"/watch", `{"msg":`+msg+`,"video":"dQw4w9WgXcQ","state":"loud"}`, 400, nil)
	// Javi is not in the group.
	f.call(t, javi, "POST", jp+"/conv/"+conv+"/watch", play, 403, nil)

	before := time.Now().UnixMilli()
	f.call(t, carmen, "POST", cp+"/conv/"+conv+"/watch", play, 204, nil)

	// The owner's wait carries it, with the server's clock.
	var ow watchWait
	f.call(t, f.owner, "GET", "/api/chat/wait?v=-1", "", 200, &ow)
	cw := ow.Watch[conv]
	if cw == nil || cw.Video != "dQw4w9WgXcQ" || !cw.Playing || cw.Pos != 3 || cw.By != f.ids["Carmen"] || cw.At < before {
		t.Fatalf("owner sees %+v", ow.Watch)
	}
	if ow.Now < cw.At {
		t.Fatalf("now %d before at %d", ow.Now, cw.At)
	}
	// Javi's wait does not.
	var jw watchWait
	f.call(t, javi, "GET", jp+"/wait?v=-1", "", 200, &jw)
	if len(jw.Watch) != 0 {
		t.Fatalf("Javi sees %+v", jw.Watch)
	}

	// Only Carmen moves it; the owner cannot pause or stop it, nor put another on.
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/watch", `{"msg":`+msg+`,"video":"dQw4w9WgXcQ","state":"pause","pos":9}`, 403, nil)
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/watch", `{"state":"stop"}`, 403, nil)
	var om chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"kind":"text","text":"https://www.youtube.com/watch?v=9bZkp7q19f0"}`, 201, &om)
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/watch",
		`{"msg":`+itoa(int(om.ID))+`,"video":"9bZkp7q19f0","state":"play","pos":0}`, 409, nil)

	f.call(t, carmen, "POST", cp+"/conv/"+conv+"/watch", `{"msg":`+msg+`,"video":"dQw4w9WgXcQ","state":"pause","pos":42.5}`, 204, nil)
	f.call(t, f.owner, "GET", "/api/chat/wait?v=-1", "", 200, &ow)
	if cw := ow.Watch[conv]; cw == nil || cw.Playing || cw.Pos != 42.5 {
		t.Fatalf("after pause %+v", ow.Watch)
	}

	// Left paused too long: the sweep drops it.
	h := f.srv.chat
	h.mu.Lock()
	o := h.owners["ana"]
	o.watch[conv].touched = time.Now().Add(-chatWatchIdle - time.Second)
	if !o.watchTick(time.Now()) || len(o.watch) != 0 {
		t.Fatal("a paused video outlived chatWatchIdle")
	}
	h.mu.Unlock()

	// Stop: gone for everybody.
	f.call(t, carmen, "POST", cp+"/conv/"+conv+"/watch", play, 204, nil)
	f.call(t, carmen, "POST", cp+"/conv/"+conv+"/watch", `{"state":"stop"}`, 204, nil)
	var after watchWait // a fresh one: decoding merges into a map already there
	f.call(t, f.owner, "GET", "/api/chat/wait?v=-1", "", 200, &after)
	if len(after.Watch) != 0 {
		t.Fatalf("after stop %+v", after.Watch)
	}
}
