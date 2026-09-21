package main

// =============================================================================
// The Android app's phones (devices.go): enrolment, the long poll, finds,
// positions, calls, and the two pushes a phone with the app does not need.
// =============================================================================

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const phoneToken = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-abcdef" // what the app makes: base64url

type phoneState struct {
	V     string         `json:"v"`
	Hold  int            `json:"hold"`
	Track bool           `json:"track"`
	Badge int            `json:"badge"`
	Call  *deviceCallOut `json:"call"`
	Find  *deviceFindOut `json:"find"`
}

// phone is a request as the app makes it: the token in the header.
func phone(t *testing.T, base, method, path, token, body string) (int, []byte) {
	t.Helper()
	var rd *strings.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, base+path, nil)
	if rd != nil {
		req, _ = http.NewRequest(method, base+path, rd)
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set(deviceHeader, token)
	}
	resp, err := anonymous().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp.StatusCode, readBody(t, resp)
}

func phoneWait(t *testing.T, base, token, v string) phoneState {
	t.Helper()
	code, raw := phone(t, base, "GET", "/api/device/wait?v="+v, token, "")
	if code != http.StatusOK {
		t.Fatalf("wait = %d %s", code, raw)
	}
	var st phoneState
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatalf("wait JSON: %v %s", err, raw)
	}
	return st
}

func jsonCall(t *testing.T, client *http.Client, method, url, body string, want int, out any) {
	t.Helper()
	var rd *strings.Reader
	if body == "" {
		rd = strings.NewReader("")
	} else {
		rd = strings.NewReader(body)
	}
	resp := do(t, client, method, url, rd, map[string]string{"Content-Type": "application/json"})
	raw := readBody(t, resp)
	if resp.StatusCode != want {
		t.Fatalf("%s %s = %d, want %d: %s", method, url, resp.StatusCode, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("%s %s: bad JSON %v: %s", method, url, err, raw)
		}
	}
}

type deviceListOut struct {
	Devices []deviceOut  `json:"devices"`
	Finds   []deviceFind `json:"finds"`
	Last    *lastPos     `json:"last"`
	Push    int          `json:"push"`
}

// enrolPhone signs ana in (the fixture) and enrols the phone token.
func enrolPhone(t *testing.T, client *http.Client, base string) string {
	t.Helper()
	var out struct{ ID string }
	jsonCall(t, client, "POST", base+"/api/device/enrol",
		`{"t":"`+phoneToken+`","name":"Pixel\u0007 8"}`, 200, &out)
	if out.ID == "" {
		t.Fatal("enrol gave no id")
	}
	return out.ID
}

func TestDeviceEnrolAndRevoke(t *testing.T) {
	srv, ts, client := newTestServer(t)
	base := ts.URL

	// Not enrolled: the app is told so, and nothing else.
	if code, _ := phone(t, base, "GET", "/api/device/wait", phoneToken, ""); code != http.StatusUnauthorized {
		t.Fatalf("unknown token = %d, want 401", code)
	}
	if code, _ := phone(t, base, "GET", "/api/device/wait", "", ""); code != http.StatusUnauthorized {
		t.Fatalf("no token = %d, want 401", code)
	}
	// Enrolling needs a session...
	resp := do(t, anonymous(), "POST", base+"/api/device/enrol", strings.NewReader(`{"t":"`+phoneToken+`"}`), nil)
	if readBody(t, resp); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("enrol without a session = %d", resp.StatusCode)
	}
	signIn(t, client, base, "ana", "abc")
	// ...and a real token.
	jsonCall(t, client, "POST", base+"/api/device/enrol", `{"t":"short"}`, 400, nil)
	jsonCall(t, client, "POST", base+"/api/device/enrol", `{"t":"`+strings.Repeat("é", 40)+`"}`, 400, nil)

	id := enrolPhone(t, client, base)
	// Enrolling again is a refresh, not a second phone.
	var again struct{ ID string }
	jsonCall(t, client, "POST", base+"/api/device/enrol", `{"t":"`+phoneToken+`","name":"Pixel 8"}`, 200, &again)
	if again.ID != id {
		t.Fatalf("re-enrol made a new phone: %s != %s", again.ID, id)
	}
	var list deviceListOut
	jsonCall(t, client, "GET", base+"/api/device", "", 200, &list)
	if len(list.Devices) != 1 || list.Devices[0].Name != "Pixel 8" || !list.Devices[0].Online {
		t.Fatalf("list = %+v", list.Devices)
	}

	// Only the hash is on disk, never the token.
	raw, _ := os.ReadFile(filepath.Join(srv.cfg.ConfigDir, "devices.json"))
	if strings.Contains(string(raw), phoneToken) || !strings.Contains(string(raw), tokenHash(phoneToken)) {
		t.Fatalf("devices.json = %s", raw)
	}

	st := phoneWait(t, base, phoneToken, "")
	if st.V == "" || st.Hold != int(deviceHold/time.Second) || st.Track || st.Call != nil || st.Find != nil {
		t.Fatalf("first wait = %+v", st)
	}

	// Revoked: the token is dead.
	jsonCall(t, client, "DELETE", base+"/api/device/"+id, "", 204, nil)
	if code, _ := phone(t, base, "GET", "/api/device/wait", phoneToken, ""); code != http.StatusUnauthorized {
		t.Fatalf("revoked token = %d, want 401", code)
	}
	jsonCall(t, client, "DELETE", base+"/api/device/"+id, "", 404, nil)
}

// TestDeviceWaitHolds: the same version waits; a change answers at once.
func TestDeviceWaitHolds(t *testing.T) {
	old := deviceHold
	deviceHold = 700 * time.Millisecond
	t.Cleanup(func() { deviceHold = old })

	_, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	id := enrolPhone(t, client, base)
	st := phoneWait(t, base, phoneToken, "")

	// Nothing changes: held until `hold`, then the same answer.
	start := time.Now()
	same := phoneWait(t, base, phoneToken, st.V)
	if took := time.Since(start); took < 600*time.Millisecond || same.V != st.V {
		t.Fatalf("an unchanged wait answered after %v with %+v", took, same)
	}

	// "Buscar mi móvil" while it waits: it answers at once, with the find.
	deviceHold = 5 * time.Second
	done := make(chan phoneState, 1)
	go func() { done <- phoneWait(t, base, phoneToken, st.V) }()
	time.Sleep(150 * time.Millisecond)
	var started struct{ Find deviceFind }
	jsonCall(t, client, "POST", base+"/api/device/find", `{"id":"`+id+`"}`, 200, &started)
	select {
	case got := <-done:
		if got.Find == nil || got.Find.ID != started.Find.ID {
			t.Fatalf("woken wait = %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the wait did not wake for the find")
	}
}

func TestDeviceFind(t *testing.T) {
	_, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	id := enrolPhone(t, client, base)

	jsonCall(t, client, "POST", base+"/api/device/find", `{"id":"nope"}`, 404, nil)
	var a, b struct{ Find deviceFind }
	jsonCall(t, client, "POST", base+"/api/device/find", `{"id":"`+id+`"}`, 200, &a)
	jsonCall(t, client, "POST", base+"/api/device/find", `{"id":"`+id+`"}`, 200, &b)
	if a.Find.ID == "" || a.Find.ID != b.Find.ID || a.Find.State != "ringing" {
		t.Fatalf("finds = %+v, %+v (pressing twice must be one find)", a.Find, b.Find)
	}
	st := phoneWait(t, base, phoneToken, "")
	if st.Find == nil || st.Find.ID != a.Find.ID {
		t.Fatalf("the phone was not told: %+v", st)
	}

	// The phone reports where it is, then the user stops it there.
	code, raw := phone(t, base, "POST", "/api/device/report", phoneToken,
		`{"find":"`+a.Find.ID+`","positions":[{"lat":36.5101234,"lon":-4.8823456,"acc":8.4,"at":`+
			itoa(int(time.Now().Unix()))+`}]}`)
	if code != http.StatusOK {
		t.Fatalf("report = %d %s", code, raw)
	}
	code, raw = phone(t, base, "POST", "/api/device/ack", phoneToken, `{"find":"`+a.Find.ID+`","act":"stop"}`)
	if code != http.StatusOK {
		t.Fatalf("ack = %d %s", code, raw)
	}
	if st2 := phoneWait(t, base, phoneToken, st.V); st2.Find != nil {
		t.Fatalf("a stopped find still rings: %+v", st2)
	}

	var list deviceListOut
	jsonCall(t, client, "GET", base+"/api/device", "", 200, &list)
	if len(list.Finds) != 1 || list.Finds[0].State != "stopped" || list.Finds[0].Pos == nil ||
		list.Finds[0].Pos.Lat != 36.51012 || list.Finds[0].Pos.Acc != 9 {
		t.Fatalf("finds = %+v", list.Finds)
	}
	// ...and it is the last position too, at ~1 m, with no trip at all.
	if list.Last == nil || list.Last.Lat != 36.51012 || list.Last.Lon != -4.88235 || list.Last.Source != "nayive" {
		t.Fatalf("last = %+v", list.Last)
	}

	// Stopped from the web instead: the phone is told.
	jsonCall(t, client, "POST", base+"/api/device/find", `{"id":"`+id+`"}`, 200, &a)
	jsonCall(t, client, "POST", base+"/api/device/find/"+a.Find.ID+"/stop", "", 200, nil)
	if st3 := phoneWait(t, base, phoneToken, ""); st3.Find != nil {
		t.Fatalf("a cancelled find still rings: %+v", st3)
	}
	jsonCall(t, client, "POST", base+"/api/device/find/nope/stop", "", 404, nil)
}

func TestDeviceFindTimesOut(t *testing.T) {
	old := findRing
	findRing = 300 * time.Millisecond
	t.Cleanup(func() { findRing = old })

	_, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	id := enrolPhone(t, client, base)
	jsonCall(t, client, "POST", base+"/api/device/find", `{"id":"`+id+`"}`, 200, nil)
	st := phoneWait(t, base, phoneToken, "")
	if st.Find == nil {
		t.Fatal("not ringing")
	}
	// The wait wakes by itself when the ringing times out.
	start := time.Now()
	st2 := phoneWait(t, base, phoneToken, st.V)
	if st2.Find != nil || time.Since(start) > 2*time.Second {
		t.Fatalf("after the timeout: %+v in %v", st2, time.Since(start))
	}
	var list deviceListOut
	jsonCall(t, client, "GET", base+"/api/device", "", 200, &list)
	if len(list.Finds) != 1 || list.Finds[0].State != "timeout" {
		t.Fatalf("finds = %+v", list.Finds)
	}
}

// TestDeviceTrackAndPositions: "track" follows the trip's days; positions land
// in the trip (rounded) AND as the last position (not rounded).
func TestDeviceTrackAndPositions(t *testing.T) {
	srv, base, client, _ := makeLink(t) // ana, with a trip from yesterday to in 3 days
	enrolPhone(t, client, base)
	if st := phoneWait(t, base, phoneToken, ""); !st.Track {
		t.Fatalf("a trip covers today, track = false: %+v", st)
	}

	at := time.Now().Add(-time.Minute).Unix()
	code, raw := phone(t, base, "POST", "/api/device/report", phoneToken,
		`{"positions":[{"lat":38.7222521,"lon":-9.1393371,"acc":30,"at":`+itoa(int(at))+`},{"lat":null}]}`)
	if code != http.StatusOK || !strings.Contains(string(raw), `"saved":1`) {
		t.Fatalf("report = %d %s", code, raw)
	}
	tripDir := filepath.Join(srv.cfg.HomesDir, "ana", publicTripDir)
	l := readPositionsDoc(tripDir).Latest
	if l == nil || l.Source != "nayive" || l.Lat != 38.722 || l.Lon != -9.139 {
		t.Fatalf("trip latest = %+v", l)
	}
	last := srv.devices.Last("ana")
	if last == nil || last.Lat != 38.72225 || last.Lon != -9.13934 || last.At != at {
		t.Fatalf("last = %+v", last)
	}
	// An older position never replaces a newer last one.
	srv.devices.NoteLast("ana", lastPos{Lat: 1, Lon: 1, At: at - 100, Source: "photo"})
	if last2 := srv.devices.Last("ana"); last2.Lat != 38.72225 {
		t.Fatalf("an older position won: %+v", last2)
	}

	// The trip is over: track goes off.
	writeTripDates(t, srv, -10, -5)
	srv.devices.mu.Lock()
	delete(srv.devices.trips, "ana") // the minute's cache
	srv.devices.mu.Unlock()
	if st := phoneWait(t, base, phoneToken, ""); st.Track {
		t.Fatalf("no trip today, track = true")
	}
}

// TestDeviceHere: a browser's own position (the iPhone's answer to "¿Dónde estás?").
func TestDeviceHere(t *testing.T) {
	srv, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	var asked struct {
		Find  deviceFind
		Asked int
	}
	jsonCall(t, client, "POST", base+"/api/device/find", `{"ask":true}`, 200, &asked)
	if asked.Find.State != "asked" || asked.Asked != 0 {
		t.Fatalf("ask = %+v", asked)
	}
	jsonCall(t, client, "POST", base+"/api/device/here", `{"lat":999,"lon":1}`, 400, nil)
	jsonCall(t, client, "POST", base+"/api/device/here",
		`{"lat":40.4167754,"lon":-3.7037902,"acc":12,"find":"`+asked.Find.ID+`"}`, 200, nil)
	var list deviceListOut
	jsonCall(t, client, "GET", base+"/api/device", "", 200, &list)
	if list.Last == nil || list.Last.Source != "browser" || list.Last.Lat != 40.41678 {
		t.Fatalf("last = %+v", list.Last)
	}
	if len(list.Finds) != 1 || list.Finds[0].Pos == nil || list.Finds[0].Pos.Lon != -3.70379 {
		t.Fatalf("finds = %+v", list.Finds)
	}
	// Old positions are forgotten.
	srv.devices.NoteLast("ana", lastPos{Lat: 1, Lon: 1, At: time.Now().Add(-lastPosTTL - time.Hour).Unix()})
	os.WriteFile(srv.devices.lastPath("ana"), []byte(`{"lat":1,"lon":1,"at":1000}`), 0o644)
	if srv.devices.Last("ana") != nil {
		t.Fatal("a position older than lastPosTTL is still shown")
	}
}

// TestDeviceCall: a call to the owner rings the phone; "Rechazar" on the phone
// declines it; the Chrome inside the phone does not ring it a second time.
func TestDeviceCall(t *testing.T) {
	f := newCallFixture(t)
	h := f.srv.chat

	// ana's phone, whose TWA's Chrome also has notifications on.
	key, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	p256 := base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes())
	au := base64.RawURLEncoding.EncodeToString(auth)
	f.srv.users.AddPushSub("ana", "https://push.example/phone", p256, au, "es", "", nil)
	f.srv.users.AddPushSub("ana", "https://push.example/laptop", p256, au, "es", "", nil)
	jsonCall(t, f.owner, "POST", f.base+"/api/device/enrol",
		`{"t":"`+phoneToken+`","name":"Pixel","endpoint":"https://push.example/phone"}`, 200, nil)
	st := phoneWait(t, f.base, phoneToken, "")

	dc := "d-" + f.ids["Carmen"]
	var s struct{ ID string }
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/conv/"+dc+"/call", `{"dev":"carmen-page-1"}`, 201, &s)

	got := phoneWait(t, f.base, phoneToken, st.V)
	if got.Call == nil || got.Call.ID != s.ID || got.Call.From != "Carmen" ||
		got.Call.URL != "/nayive/chat/?c="+dc || got.Call.Until <= time.Now().UnixMilli() {
		t.Fatalf("the phone was not rung: %+v", got)
	}

	// The ring skips the phone's Chrome (the app rings); "missed" does not.
	h.mu.Lock()
	o := h.owner("ana")
	c := o.cs().byID[s.ID]
	ring := h.callPushes(o, c, "ring")
	missed := h.callPushes(o, c, "missed")
	h.mu.Unlock()
	if len(ring) != 1 || ring[0].sub.Endpoint != "https://push.example/laptop" {
		t.Fatalf("ring pushes = %+v", ring)
	}
	if len(missed) != 2 {
		t.Fatalf("missed pushes = %d, want 2", len(missed))
	}
	// (missed ended the phone's ring in the hub's hook: ring it again.)
	h.mu.Lock()
	h.callPushes(o, c, "ring")
	h.mu.Unlock()

	code, raw := phone(t, f.base, "POST", "/api/device/ack", phoneToken, `{"call":"`+s.ID+`","act":"decline"}`)
	if code != http.StatusOK {
		t.Fatalf("decline = %d %s", code, raw)
	}
	h.mu.Lock()
	state, reason := c.State, c.Reason
	h.mu.Unlock()
	if state != "ended" || reason != "decline" {
		t.Fatalf("after Rechazar: %s/%s", state, reason)
	}
	if after := phoneWait(t, f.base, phoneToken, ""); after.Call != nil {
		t.Fatalf("a declined call still rings the phone: %+v", after)
	}
	code, _ = phone(t, f.base, "POST", "/api/device/ack", phoneToken, `{"act":"dance"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("a nonsense ack = %d", code)
	}
}

// TestDevicePushFilters: what the phone's Chrome is spared, and what it is not.
func TestDevicePushFilters(t *testing.T) {
	dir := t.TempDir()
	d := NewDevices(dir, dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	id, err := d.Enrol("ana", phoneToken, "Pixel", "https://push.example/phone", 3)
	if err != nil || id == "" {
		t.Fatalf("enrol: %v", err)
	}
	if !d.HasApp("ana", "https://push.example/phone") || d.HasApp("ana", "https://push.example/other") ||
		d.HasApp("bea", "https://push.example/phone") {
		t.Fatal("HasApp is wrong")
	}
	if !d.SkipCallPush("ana", "https://push.example/phone") {
		t.Fatal("an online phone's Chrome should not ring the call too")
	}
	// Not seen for a while: its Chrome rings after all (the app may be dead).
	d.mu.Lock()
	d.seen[id] = time.Now().Add(-time.Hour).Unix()
	d.rows[0].Seen = d.seen[id]
	d.mu.Unlock()
	if d.SkipCallPush("ana", "https://push.example/phone") {
		t.Fatal("a phone not seen for an hour still swallows the ring")
	}

	d.RenameUser("ana", "anabel")
	if len(d.List("ana")) != 0 || len(d.List("anabel")) != 1 {
		t.Fatal("rename did not move the phone")
	}
	d.DropUser("anabel")
	if len(d.List("anabel")) != 0 || d.ByToken(phoneToken) != nil {
		t.Fatal("drop did not forget the phone")
	}

	for i := 0; i < devicesMax; i++ {
		if _, err := d.Enrol("bea", phoneToken+strings.Repeat("x", i+1), "", "", 0); err != nil {
			t.Fatalf("phone %d: %v", i, err)
		}
	}
	if _, err := d.Enrol("bea", phoneToken+"-one-too-many", "", "", 0); err != errTooManyDevices {
		t.Fatalf("phone %d = %v, want errTooManyDevices", devicesMax+1, err)
	}
}

func TestAssetLinks(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	resp := do(t, anonymous(), "GET", ts.URL+"/.well-known/assetlinks.json", nil, nil)
	if readBody(t, resp); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("no file = %d, want 404", resp.StatusCode)
	}
	body := `[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"org.nayive.app","sha256_cert_fingerprints":["AB:CD"]}}]`
	os.WriteFile(filepath.Join(srv.cfg.ConfigDir, "assetlinks.json"), []byte(body), 0o600)
	resp = do(t, anonymous(), "GET", ts.URL+"/.well-known/assetlinks.json", nil, nil)
	raw := readBody(t, resp)
	if resp.StatusCode != http.StatusOK || string(raw) != body ||
		!strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("assetlinks = %d %q %s", resp.StatusCode, resp.Header.Get("Content-Type"), raw)
	}
}
