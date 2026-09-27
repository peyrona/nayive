package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func madrid(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Madrid")
	if err != nil {
		t.Skip("no tzdata:", err)
	}
	return loc
}

func at(loc *time.Location, text string) time.Time {
	v, err := time.ParseInLocation("2006-01-02 15:04", text, loc)
	if err != nil {
		panic(err)
	}
	return v
}

func stage(startDate, startTime, endDate, endTime string, enabled bool) publicTripStage {
	return publicTripStage{StartDate: startDate, StartTime: startTime, EndDate: endDate, EndTime: endTime, Enabled: &enabled}
}

// TestLocationMoments: 2 h before the start and 2 h after the end, from the
// stage times when there are any, else from the trip's days.
func TestLocationMoments(t *testing.T) {
	loc := madrid(t)
	cases := []struct {
		name    string
		trip    publicTripFile
		on, off string
	}{
		{"no times: 22:00 the evening before, 09:00 the morning after",
			publicTripFile{StartDate: "2026-10-01", EndDate: "2026-10-05"},
			"2026-09-30 22:00", "2026-10-06 09:00"},
		{"stage times on the first and last day",
			publicTripFile{StartDate: "2026-10-01", EndDate: "2026-10-05", Stages: []publicTripStage{
				stage("2026-10-01", "08:30", "2026-10-03", "", true),
				stage("2026-10-01", "11:00", "2026-10-01", "12:00", true),
				stage("2026-10-04", "10:00", "2026-10-05", "18:15", true),
			}},
			"2026-10-01 06:30", "2026-10-05 20:15"},
		{"a switched-off stage counts for nothing",
			publicTripFile{StartDate: "2026-10-01", EndDate: "2026-10-05", Stages: []publicTripStage{
				stage("2026-10-01", "05:00", "2026-10-05", "23:00", false),
				stage("2026-10-01", "09:00", "2026-10-02", "", true),
			}},
			"2026-10-01 07:00", "2026-10-06 09:00"},
		{"a stage time on another day is not the trip's",
			publicTripFile{StartDate: "2026-10-01", EndDate: "2026-10-05", Stages: []publicTripStage{
				stage("2026-09-30", "09:00", "2026-10-06", "10:00", true),
			}},
			"2026-09-30 22:00", "2026-10-06 09:00"},
		{"seconds in a time are ignored",
			publicTripFile{StartDate: "2026-10-01", EndDate: "2026-10-01", Stages: []publicTripStage{
				stage("2026-10-01", "07:45:00", "2026-10-01", "21:10:00", true),
			}},
			"2026-10-01 05:45", "2026-10-01 23:10"},
	}
	for _, tc := range cases {
		on, off, ok := locationMoments(tc.trip, loc)
		if !ok {
			t.Errorf("%s: not ok", tc.name)
			continue
		}
		if !on.Equal(at(loc, tc.on)) || !off.Equal(at(loc, tc.off)) {
			t.Errorf("%s: got %s / %s, want %s / %s", tc.name,
				on.In(loc).Format("2006-01-02 15:04"), off.In(loc).Format("2006-01-02 15:04"), tc.on, tc.off)
		}
	}

	for _, bad := range []publicTripFile{
		{StartDate: "", EndDate: "2026-10-05"},
		{StartDate: "2026-10-05", EndDate: "2026-10-01"},
		{StartDate: "2026-02-30", EndDate: "2026-03-01"},
	} {
		if _, _, ok := locationMoments(bad, loc); ok {
			t.Errorf("%+v: want not ok", bad)
		}
	}
}

func locTrip(id, start, end string, track *bool) locationTrip {
	return locationTrip{
		ID:             json.RawMessage(id),
		publicTripFile: publicTripFile{Destination: "Trip " + id, StartDate: start, EndDate: end, Track: track},
	}
}

func kinds(alerts []locationAlert) []string {
	out := []string{}
	for _, a := range alerts {
		k := "off"
		if a.on {
			k = "on"
		}
		out = append(out, a.id+":"+k)
	}
	return out
}

// TestLocationAlertsDue: each alert rings in its window only, never for a trip
// that keeps no positions, and never between back-to-back trips.
func TestLocationAlertsDue(t *testing.T) {
	loc := madrid(t)
	off := false
	one := []locationTrip{locTrip("1", "2026-10-01", "2026-10-05", nil)}
	back := []locationTrip{
		locTrip("1", "2026-10-01", "2026-10-05", nil),
		locTrip("2", "2026-10-06", "2026-10-08", nil),
	}

	cases := []struct {
		name  string
		trips []locationTrip
		now   string
		want  []string
	}{
		{"before ON", one, "2026-09-30 21:59", []string{}},
		{"ON is due", one, "2026-09-30 22:00", []string{"1:on"}},
		{"ON stays due during the trip", one, "2026-10-03 12:00", []string{"1:on"}},
		{"OFF is due", one, "2026-10-06 09:00", []string{"1:off"}},
		{"OFF too late", one, "2026-10-07 09:00", []string{}},
		{"a trip that keeps no positions", []locationTrip{locTrip("1", "2026-10-01", "2026-10-05", &off)},
			"2026-09-30 23:00", []string{}},
		{"a trip with no id", []locationTrip{locTrip("null", "2026-10-01", "2026-10-05", nil)},
			"2026-09-30 23:00", []string{}},
		{"back to back: no ON for the next one", back, "2026-10-05 22:30", []string{"1:on"}},
		{"back to back: no OFF for the first one", back, "2026-10-06 09:30", []string{}},
		{"back to back: OFF after the last one", back, "2026-10-09 09:00", []string{"2:off"}},
	}
	for _, tc := range cases {
		got := kinds(locationAlertsDue(tc.trips, loc, at(loc, tc.now)))
		if len(got) != len(tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
				break
			}
		}
	}
}

// testSub is a device whose push service is `endpoint`, with real keys - the
// message is encrypted for it before it is sent.
func testSub(t *testing.T, endpoint string) PushSub {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	rand.Read(auth)
	return PushSub{Endpoint: endpoint, Keys: PushKeys{P256dh: b64u(priv.PublicKey().Bytes()), Auth: b64u(auth)}, Lang: "es"}
}

// TestLocationTickSendsOnce: a trip under way, a location URL on, two devices -
// ON reaches each device once, and the keys survive in reminders.json.
func TestLocationTickSendsOnce(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	var hits atomic.Int32
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer service.Close()
	subs := []PushSub{testSub(t, service.URL+"/a"), testSub(t, service.URL+"/b")}

	trackers := NewTrackers(cfg.ConfigDir, log)
	vapid := NewVapidStore(cfg.ConfigDir, "", log)
	localPush(vapid) // the fake service is on this machine
	r := NewReminders(cfg, users, nil, nil, vapid, trackers, log)

	day := func(d int) string { return time.Now().AddDate(0, 0, d).Format("2006-01-02") }
	dir := filepath.Join(cfg.HomesDir, "ana", "data", "trips", "now")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "trip.json"),
		[]byte(`{"id": 7, "destination": "Oporto", "startDate": "`+day(-1)+`", "endDate": "`+day(1)+`"}`), 0o644)

	r.locationTick("ana", subs, time.Local)
	if n := hits.Load(); n != 0 {
		t.Fatalf("no location URL yet: %d pushes, want 0", n)
	}

	trackers.Create("ana")
	r.locationTick("ana", subs, time.Local)
	if n := hits.Load(); n != 2 {
		t.Fatalf("first tick: %d pushes, want 2 (one per device)", n)
	}
	r.locationTick("ana", subs, time.Local)
	if n := hits.Load(); n != 2 {
		t.Fatalf("second tick: %d pushes, want still 2", n)
	}

	keys := loadSentKeys(filepath.Join(cfg.HomesDir, "ana", "data", "reminders.json"), "location")
	if len(keys) != 2 {
		t.Fatalf("saved keys %v, want 2", keys)
	}

	// A restart forgets nothing: a fresh loop reads the keys back.
	fresh := NewReminders(cfg, users, nil, nil, NewVapidStore(cfg.ConfigDir, "", log), trackers, log)
	fresh.locationTick("ana", subs, time.Local)
	if n := hits.Load(); n != 2 {
		t.Fatalf("after a restart: %d pushes, want still 2", n)
	}
}
