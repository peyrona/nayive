package main

import (
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func sosAlertsOf(s *Server, kind string) []sosAlert {
	s.sos.mu.Lock()
	defer s.sos.mu.Unlock()
	var out []sosAlert
	for _, a := range s.sos.data.Alerts {
		if a.Kind == kind {
			out = append(out, a)
		}
	}
	return out
}

// TestSosSettingsAndSend: contacts are only real other users; SOS reaches them;
// only the sender and the contacts can read the alert.
func TestSosSettingsAndSend(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	// no contacts: nothing to send
	jsonCall(t, client, "POST", ts.URL+"/api/sos/send", `{}`, 409, nil)

	var put struct{ Contacts []string }
	jsonCall(t, client, "PUT", ts.URL+"/api/sos",
		`{"contacts":["beto","nobody","ana","beto"],"silent":6,"idle":12,"quietFrom":"23:00","quietTo":"08:00"}`, 200, &put)
	if strings.Join(put.Contacts, ",") != "beto" {
		t.Fatalf("contacts = %v, want [beto]", put.Contacts)
	}
	jsonCall(t, client, "PUT", ts.URL+"/api/sos", `{"silent":99}`, 400, nil)
	jsonCall(t, client, "PUT", ts.URL+"/api/sos", `{"contacts":["beto"],"quietFrom":"25:00"}`, 400, nil)

	var got struct {
		Contacts []string
		Silent   int
		Users    []string
	}
	jsonCall(t, client, "GET", ts.URL+"/api/sos", "", 200, &got)
	if got.Silent != 6 || len(got.Contacts) != 1 || strings.Join(got.Users, ",") != "beto" {
		t.Fatalf("GET = %+v", got)
	}

	var sent struct {
		ID string
		To []sosSent
	}
	jsonCall(t, client, "POST", ts.URL+"/api/sos/send", `{"lat":40.4,"lon":-3.7,"acc":12}`, 200, &sent)
	if sent.ID == "" || len(sent.To) != 1 || sent.To[0].User != "beto" {
		t.Fatalf("send = %+v", sent)
	}
	var a sosAlert
	jsonCall(t, client, "GET", ts.URL+"/api/sos/alert/"+sent.ID, "", 200, &a)
	if a.Kind != "sos" || a.Pos == nil || a.Pos.Lat != 40.4 {
		t.Fatalf("alert = %+v", a)
	}

	// beto (a contact) can read it
	beto := noFollow()
	signIn(t, beto, ts.URL, "beto", "xyz")
	jsonCall(t, beto, "GET", ts.URL+"/api/sos/alert/"+sent.ID, "", 200, nil)
	// ...but not one he is not part of
	jsonCall(t, beto, "GET", ts.URL+"/api/sos/alert/nope", "", 404, nil)
}

// TestSosIdleAskThenAlert: no sign of life -> ask; no answer -> one alert;
// a sign of life ends the ask.
func TestSosIdleAskThenAlert(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}, Idle: 2})
	now := time.Now()
	srv.sos.started = now.Add(-time.Hour)
	srv.sos.mu.Lock()
	srv.sos.rowLocked("ana", false).Alive = now.Add(-3 * time.Hour).Unix()
	srv.sos.mu.Unlock()

	srv.sosCheck(now)
	if u := srv.sos.Get("ana"); u.Asked == 0 {
		t.Fatal("no ask after 3 idle hours")
	}
	srv.sosCheck(now.Add(5 * time.Minute))
	if n := len(sosAlertsOf(srv, "idle")); n != 0 {
		t.Fatalf("alert before the answer time: %d", n)
	}
	srv.sosCheck(now.Add(sosAnswer + time.Minute))
	srv.sosCheck(now.Add(sosAnswer + 2*time.Minute))
	if n := len(sosAlertsOf(srv, "idle")); n != 1 {
		t.Fatalf("idle alerts = %d, want 1", n)
	}

	// he answers: the ask ends, no new ask until idle again
	srv.sos.Alive("ana", 0)
	if u := srv.sos.Get("ana"); u.Asked != 0 {
		t.Fatal("alive did not end the ask")
	}
	srv.sosCheck(time.Now().Add(time.Hour))
	if u := srv.sos.Get("ana"); u.Asked != 0 {
		t.Fatal("asked again while not idle")
	}
}

// TestSosQuietWindow: no ask inside the quiet hours.
func TestSosQuietWindow(t *testing.T) {
	at := func(h, m int) time.Time { return time.Date(2026, 11, 12, h, m, 0, 0, time.UTC) }
	cases := []struct {
		t        time.Time
		from, to string
		want     bool
	}{
		{at(23, 30), "23:00", "08:00", true},
		{at(3, 0), "23:00", "08:00", true},
		{at(8, 0), "23:00", "08:00", false},
		{at(12, 0), "23:00", "08:00", false},
		{at(13, 0), "12:00", "14:00", true},
		{at(13, 0), "", "", false},
	}
	for _, c := range cases {
		if got := inQuiet(c.t, c.from, c.to); got != c.want {
			t.Errorf("inQuiet(%s, %s-%s) = %v", c.t.Format("15:04"), c.from, c.to, got)
		}
	}
}

// TestSosPhoneSilent: an app phone not seen for `silent` hours -> one alert.
func TestSosPhoneSilent(t *testing.T) {
	srv, _, _ := newTestServer(t)
	id, err := srv.devices.Enrol("ana", phoneToken, "Pixel", "", 3)
	if err != nil {
		t.Fatal(err)
	}
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}, Silent: 1})
	srv.sos.started = time.Now().Add(-time.Hour)

	srv.devices.mu.Lock()
	for i := range srv.devices.rows {
		if srv.devices.rows[i].ID == id {
			srv.devices.rows[i].Seen = time.Now().Add(-2 * time.Hour).Unix()
		}
	}
	delete(srv.devices.seen, id)
	srv.devices.mu.Unlock()

	srv.sosCheck(time.Now())
	srv.sosCheck(time.Now().Add(time.Minute))
	if n := len(sosAlertsOf(srv, "silent")); n != 1 {
		t.Fatalf("silent alerts = %d, want 1", n)
	}
}

// TestSosRename: an admin rename follows the owner and the contact.
func TestSosRename(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}})
	srv.sos.RenameUser("beto", "bea")
	if c := srv.sos.Get("ana").Contacts; len(c) != 1 || c[0] != "bea" {
		t.Fatalf("contacts after rename = %v", c)
	}
	srv.sos.DropUser("bea")
	if c := srv.sos.Get("ana").Contacts; len(c) != 0 {
		t.Fatalf("contacts after delete = %v", c)
	}
	srv.sos.DropUser("ana")
	if srv.sos.Get("ana").Silent != 0 || srv.sos.rowLocked("ana", false) != nil {
		t.Fatal("row kept after delete")
	}
}

// TestSosAwake: the quiet hours do not count; the rest does.
func TestSosAwake(t *testing.T) {
	at := func(d, h, m int) time.Time { return time.Date(2026, 11, d, h, m, 0, 0, time.UTC) }
	for _, c := range []struct {
		from, to time.Time
		qf, qt   string
		want     time.Duration
	}{
		{at(12, 9, 0), at(12, 15, 0), "", "", 6 * time.Hour},            // no window
		{at(11, 22, 0), at(12, 9, 0), "23:00", "08:00", 2 * time.Hour},  // 22-23 + 08-09
		{at(12, 3, 0), at(12, 9, 0), "23:00", "08:00", time.Hour},       // last sign in the night
		{at(11, 9, 0), at(12, 9, 0), "23:00", "08:00", 15 * time.Hour},  // a whole day: 15 h awake
		{at(10, 9, 0), at(12, 10, 0), "23:00", "08:00", 31 * time.Hour}, // two days
		{at(12, 11, 0), at(12, 15, 0), "12:00", "14:00", 2 * time.Hour}, // a window by day
		{at(12, 15, 0), at(12, 9, 0), "23:00", "08:00", 0},              // backwards
	} {
		if got := awake(c.from, c.to, c.qf, c.qt); got != c.want {
			t.Errorf("awake(%s, %s, %s-%s) = %v, want %v", c.from.Format("02 15:04"), c.to.Format("02 15:04"), c.qf, c.qt, got, c.want)
		}
	}

	// alive at 22:00, idle 6 h, quiet 23-08 (UTC): no ask at 08:05 (1 h 05
	// awake), an ask at 14:05
	srv, _, _ := newTestServer(t)
	srv.sos.started = at(1, 0, 0)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}, Idle: 6, QuietFrom: "23:00", QuietTo: "08:00"})
	srv.sos.mu.Lock()
	srv.sos.rowLocked("ana", false).Alive = at(11, 22, 0).Unix()
	srv.sos.mu.Unlock()
	srv.sosCheck(at(12, 8, 5))
	if srv.sos.Get("ana").Asked != 0 {
		t.Fatal("asked right at the end of the night")
	}
	srv.sosCheck(at(12, 14, 5))
	if srv.sos.Get("ana").Asked == 0 {
		t.Fatal("no ask 6 h after the night")
	}
}

// TestSosLongerThanTheDay: 24 h of "not used" with the default night still
// asks - the waking hours add up across days (it never did: the count
// started again every morning).
func TestSosLongerThanTheDay(t *testing.T) {
	at := func(d, h, m int) time.Time { return time.Date(2026, 11, d, h, m, 0, 0, time.UTC) }
	srv, _, _ := newTestServer(t)
	srv.sos.started = at(1, 0, 0)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}, Idle: 24, QuietFrom: "23:00", QuietTo: "08:00"})
	srv.sos.mu.Lock()
	srv.sos.rowLocked("ana", false).Alive = at(10, 12, 0).Unix()
	srv.sos.mu.Unlock()
	srv.sosCheck(at(11, 20, 0)) // 11 + 12 = 23 h awake
	if srv.sos.Get("ana").Asked != 0 {
		t.Fatal("asked after 23 waking hours")
	}
	srv.sosCheck(at(11, 21, 5)) // 24 h 05
	if srv.sos.Get("ana").Asked == 0 {
		t.Fatal("no ask after 24 waking hours")
	}
}

// TestSosIdleWaitsAfterStart: right after a start, no "Are you OK?" - the
// signs of life sent while the server was down have not come in yet.
func TestSosIdleWaitsAfterStart(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}, Idle: 2})
	now := time.Now()
	srv.sos.started = now
	srv.sos.mu.Lock()
	srv.sos.rowLocked("ana", false).Alive = now.Add(-3 * time.Hour).Unix()
	srv.sos.mu.Unlock()
	srv.sosCheck(now.Add(time.Minute))
	if srv.sos.Get("ana").Asked != 0 {
		t.Fatal("asked one minute after a start")
	}
	srv.sosCheck(now.Add(sosGrace + time.Minute))
	if srv.sos.Get("ana").Asked == 0 {
		t.Fatal("no ask once the start grace is over")
	}
}

// TestSosAliveReachesDisk: signs of life closer than 5 min still get written
// once 5 min have passed since the last write.
func TestSosAliveReachesDisk(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}, Idle: 6})
	base := time.Now().Unix() - 3600
	for i := int64(0); i <= 12; i++ {
		srv.sos.Alive("ana", base+i*60) // one a minute for 12 minutes
	}
	var f sosFile
	if !loadJSONFile(srv.sos.path, &f) || len(f.Users) != 1 || f.Users[0].Alive < base+10*60 {
		t.Fatalf("on disk: %+v", f.Users)
	}
}

// TestSosRetryUntilReached: an automatic alert whose push hit a busy push
// service is sent again on later ticks until a device takes it - and then
// no more; a test alert is never retried.
func TestSosRetryUntilReached(t *testing.T) {
	srv, _, _ := newTestServer(t)
	busy := 2 // the first two tries answer 503
	var mu sync.Mutex
	hits := 0
	service := newFakePush(t, true, nil)
	service.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		hits++
		if hits <= busy {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusCreated)
	})
	service.wire(srv.push)
	p256, au := testPushKeys(t)
	srv.users.AddPushSub("beto", "https://fcm.googleapis.com/fcm/send/beto", p256, au, "es", "Beto", nil)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}})

	a := srv.sosAlert("ana", "idle", time.Now().Unix(), nil)
	if len(a.To) != 1 || a.To[0].Sent != 0 || !a.To[0].Retry {
		t.Fatalf("first try = %+v, want not reached, to retry", a.To)
	}
	now := time.Now()
	srv.sosRetry(now) // busy again
	if got := sosAlertsOf(srv, "idle")[0].To[0]; got.Sent != 0 || !got.Retry {
		t.Fatalf("after a second busy try = %+v", got)
	}
	srv.sosRetry(now.Add(time.Minute)) // taken
	if got := sosAlertsOf(srv, "idle")[0].To[0]; got.Sent != 1 || got.Retry {
		t.Fatalf("after the push went through = %+v", got)
	}
	srv.sosRetry(now.Add(2 * time.Minute))
	mu.Lock()
	if hits != 3 {
		t.Errorf("pushes = %d, want 3 (none after it went through)", hits)
	}
	hits, busy = 0, 1
	mu.Unlock()

	// A test alert: one try only.
	if a := srv.sosAlert("ana", "test", 0, nil); a.To[0].Retry {
		t.Errorf("a test alert is to be retried")
	}

	// An alert a day old is no longer tried.
	srv.sosAlert("ana", "silent", time.Now().Unix(), nil) // busy -> retry
	srv.sosRetry(time.Now().Add(25 * time.Hour))
	if got := sosAlertsOf(srv, "silent")[0].To[0]; got.Retry {
		t.Errorf("a day-old alert is still tried: %+v", got)
	}
}

// TestSosSilentOnceAcrossRestart: the phone's "seen" in memory was newer than
// on disk; after a restart it reads older - still the same silence, no second
// alert.
func TestSosSilentOnceAcrossRestart(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}, Silent: 1})
	srv.sos.started = time.Now().Add(-time.Hour)
	srv.sos.mu.Lock()
	srv.sos.rowLocked("ana", false).SilentDone = time.Now().Add(-2 * time.Hour).Unix()
	srv.sos.mu.Unlock()
	id, err := srv.devices.Enrol("ana", phoneToken, "Pixel", "", 3)
	if err != nil {
		t.Fatal(err)
	}
	srv.devices.mu.Lock()
	for i := range srv.devices.rows {
		if srv.devices.rows[i].ID == id {
			srv.devices.rows[i].Seen = time.Now().Add(-3 * time.Hour).Unix() // older than the alert's
		}
	}
	delete(srv.devices.seen, id)
	srv.devices.mu.Unlock()

	srv.sosCheck(time.Now())
	if n := len(sosAlertsOf(srv, "silent")); n != 0 {
		t.Fatalf("silent alerts = %d, want 0 (already told)", n)
	}
}

// TestSosSendGap: a second SOS press while the first is still ringing sends
// nothing new - the page gets the same alert, its position brought up to
// date; once the gap is over, a new one goes out.
func TestSosSendGap(t *testing.T) {
	srv, ts, client := newTestServer(t)
	service := newFakePush(t, true, nil)
	service.wire(srv.push)
	p256, au := testPushKeys(t)
	srv.users.AddPushSub("beto", "https://fcm.googleapis.com/fcm/send/beto", p256, au, "es", "Beto", nil)
	signIn(t, client, ts.URL, "ana", "abc")
	jsonCall(t, client, "PUT", ts.URL+"/api/sos", `{"contacts":["beto"]}`, 200, nil)

	var one, two struct {
		ID string
		To []sosSent
	}
	jsonCall(t, client, "POST", ts.URL+"/api/sos/send", `{}`, 200, &one)
	jsonCall(t, client, "POST", ts.URL+"/api/sos/send", `{"lat":40.4,"lon":-3.7}`, 200, &two)
	if one.ID == "" || two.ID != one.ID || len(two.To) != 1 || two.To[0].Sent != 1 {
		t.Fatalf("second press = %+v, want the first alert %s", two, one.ID)
	}
	if n := service.count(""); n != 1 {
		t.Fatalf("pushes = %d, want 1", n)
	}
	if a := sosAlertsOf(srv, "sos"); len(a) != 1 || a[0].Pos == nil || a[0].Pos.Lat == 0 {
		t.Fatalf("alerts = %+v, want one with the new position", a)
	}

	// A test does not hold back a real one, nor the other way round.
	jsonCall(t, client, "POST", ts.URL+"/api/sos/send", `{"test":true}`, 200, nil)
	if n := service.count(""); n != 2 {
		t.Fatalf("a test after an SOS: pushes = %d, want 2", n)
	}

	// The gap over, a new alert.
	srv.sos.mu.Lock()
	for i := range srv.sos.data.Alerts {
		srv.sos.data.Alerts[i].At -= int64(sosSendGap["sos"] / time.Second)
	}
	srv.sos.mu.Unlock()
	jsonCall(t, client, "POST", ts.URL+"/api/sos/send", `{}`, 200, &two)
	if two.ID == one.ID || service.count("") != 3 {
		t.Fatalf("after the gap: %+v, pushes %d", two, service.count(""))
	}
}

// TestSosEscalationWaitsAfterStart: an ask sent before a stop does not turn
// into an alert at the first tick after the start - the answer may be on its
// way.
func TestSosEscalationWaitsAfterStart(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.sos.Set(sosUser{Owner: "ana", Contacts: []string{"beto"}, Idle: 2})
	now := time.Now()
	srv.sos.started = now
	srv.sos.mu.Lock()
	r := srv.sos.rowLocked("ana", false)
	r.Alive = now.Add(-5 * time.Hour).Unix()
	r.Asked = now.Add(-time.Hour).Unix()
	srv.sos.mu.Unlock()
	srv.sosCheck(now.Add(time.Minute))
	if n := len(sosAlertsOf(srv, "idle")); n != 0 {
		t.Fatalf("idle alerts one minute after a start = %d, want 0", n)
	}
	srv.sosCheck(now.Add(sosGrace + time.Minute))
	if n := len(sosAlertsOf(srv, "idle")); n != 1 {
		t.Fatalf("idle alerts after the grace = %d, want 1", n)
	}
}

// TestSosDangerWatch: the server counts; stopped in time -> nothing; not
// stopped -> one alert, even with the phone gone; "I'm safe" afterwards ->
// "safe" to the contacts; "send now" after the timer -> the timer's alert.
func TestSosDangerWatch(t *testing.T) {
	srv, ts, client := newTestServer(t)
	service := newFakePush(t, true, nil)
	service.wire(srv.push)
	p256, au := testPushKeys(t)
	srv.users.AddPushSub("beto", "https://fcm.googleapis.com/fcm/send/beto", p256, au, "es", "Beto", nil)
	signIn(t, client, ts.URL, "ana", "abc")

	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch", `{}`, 409, nil) // no contacts
	jsonCall(t, client, "PUT", ts.URL+"/api/sos", `{"contacts":["beto"]}`, 200, nil)
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch/pos", `{"lat":40.4,"lon":-3.7}`, 409, nil) // none running

	// Stopped in time: nothing goes out, ever.
	var st struct{ Left int64 }
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch", `{"lat":40.4,"lon":-3.7,"acc":30}`, 200, &st)
	if st.Left < 85 || st.Left > 90 {
		t.Fatalf("left = %d, want ~90", st.Left)
	}
	var got struct{ Watch int64 }
	jsonCall(t, client, "GET", ts.URL+"/api/sos", "", 200, &got)
	if got.Watch < 85 {
		t.Fatalf("GET watch = %d, want the seconds left", got.Watch)
	}
	var stop struct{ Safe *struct{ ID string } }
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch/stop", `{}`, 200, &stop)
	if stop.Safe != nil {
		t.Fatalf("stopped in time sent a 'safe': %+v", stop.Safe)
	}
	srv.sosCheck(time.Now().Add(5 * time.Minute))
	if n := len(sosAlertsOf(srv, "watch")); n != 0 || service.count("") != 0 {
		t.Fatalf("a stopped watch went out: alerts %d, pushes %d", n, service.count(""))
	}

	// Not stopped: the tick (a lost timer) sends it once, with the last position.
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch", `{}`, 200, nil)
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch/pos", `{"lat":40.41,"lon":-3.71,"acc":8}`, 200, nil)
	srv.sosCheck(time.Now().Add(time.Minute)) // not yet
	if n := len(sosAlertsOf(srv, "watch")); n != 0 {
		t.Fatalf("went out early: %d", n)
	}
	srv.sosCheck(time.Now().Add(2 * time.Minute))
	srv.sosCheck(time.Now().Add(3 * time.Minute))
	as := sosAlertsOf(srv, "watch")
	if len(as) != 1 || as[0].To[0].Sent != 1 || as[0].Pos == nil || as[0].Pos.Lat != 40.41 {
		t.Fatalf("watch alerts = %+v, want one, reached, at 40.41", as)
	}

	// The page's own "send now" after the timer: the same alert, no new push.
	var sent struct{ ID string }
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch/send", `{}`, 200, &sent)
	if sent.ID != as[0].ID || service.count("") != 1 {
		t.Fatalf("send after the timer = %s (want %s), pushes %d", sent.ID, as[0].ID, service.count(""))
	}

	// Moving on: the alert follows.
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch/pos", `{"lat":40.42,"lon":-3.72,"acc":8}`, 200, nil)
	if p := sosAlertsOf(srv, "watch")[0].Pos; p == nil || p.Lat != 40.42 {
		t.Fatalf("alert position = %+v, want 40.42", p)
	}

	// "I'm safe": the contacts are told, once.
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch/stop", `{}`, 200, &stop)
	if stop.Safe == nil || len(sosAlertsOf(srv, "safe")) != 1 || service.count("") != 2 {
		t.Fatalf("safe = %+v, pushes %d", stop.Safe, service.count(""))
	}
	stop.Safe = nil
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch/stop", `{}`, 200, &stop)
	if stop.Safe != nil || service.count("") != 2 {
		t.Fatalf("a second 'I'm safe' told them again")
	}

	// "Send now" while it runs: at once.
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch", `{}`, 200, nil)
	jsonCall(t, client, "POST", ts.URL+"/api/sos/watch/send", `{"lat":40.5,"lon":-3.8}`, 200, &sent)
	if n := len(sosAlertsOf(srv, "watch")); n != 2 || service.count("") != 3 {
		t.Fatalf("send now: alerts %d, pushes %d", n, service.count(""))
	}
	srv.sosCheck(time.Now().Add(3 * time.Minute))
	if n := len(sosAlertsOf(srv, "watch")); n != 2 {
		t.Fatalf("the tick sent it again: %d", n)
	}
}
