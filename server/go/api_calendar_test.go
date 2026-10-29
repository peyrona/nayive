package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// calendarLeftToday counts what starts from now to midnight on the asked
// zone's wall clock: not what is over, not tomorrow, not an all-day event;
// a daily series counts once today.
func TestCalendarLeftToday(t *testing.T) {
	srv, _, _ := newTestServer(t)
	data := filepath.Join(srv.cfg.HomesDir, "ana", "data")
	os.MkdirAll(data, 0o755)
	ev := func(uid, start, extra string) string {
		return "BEGIN:VEVENT\r\nUID:" + uid + "\r\nSUMMARY:x\r\nDTSTART" + start + "\r\n" + extra + "END:VEVENT\r\n"
	}
	ics := "BEGIN:VCALENDAR\r\n" +
		ev("past", ":20261028T090000", "") +
		ev("later", ":20261028T180000", "") +
		ev("late", ":20261028T235900", "") +
		ev("tomorrow", ":20261029T000000", "") +
		ev("allday", ";VALUE=DATE:20261028", "") +
		ev("daily", ":20261001T200000", "RRULE:FREQ=DAILY\r\n") +
		"END:VCALENDAR\r\n"
	os.WriteFile(filepath.Join(data, "calendar.ics"), []byte(ics), 0o644)

	madrid := zoneLoc(t, "Europe/Madrid")
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, madrid)
	if n := srv.calendarLeftToday("ana", "Europe/Madrid", now); n != 3 {
		t.Errorf("Madrid noon: %d, want 3 (later, late, daily)", n)
	}
	if n := srv.calendarLeftToday("ana", "Europe/Madrid", now.Add(9*time.Hour)); n != 1 {
		t.Errorf("Madrid 21:00: %d, want 1 (late)", n)
	}
	if n := srv.calendarLeftToday("nobody", "Europe/Madrid", now); n != 0 {
		t.Errorf("no calendar: %d, want 0", n)
	}
}
