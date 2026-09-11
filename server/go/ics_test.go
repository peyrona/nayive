package main

import (
	"testing"
	"time"
)

// TestParseEvents covers the four DTSTART shapes the calendar app writes, and
// the two things that must never happen: an all-day event getting a fake time,
// and a floating time drifting by the server's UTC offset.
func TestParseEvents(t *testing.T) {
	madrid, err := time.LoadLocation("Europe/Madrid")
	if err != nil {
		t.Skipf("no tzdata for Europe/Madrid: %v", err)
	}

	ics := "BEGIN:VCALENDAR\r\n" +
		"BEGIN:VEVENT\r\nUID:all-day\r\nSUMMARY:Cumple\r\n" +
		"DTSTART;VALUE=DATE:20260829\r\nEND:VEVENT\r\n" +
		"BEGIN:VEVENT\r\nUID:floating\r\nSUMMARY:Reunion\r\n" +
		"DTSTART:20260829T100000\r\nEND:VEVENT\r\n" +
		"BEGIN:VEVENT\r\nUID:utc\r\nSUMMARY:Vuelo\r\n" +
		"DTSTART:20260829T090000Z\r\nEND:VEVENT\r\n" +
		"BEGIN:VEVENT\r\nUID:zoned\r\nSUMMARY:Cita\r\n" +
		"DTSTART;TZID=Europe/Madrid:20260829T100000\r\nEND:VEVENT\r\n" +
		"END:VCALENDAR\r\n"

	events := ParseEvents(ics, madrid)
	if len(events) != 4 {
		t.Fatalf("got %d events, want 4", len(events))
	}

	if events[0].StartEpoch != nil {
		t.Error("an all-day event must have no start time")
	}
	if events[0].Summary != "Cumple" {
		t.Errorf("summary = %q", events[0].Summary)
	}

	// 10:00 in Madrid on 2026-08-29 is 08:00 UTC (CEST, UTC+2). A floating time
	// read in the owner's zone and an explicit TZID must agree.
	want := time.Date(2026, 8, 29, 10, 0, 0, 0, madrid).Unix()
	if got := *events[1].StartEpoch; got != want {
		t.Errorf("floating start = %d, want %d", got, want)
	}
	if got := *events[3].StartEpoch; got != want {
		t.Errorf("zoned start = %d, want %d", got, want)
	}
	if got := *events[2].StartEpoch; got != time.Date(2026, 8, 29, 9, 0, 0, 0, time.UTC).Unix() {
		t.Errorf("utc start = %d", got)
	}
}

// TestUnfoldAndEscapes pins the two text rules: RFC 5545 continuation lines,
// and a SUMMARY that carries escaped punctuation.
func TestUnfoldAndEscapes(t *testing.T) {
	// The fold happens MID-WORD, which is what RFC 5545 folding really does:
	// the continuation's leading space is the fold marker and is removed, so
	// the two halves join with nothing in between.
	ics := "BEGIN:VEVENT\nUID:x\nSUMMARY:Comprar pan\\, leche y hue\n" +
		" vos\nDTSTART:20260101T120000\nEND:VEVENT\n"

	events := ParseEvents(ics, time.UTC)
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	if want := "Comprar pan, leche y huevos"; events[0].Summary != want {
		t.Errorf("summary = %q, want %q", events[0].Summary, want)
	}
}

// TestParseEventsSurvivesGarbage - one mangled calendar must never cost a user
// their other reminders.
func TestParseEventsSurvivesGarbage(t *testing.T) {
	for _, bad := range []string{
		"", "not a calendar at all",
		"BEGIN:VEVENT\nDTSTART:nonsense\nEND:VEVENT\n",
		"BEGIN:VEVENT\nSUMMARY;\nEND:VEVENT\n",
		"END:VEVENT\nUID:orphan\n",
	} {
		events := ParseEvents(bad, time.UTC)
		for _, e := range events {
			if e.StartEpoch != nil && *e.StartEpoch == 0 {
				t.Errorf("%q produced a bogus epoch 0", bad)
			}
		}
	}
}
