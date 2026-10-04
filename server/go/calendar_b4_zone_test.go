package main

// =============================================================================
// Batch 4 part 3 (apps-2 #55, contract C): a floating calendar event rings at
// the wall clock of each DEVICE's own zone - the time its calendar shows - and
// a device with no zone of its own uses the account's, as before.
// =============================================================================

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// zoneRingService is a fake push service that records which device (the
// last part of its endpoint path) each message went to.
func zoneRingService(t *testing.T, srv *Server) func() []string {
	t.Helper()
	var mu sync.Mutex
	var got []string
	service := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:])
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(service.Close)
	tr := service.Client().Transport.(*http.Transport).Clone()
	tr.TLSClientConfig.InsecureSkipVerify = true
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, service.Listener.Addr().String())
	}
	srv.push.client = &http.Client{Transport: tr, Timeout: pushTimeout}
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := append([]string(nil), got...)
		sort.Strings(out)
		got = nil
		return out
	}
}

func zoneLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Skip("no tzdata:", err)
	}
	return loc
}

// TestFloatingEventRingsInEachDeviceZone: three devices - Tokyo, New York, and
// one with no zone (the account is in Madrid). A floating event at "now + 5
// min" on Tokyo's clock rings Tokyo only; the same on New York's clock rings
// New York only; on Madrid's clock, the zoneless device only. A daily
// floating series that began a month ago rings each day, Tokyo's, twice
// running. A pinned (UTC) event rings all three.
func TestFloatingEventRingsInEachDeviceZone(t *testing.T) {
	srv, _, _ := newTestServer(t)
	cfg := srv.cfg
	sent := zoneRingService(t, srv)
	tokyo, ny, mad := zoneLoc(t, "Asia/Tokyo"), zoneLoc(t, "America/New_York"), zoneLoc(t, "Europe/Madrid")

	if _, ok := srv.users.SetUserTZ("user", "ana", "Europe/Madrid"); !ok {
		t.Fatal("cannot set the account zone")
	}
	data := filepath.Join(cfg.HomesDir, "ana", "data")
	subT := testSub(t, "https://fcm.googleapis.com/fcm/send/tokyo")
	subT.TZ = "Asia/Tokyo"
	subN := testSub(t, "https://fcm.googleapis.com/fcm/send/newyork")
	subN.TZ = "America/New_York"
	subM := testSub(t, "https://fcm.googleapis.com/fcm/send/nozone")
	raw, _ := json.Marshal(map[string]any{"subs": []PushSub{subT, subN, subM}, "window_minutes": 15})
	os.WriteFile(filepath.Join(data, "push.json"), raw, 0o644)

	log := quietLog()
	r := NewReminders(cfg, srv.users, srv.trash, srv.sessions, srv.push, srv.trackers, log)

	ring := func(name, vevent string) []string {
		ics := "BEGIN:VCALENDAR\r\n" + vevent + "END:VCALENDAR\r\n"
		path := filepath.Join(data, "calendar.ics")
		os.WriteFile(path, []byte(ics), 0o644)
		// A new mtime each time, or the cache keeps the last file.
		stamp := time.Now().Add(time.Duration(len(name)) * time.Second)
		os.Chtimes(path, stamp, stamp)
		r.tick()
		return sent()
	}
	floating := func(uid string, loc *time.Location, extra string) string {
		wall := time.Now().Add(5 * time.Minute).In(loc)
		return "BEGIN:VEVENT\r\nUID:" + uid + "\r\nSUMMARY:x\r\nDTSTART:" + wall.Format("20060102T150405") +
			"\r\n" + extra + "END:VEVENT\r\n"
	}

	cases := []struct {
		name, vevent string
		want         []string
	}{
		{"floating on Tokyo's clock", floating("t", tokyo, ""), []string{"tokyo"}},
		{"floating on New York's clock", floating("n", ny, ""), []string{"newyork"}},
		{"floating on the account's clock", floating("m", mad, ""), []string{"nozone"}},
		{"pinned in UTC", "BEGIN:VEVENT\r\nUID:u\r\nSUMMARY:x\r\nDTSTART:" +
			time.Now().Add(5*time.Minute).UTC().Format("20060102T150405Z") + "\r\nEND:VEVENT\r\n",
			[]string{"newyork", "nozone", "tokyo"}},
	}
	for _, c := range cases {
		if got := ring(c.name, c.vevent); strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("%s: rang %v, want %v", c.name, got, c.want)
		}
	}

	// A daily floating series, a month old, on Tokyo's clock: today's rings.
	wall := time.Now().Add(5*time.Minute).In(tokyo).AddDate(0, 0, -30)
	series := "BEGIN:VEVENT\r\nUID:daily\r\nSUMMARY:x\r\nDTSTART:" + wall.Format("20060102T150405") +
		"\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\n"
	if got := ring("daily series", series); strings.Join(got, ",") != "tokyo" {
		t.Errorf("daily floating series: rang %v, want [tokyo]", got)
	}
	// Tomorrow's occurrence is the same series: its start, read on Tokyo's
	// clock, is exactly one day after today's.
	evs := ParseEvents("BEGIN:VCALENDAR\r\n"+series+"END:VCALENDAR\r\n", tokyo)
	now := time.Now()
	starts := evs[0].StartsBetween(now, now.Add(49*time.Hour))
	if len(starts) < 2 || starts[1].Sub(starts[0]) != 24*time.Hour {
		t.Errorf("daily floating series: starts %v, want one a day", starts)
	}
}

// TestPushSubscriptionKeepsItsZone: POST /api/push stores "tz"; a re-post
// without one keeps it; a renewal (old_endpoint) carries it over; a zone the
// server cannot load is ignored.
func TestPushSubscriptionKeepsItsZone(t *testing.T) {
	srv, ts, client := newTestServer(t)
	p256, au := testPushKeys(t)
	const one, two = "https://fcm.googleapis.com/fcm/send/one", "https://fcm.googleapis.com/fcm/send/two"
	signIn(t, client, ts.URL, "ana", "abc")

	post := func(endpoint, extra string) {
		jsonCall(t, client, "POST", ts.URL+"/api/push",
			`{"subscription":{"endpoint":"`+endpoint+`","keys":{"p256dh":"`+p256+`","auth":"`+au+`"}},`+
				`"lang":"es","label":"x"`+extra+`}`, 200, nil)
	}
	zone := func(endpoint string) string {
		if s := pushRenewFind(srv.users.UserPush("ana").Subs, endpoint); s != nil {
			return s.TZ
		}
		return "<gone>"
	}

	post(one, `,"tz":"Asia/Tokyo"`)
	if z := zone(one); z != "Asia/Tokyo" {
		t.Fatalf("after the first post: tz %q, want Asia/Tokyo", z)
	}
	post(one, ``)
	if z := zone(one); z != "Asia/Tokyo" {
		t.Errorf("a re-post without tz: %q, want it kept", z)
	}
	post(one, `,"tz":"Mars/Olympus"`)
	if z := zone(one); z != "Asia/Tokyo" {
		t.Errorf("an unknown zone: %q, want the old one kept", z)
	}
	post(two, `,"old_endpoint":"`+one+`"`)
	if z1, z2 := zone(one), zone(two); z1 != "<gone>" || z2 != "Asia/Tokyo" {
		t.Errorf("renewal: old %q new %q, want <gone> / Asia/Tokyo", z1, z2)
	}
	post(two, `,"tz":"America/New_York"`)
	if z := zone(two); z != "America/New_York" {
		t.Errorf("a move: %q, want America/New_York", z)
	}
}

// TestRenewalDoesNotRingTwice (review): the browser renews its subscription
// between two ticks; the occurrence already rung is not rung again on the new
// endpoint. A zone no device is in any more leaves the calendar cache.
func TestRenewalDoesNotRingTwice(t *testing.T) {
	srv, _, _ := newTestServer(t)
	cfg := srv.cfg
	sent := zoneRingService(t, srv)
	p256, au := testPushKeys(t)
	const old, fresh = "https://fcm.googleapis.com/fcm/send/old", "https://fcm.googleapis.com/fcm/send/new"
	srv.users.AddPushSub("ana", old, p256, au, "es", "Móvil", nil)
	srv.users.SetPushSubTZ("ana", old, "Asia/Tokyo")

	data := filepath.Join(cfg.HomesDir, "ana", "data")
	wall := time.Now().Add(5 * time.Minute).In(zoneLoc(t, "Asia/Tokyo"))
	os.WriteFile(filepath.Join(data, "calendar.ics"), []byte("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e\r\nSUMMARY:x\r\nDTSTART:"+
		wall.Format("20060102T150405")+"\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"), 0o644)

	log := quietLog()
	r := NewReminders(cfg, srv.users, srv.trash, srv.sessions, srv.push, srv.trackers, log)
	r.tick()
	if got := sent(); strings.Join(got, ",") != "old" {
		t.Fatalf("first tick: %v, want [old]", got)
	}
	srv.users.RenewPushSub("ana", old, fresh, p256, au, "", "", nil)
	r.tick()
	if got := sent(); len(got) != 0 {
		t.Errorf("after the renewal: rang %v again", got)
	}

	// The device moves to New York: Tokyo's parsed calendar is dropped.
	srv.users.SetPushSubTZ("ana", fresh, "America/New_York")
	r.tick()
	for k := range r.events {
		if strings.HasSuffix(k, "|Asia/Tokyo") {
			t.Errorf("cache still holds %q", k)
		}
	}
}
