package main

import (
	"testing"
	"time"
)

// rruleStarts parses one VEVENT (body lines joined with CRLF) in Madrid and
// answers its starts between from and to, as "2006-01-02 15:04" Madrid times.
func rruleStarts(t *testing.T, loc *time.Location, lines, from, to string) []string {
	t.Helper()
	ics := "BEGIN:VCALENDAR\r\n" + lines + "END:VCALENDAR\r\n"
	var out []string
	for _, ev := range ParseEvents(ics, loc) {
		for _, s := range ev.StartsBetween(at(loc, from), at(loc, to)) {
			out = append(out, s.In(loc).Format("2006-01-02 15:04"))
		}
	}
	return out
}

func sameList(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestRepeatingEventsRing (S2-#3): a repeating event rings on every occurrence
// inside the window, at the same wall-clock time across a DST change, and
// honours COUNT, UNTIL, EXDATE and a moved occurrence.
func TestRepeatingEventsRing(t *testing.T) {
	loc := madrid(t)

	cases := []struct {
		name, lines, from, to string
		want                  []string
	}{
		{"weekly BYDAY across the October DST change",
			"BEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=Europe/Madrid:20261019T100000\r\n" +
				"RRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\nEND:VEVENT\r\n",
			"2026-10-26 00:00", "2026-10-29 00:00",
			[]string{"2026-10-26 10:00", "2026-10-28 10:00"}},
		{"floating daily, years after it started: 10:00 each day",
			"BEGIN:VEVENT\r\nUID:d\r\nDTSTART:20200101T100000\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\n",
			"2026-03-28 09:00", "2026-03-30 11:00",
			[]string{"2026-03-28 10:00", "2026-03-29 10:00", "2026-03-30 10:00"}},
		{"COUNT stops the series",
			"BEGIN:VEVENT\r\nUID:c\r\nDTSTART:20260901T090000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n",
			"2026-09-01 00:00", "2026-09-10 00:00",
			[]string{"2026-09-01 09:00", "2026-09-02 09:00", "2026-09-03 09:00"}},
		{"a date-only UNTIL includes its whole day",
			"BEGIN:VEVENT\r\nUID:u\r\nDTSTART:20260901T200000\r\nRRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20260905\r\nEND:VEVENT\r\n",
			"2026-09-01 00:00", "2026-09-10 00:00",
			[]string{"2026-09-01 20:00", "2026-09-03 20:00", "2026-09-05 20:00"}},
		{"EXDATE and an override: the moved one rings at its new time only",
			"BEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=Europe/Madrid:20260901T100000\r\n" +
				"RRULE:FREQ=DAILY\r\nEXDATE;TZID=Europe/Madrid:20260902T100000\r\nEND:VEVENT\r\n" +
				"BEGIN:VEVENT\r\nUID:x\r\nRECURRENCE-ID;TZID=Europe/Madrid:20260903T100000\r\n" +
				"DTSTART;TZID=Europe/Madrid:20260903T170000\r\nEND:VEVENT\r\n",
			"2026-09-01 00:00", "2026-09-04 23:00",
			[]string{"2026-09-01 10:00", "2026-09-04 10:00", "2026-09-03 17:00"}},
		{"monthly on the 31st skips the short months",
			"BEGIN:VEVENT\r\nUID:m\r\nDTSTART:20260131T080000\r\nRRULE:FREQ=MONTHLY\r\nEND:VEVENT\r\n",
			"2026-01-01 00:00", "2026-06-01 00:00",
			[]string{"2026-01-31 08:00", "2026-03-31 08:00", "2026-05-31 08:00"}},
		{"yearly on 29 February: leap years only",
			"BEGIN:VEVENT\r\nUID:y\r\nDTSTART:20240229T120000\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT\r\n",
			"2025-01-01 00:00", "2028-12-31 00:00",
			[]string{"2028-02-29 12:00"}},
		{"weekly every 2 weeks, WKST=SU",
			"BEGIN:VEVENT\r\nUID:k\r\nDTSTART:20260906T090000\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU\r\nEND:VEVENT\r\n",
			"2026-09-06 00:00", "2026-09-23 00:00",
			[]string{"2026-09-06 09:00", "2026-09-08 09:00", "2026-09-20 09:00", "2026-09-22 09:00"}},
		{"a rule it does not read rings on its first date only",
			"BEGIN:VEVENT\r\nUID:h\r\nDTSTART:20260901T090000\r\nRRULE:FREQ=YEARLY;BYWEEKNO=20\r\nEND:VEVENT\r\n",
			"2026-09-01 00:00", "2026-12-01 00:00",
			[]string{"2026-09-01 09:00"}},
		{"a rule it does not read, its first date moved: rings at the new time only",
			"BEGIN:VEVENT\r\nUID:hm\r\nDTSTART:20260901T090000\r\nRRULE:FREQ=YEARLY;BYWEEKNO=20\r\nEND:VEVENT\r\n" +
				"BEGIN:VEVENT\r\nUID:hm\r\nRECURRENCE-ID:20260901T090000\r\nDTSTART:20260901T120000\r\nEND:VEVENT\r\n",
			"2026-09-01 00:00", "2026-09-02 00:00",
			[]string{"2026-09-01 12:00"}},
		{"an all-day series never rings",
			"BEGIN:VEVENT\r\nUID:a\r\nDTSTART;VALUE=DATE:20260901\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\n",
			"2026-09-01 00:00", "2026-09-10 00:00",
			nil},
	}
	for _, c := range cases {
		if got := rruleStarts(t, loc, c.lines, c.from, c.to); !sameList(got, c.want) {
			t.Errorf("%s:\n got %v\nwant %v", c.name, got, c.want)
		}
	}
}
