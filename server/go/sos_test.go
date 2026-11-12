package main

import (
	"strings"
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

// TestSosQuietEnd: the checks count from the end of the night, not before it.
func TestSosQuietEnd(t *testing.T) {
	at := func(d, h, m int) time.Time { return time.Date(2026, 11, d, h, m, 0, 0, time.UTC) }
	if got := quietEnd(at(12, 9, 0), "23:00", "08:00"); got != at(12, 8, 0).Unix() {
		t.Errorf("09:00 -> %v", time.Unix(got, 0).UTC())
	}
	if got := quietEnd(at(12, 7, 0), "23:00", "08:00"); got != at(11, 8, 0).Unix() {
		t.Errorf("07:00 -> %v", time.Unix(got, 0).UTC())
	}
	if quietEnd(at(12, 7, 0), "", "") != 0 {
		t.Error("no window -> 0")
	}

	// alive at 22:00, idle 6 h, quiet 23-08 (UTC): no ask at 08:05, an ask at 14:05
	srv, _, _ := newTestServer(t)
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
