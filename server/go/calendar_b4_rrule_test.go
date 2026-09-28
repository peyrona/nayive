package main

// =============================================================================
// Batch 4 part 3 (batch4.md "Server rrule"): the rules the calendar sheet never
// writes - BYDAY with an ordinal (2TU, -1FR), BYDAY on a daily or yearly rule,
// BYMONTHDAY, BYMONTH, BYSETPOS - ring on every occurrence, on the same dates
// the calendar's screen shows. The expected lists come from rrule.js 2.8.1
// (the library shared/ical.js expands them with), except that a date-only
// UNTIL keeps its whole day, as the screen now does too.
// =============================================================================

import (
	"strings"
	"testing"
	"time"
)

func TestCustomRulesRingLikeTheScreen(t *testing.T) {
	loc := madrid(t)

	cases := []struct {
		name, dtstart, rule, from, to string
		want                          []string
	}{
		{"2nd Tuesday", "20260113T100000", "FREQ=MONTHLY;BYDAY=2TU", "2026-01-01 00:00", "2026-07-01 00:00",
			[]string{"2026-01-13 10:00", "2026-02-10 10:00", "2026-03-10 10:00", "2026-04-14 10:00", "2026-05-12 10:00", "2026-06-09 10:00"}},
		{"DTSTART off the rule", "20260101T100000", "FREQ=MONTHLY;BYDAY=2TU", "2026-01-01 00:00", "2026-04-01 00:00",
			[]string{"2026-01-13 10:00", "2026-02-10 10:00", "2026-03-10 10:00"}},
		{"last Friday", "20260130T180000", "FREQ=MONTHLY;BYDAY=-1FR", "2026-01-01 00:00", "2026-07-01 00:00",
			[]string{"2026-01-30 18:00", "2026-02-27 18:00", "2026-03-27 18:00", "2026-04-24 18:00", "2026-05-29 18:00", "2026-06-26 18:00"}},
		{"last day of the month", "20260131T090000", "FREQ=MONTHLY;BYMONTHDAY=-1", "2026-01-01 00:00", "2026-07-01 00:00",
			[]string{"2026-01-31 09:00", "2026-02-28 09:00", "2026-03-31 09:00", "2026-04-30 09:00", "2026-05-31 09:00", "2026-06-30 09:00"}},
		{"last weekday (BYSETPOS)", "20260130T170000", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "2026-01-01 00:00", "2026-08-01 00:00",
			[]string{"2026-01-30 17:00", "2026-02-27 17:00", "2026-03-31 17:00", "2026-04-30 17:00", "2026-05-29 17:00", "2026-06-30 17:00", "2026-07-31 17:00"}},
		{"1st and 15th", "20260101T090000", "FREQ=MONTHLY;BYMONTHDAY=1,15", "2026-01-01 00:00", "2026-04-01 00:00",
			[]string{"2026-01-01 09:00", "2026-01-15 09:00", "2026-02-01 09:00", "2026-02-15 09:00", "2026-03-01 09:00", "2026-03-15 09:00"}},
		{"Friday the 13th", "20260213T100000", "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13", "2026-01-01 00:00", "2028-01-01 00:00",
			[]string{"2026-02-13 10:00", "2026-03-13 10:00", "2026-11-13 10:00", "2027-08-13 10:00"}},
		{"every 2nd month, 1st Monday, 4 times", "20260105T083000", "FREQ=MONTHLY;INTERVAL=2;BYDAY=1MO;COUNT=4", "2026-01-01 00:00", "2028-01-01 00:00",
			[]string{"2026-01-05 08:30", "2026-03-02 08:30", "2026-05-04 08:30", "2026-07-06 08:30"}},
		{"4th Thursday of November", "20261126T120000", "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", "2026-01-01 00:00", "2030-01-01 00:00",
			[]string{"2026-11-26 12:00", "2027-11-25 12:00", "2028-11-23 12:00", "2029-11-22 12:00"}},
		{"20th Monday of the year", "20260518T090000", "FREQ=YEARLY;BYDAY=20MO", "2026-01-01 00:00", "2029-01-01 00:00",
			[]string{"2026-05-18 09:00", "2027-05-17 09:00", "2028-05-15 09:00"}},
		{"daily on weekdays MO WE FR", "20260105T080000", "FREQ=DAILY;BYDAY=MO,WE,FR", "2026-01-01 00:00", "2026-01-20 00:00",
			[]string{"2026-01-05 08:00", "2026-01-07 08:00", "2026-01-09 08:00", "2026-01-12 08:00", "2026-01-14 08:00", "2026-01-16 08:00", "2026-01-19 08:00"}},
		{"daily in March only", "20260227T070000", "FREQ=DAILY;BYMONTH=3;UNTIL=20270302", "2026-01-01 00:00", "2027-12-01 00:00",
			[]string{"2026-03-01 07:00", "2026-03-02 07:00", "2026-03-03 07:00", "2026-03-04 07:00", "2026-03-05 07:00", "2026-03-06 07:00", "2026-03-07 07:00", "2026-03-08 07:00", "2026-03-09 07:00", "2026-03-10 07:00", "2026-03-11 07:00", "2026-03-12 07:00", "2026-03-13 07:00", "2026-03-14 07:00", "2026-03-15 07:00", "2026-03-16 07:00", "2026-03-17 07:00", "2026-03-18 07:00", "2026-03-19 07:00", "2026-03-20 07:00", "2026-03-21 07:00", "2026-03-22 07:00", "2026-03-23 07:00", "2026-03-24 07:00", "2026-03-25 07:00", "2026-03-26 07:00", "2026-03-27 07:00", "2026-03-28 07:00", "2026-03-29 07:00", "2026-03-30 07:00", "2026-03-31 07:00", "2027-03-01 07:00", "2027-03-02 07:00"}},
		{"weekly Saturdays in June and July", "20260606T100000", "FREQ=WEEKLY;BYDAY=SA;BYMONTH=6,7", "2026-01-01 00:00", "2026-08-31 00:00",
			[]string{"2026-06-06 10:00", "2026-06-13 10:00", "2026-06-20 10:00", "2026-06-27 10:00", "2026-07-04 10:00", "2026-07-11 10:00", "2026-07-18 10:00", "2026-07-25 10:00"}},
		{"yearly on the 1st of Jan and Jul", "20260101T000000", "FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=1", "2026-01-01 00:00", "2028-01-01 00:00",
			[]string{"2026-01-01 00:00", "2026-07-01 00:00", "2027-01-01 00:00", "2027-07-01 00:00", "2028-01-01 00:00"}},
		{"yearly 2nd-to-last Sunday of March", "20260322T100000", "FREQ=YEARLY;BYMONTH=3;BYDAY=-2SU", "2026-01-01 00:00", "2029-12-31 00:00",
			[]string{"2026-03-22 10:00", "2027-03-21 10:00", "2028-03-19 10:00", "2029-03-18 10:00"}},
	}
	for _, c := range cases {
		lines := "BEGIN:VEVENT\r\nUID:x\r\nDTSTART:" + c.dtstart + "\r\nRRULE:" + c.rule + "\r\nEND:VEVENT\r\n"
		got := rruleStarts(t, loc, lines, c.from, c.to)
		if !sameList(got, c.want) {
			t.Errorf("%s (%s):\n got  %v\n want %v", c.name, c.rule, got, c.want)
		}
	}
}

// TestUnreadRulesRingOnce: what we still do not expand rings on its first
// date only - never a flood, never nothing.
func TestUnreadRulesRingOnce(t *testing.T) {
	loc := madrid(t)
	for _, rule := range []string{
		"FREQ=HOURLY", "FREQ=YEARLY;BYYEARDAY=100", "FREQ=YEARLY;BYWEEKNO=20", "FREQ=DAILY;BYHOUR=9,17",
		"FREQ=DAILY;BYDAY=2TU", "FREQ=WEEKLY;BYMONTHDAY=3", "FREQ=MONTHLY;BYDAY=0MO", "FREQ=MONTHLY;BYMONTHDAY=32",
	} {
		lines := "BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260105T090000\r\nRRULE:" + rule + "\r\nEND:VEVENT\r\n"
		got := rruleStarts(t, loc, lines, "2026-01-01 00:00", "2026-12-31 00:00")
		if strings.Join(got, ",") != "2026-01-05 09:00" {
			t.Errorf("%s: %v, want the first date only", rule, got)
		}
	}
}

// TestExdateSilencesOneOccurrence (apps-2 #54): "delete only this one" writes
// an EXDATE in the DTSTART's own form - floating, TZID= or UTC - and that
// occurrence no longer rings; the others still do.
func TestExdateSilencesOneOccurrence(t *testing.T) {
	loc := madrid(t)
	for _, c := range []struct{ dtstart, exdate string }{
		{"DTSTART:20261005T100000", "EXDATE:20261006T100000"},
		{"DTSTART;TZID=Europe/Madrid:20261005T100000", "EXDATE;TZID=Europe/Madrid:20261006T100000"},
		{"DTSTART:20261005T080000Z", "EXDATE:20261006T080000Z"},
	} {
		lines := "BEGIN:VEVENT\r\nUID:x\r\n" + c.dtstart + "\r\nRRULE:FREQ=DAILY;COUNT=3\r\n" + c.exdate + "\r\nEND:VEVENT\r\n"
		got := rruleStarts(t, loc, lines, "2026-10-01 00:00", "2026-10-31 00:00")
		want := []string{"2026-10-05 10:00", "2026-10-07 10:00"}
		if !sameList(got, want) {
			t.Errorf("%s + %s: %v, want %v", c.dtstart, c.exdate, got, want)
		}
	}
}

// TestNeverMatchingRuleIsQuick (review): a rule that names no real day
// (the 31st that is also the first Monday) yields nothing, so only the window
// end stops the walk. It used to walk 100 000 periods - a minute per reminder
// tick. With or without COUNT, from an old DTSTART, it must answer at once.
func TestNeverMatchingRuleIsQuick(t *testing.T) {
	loc := madrid(t)
	rules := []string{
		"FREQ=YEARLY;BYMONTHDAY=31;BYDAY=1MO",
		"FREQ=YEARLY;BYMONTHDAY=31;BYDAY=1MO;COUNT=3",
		"FREQ=MONTHLY;BYMONTHDAY=31;BYDAY=1MO",
		"FREQ=MONTHLY;BYMONTHDAY=31;BYDAY=1MO;COUNT=3",
		"FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
		"FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;COUNT=5",
		"FREQ=WEEKLY;BYMONTH=13",
	}
	start := time.Now()
	for _, rule := range rules {
		for _, dt := range []string{"19700105T090000", "20260105T090000"} {
			lines := "BEGIN:VEVENT\r\nUID:x\r\nDTSTART:" + dt + "\r\nRRULE:" + rule + "\r\nEND:VEVENT\r\n"
			if got := rruleStarts(t, loc, lines, "2026-09-28 10:00", "2026-09-28 10:30"); len(got) > 1 {
				t.Errorf("%s from %s: %v", rule, dt, got)
			}
		}
	}
	// A far window must stay quick too, and still find what is there.
	lines := "BEGIN:VEVENT\r\nUID:x\r\nDTSTART:19700101T090000\r\nRRULE:FREQ=DAILY;COUNT=30000\r\nEND:VEVENT\r\n"
	if got := rruleStarts(t, loc, lines, "2026-09-28 00:00", "2026-09-28 23:00"); len(got) != 1 {
		t.Errorf("daily COUNT=30000 from 1970: %v, want today's", got)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("took %v, want well under 2 s", d)
	}
	t.Logf("all took %v", time.Since(start))
}
