package main

// =============================================================================
// Bugs audit 2: a trip reminder refused for good is not retried every minute
// (SF4).
// =============================================================================

import (
	"testing"
	"time"
)

// TestBug_SF4_TripRefusedIsDoneForToday: a 401/403 (our key) or a 410 (device
// gone) will not do better in a minute - the day is marked done; only a
// transient failure keeps it open (TestTripRetryAfterFailedPush).
func TestBug_SF4_TripRefusedIsDoneForToday(t *testing.T) {
	for _, code := range []int{400, 401, 403, 410, 413} {
		users, cfg, _ := newTestUsers(t)
		log := quietLog()
		service := newFakePush(t, false, map[string]int{"/b": code})
		subs := []PushSub{testSub(t, service.URL+"/a"), testSub(t, service.URL+"/b")}

		vapid := NewVapidStore(cfg.ConfigDir, "", log)
		service.wire(vapid)
		r := NewReminders(cfg, users, nil, nil, vapid, NewTrackers(cfg.ConfigDir, log), log)
		start := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
		trips := []dueTrip{{id: "7", dest: "Oporto", start: start}}

		if !r.announceTrips("ana", subs, trips, time.Local) {
			t.Fatalf("%d: the day stays open, so the trip is pushed again every minute", code)
		}
		if a, b := service.count("/a"), service.count("/b"); a != 1 || b != 1 {
			t.Fatalf("%d: pushes a %d, b %d, want 1 each", code, a, b)
		}
	}
}

// TestBug_SF4_RefusedSkippedWhileDayOpen: one device answers 503 (the day stays
// open, it is tried again), another 401 - that one is not pushed again today.
func TestBug_SF4_RefusedSkippedWhileDayOpen(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	log := quietLog()
	service := newFakePush(t, false, map[string]int{"/busy": 503, "/refused": 401})
	subs := []PushSub{testSub(t, service.URL+"/busy"), testSub(t, service.URL+"/refused")}

	vapid := NewVapidStore(cfg.ConfigDir, "", log)
	service.wire(vapid)
	r := NewReminders(cfg, users, nil, nil, vapid, NewTrackers(cfg.ConfigDir, log), log)
	start := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	trips := []dueTrip{{id: "7", dest: "Oporto", start: start}}

	for i := 0; i < 3; i++ {
		if r.announceTrips("ana", subs, trips, time.Local) {
			t.Fatal("a 503 marked the day done")
		}
	}
	if busy, refused := service.count("/busy"), service.count("/refused"); busy != 3 || refused != 1 {
		t.Fatalf("pushes: busy %d (want 3), refused %d (want 1)", busy, refused)
	}
}
