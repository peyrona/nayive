package main

// =============================================================================
// Notifications through the Android app (push_app.go): no Google in between.
// =============================================================================

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const chromeInPhone = "https://fcm.googleapis.com/fcm/send/the-phones-chrome"

type notesState struct {
	V     string       `json:"v"`
	Notes []deviceNote `json:"notes"`
}

// appWait is the phone's wait as the app makes it: the token, its versionCode,
// its zone and language.
func appWait(t *testing.T, base string, code, v string) notesState {
	t.Helper()
	req, _ := http.NewRequest("GET", base+"/api/device/wait?v="+v+"&tz=Europe/Lisbon&lang=pt", nil)
	req.Header.Set(deviceHeader, phoneToken)
	req.Header.Set("X-Nayive-App", code)
	resp, err := anonymous().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw := readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("wait = %d %s", resp.StatusCode, raw)
	}
	var st notesState
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatalf("wait JSON: %v %s", err, raw)
	}
	return st
}

func TestPushThroughTheApp(t *testing.T) {
	shortHold(t)
	srv, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	var enrolled struct{ ID string }
	jsonCall(t, client, "POST", base+"/api/device/enrol",
		`{"t":"`+phoneToken+`","name":"Pixel","endpoint":"`+chromeInPhone+`"}`, 200, &enrolled)
	id := enrolled.ID

	laptop := testSub(t, "https://updates.push.services.mozilla.com/wpush/v2/laptop")
	chrome := testSub(t, chromeInPhone)
	for _, s := range []PushSub{laptop, chrome} {
		if got := srv.users.AddPushSub("ana", s.Endpoint, s.Keys.P256dh, s.Keys.Auth, "fr", "", nil); got != "added" {
			t.Fatalf("AddPushSub = %s", got)
		}
	}

	// An older APK shows nothing itself: web push as before.
	appWait(t, base, "5", "")
	if subs := srv.users.PushTargets("ana"); len(subs) != 2 {
		t.Fatalf("with APK 5: %d targets, want push.json's 2", len(subs))
	}

	// From appNotesMin: the phone instead of its Chrome, in that Chrome's words
	// and the phone's own zone. The laptop is not touched.
	st := appWait(t, base, "6", "")
	if len(st.Notes) != 0 {
		t.Fatalf("notes before any push: %+v", st.Notes)
	}
	subs := srv.users.PushTargets("ana")
	var app PushSub
	for _, s := range subs {
		if s.Endpoint == chromeInPhone {
			t.Fatal("the Chrome inside the phone is still a target: two notifications")
		}
		if s.Endpoint == appEndpoint+id {
			app = s
		}
	}
	if len(subs) != 2 || app.Endpoint == "" || app.Lang != "fr" || app.TZ != "Europe/Lisbon" {
		t.Fatalf("targets = %+v", subs)
	}
	if !srv.devices.HasApp("ana", app.Endpoint) {
		t.Fatal("the app's target needs no 'turn location on' alert either")
	}
	if len(srv.users.UserPush("ana").Subs) != 2 {
		t.Fatal("push.json itself changed")
	}

	// A push to it lands in the phone's wait, through the one sender all use.
	send := func(payload map[string]any) int {
		status, _ := deliverPush(srv.push, srv.users, quietLog(), "ana", app, payload, 600)
		return status
	}
	if got := send(map[string]any{"title": "Cita", "body": "10:30", "url": "/nayive/calendar/", "tag": "ev1"}); got != 201 {
		t.Fatalf("send = %d", got)
	}
	send(map[string]any{"title": "Luis", "body": "hola", "url": "/nayive/chat/?c=x", "tag": "chat-x", "quiet": true})
	send(map[string]any{"title": "Cita", "body": "10:45", "url": "https://evil.example/", "tag": "ev1"}) // replaces ev1
	st = appWait(t, base, "6", st.V)
	if len(st.Notes) != 2 {
		t.Fatalf("notes = %+v, want 2 (the same tag replaces)", st.Notes)
	}
	chat, ev := st.Notes[0], st.Notes[1]
	if chat.Title != "Luis" || !chat.Quiet || chat.URL != "/nayive/chat/?c=x" {
		t.Fatalf("chat note = %+v", chat)
	}
	if ev.Body != "10:45" || ev.URL != "/nayive/" || ev.ID <= chat.ID {
		t.Fatalf("event note = %+v (a foreign URL must not reach the app)", ev)
	}

	// Acked: gone, and only up to what the phone showed.
	jsonCall(t, anonymousWith(phoneToken), "POST", base+"/api/device/ack",
		`{"notes":`+itoa(int(chat.ID))+`}`, 200, nil)
	if left := srv.devices.notesFor(id); len(left) != 1 || left[0].ID != ev.ID {
		t.Fatalf("after ack: %+v", left)
	}

	// Revoked: the sender is told the target is gone, as for a dead subscription.
	jsonCall(t, client, "DELETE", base+"/api/device/"+id, "", 204, nil)
	if got := send(map[string]any{"title": "x"}); got != http.StatusGone {
		t.Fatalf("send to a revoked phone = %d, want 410", got)
	}
	if subs := srv.users.PushTargets("ana"); len(subs) != 2 || strings.HasPrefix(subs[1].Endpoint, appEndpoint) {
		t.Fatalf("after revoke: %+v", subs)
	}
}

// anonymousWith is a client that sends the app's token on every request.
func anonymousWith(token string) *http.Client {
	c := *anonymous()
	base := c.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	c.Transport = tokenTransport{token: token, base: base}
	return &c
}

type tokenTransport struct {
	token string
	base  http.RoundTripper
}

func (t tokenTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set(deviceHeader, t.token)
	return t.base.RoundTrip(r)
}
