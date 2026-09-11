package main

// =============================================================================
// A very small read-only iCalendar reader - only what the reminder loop needs.
// =============================================================================
//
// It unfolds RFC 5545 continuation lines, walks the file VEVENT by VEVENT, and
// turns each event's DTSTART into a UNIX timestamp. Recurrence (RRULE), VALARM
// and VTIMEZONE blocks are ignored: the calendar app writes plain one-off events
// and that is all we read here.
//
// DTSTART forms the calendar app writes:
//
//	DTSTART;VALUE=DATE:20260829                  all-day   -> no time, skipped
//	DTSTART:20260829T100000                      floating  -> the reader's tz
//	DTSTART:20260829T090000Z                     UTC
//	DTSTART;TZID=Europe/Madrid:20260829T100000   zoned     -> that TZ
//
// java: TIME ZONES. Go has no "naive datetime" - every time.Time carries a
// Location, and time.Local is the box's own zone. So where Python distinguishes
// "aware" from "naive", here the distinction is simply which *time.Location is
// passed in: a nil one means time.Local. The zone a FLOATING value is read in
// is the CALENDAR OWNER's own (users.UserTZ); the box's local time is nobody's
// wall clock, and is only the last resort.

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Event is one VEVENT, reduced to what a notification needs.
//
// java: StartEpoch is a POINTER because an all-day or unparseable event has no
// start time at all, and 0 is a real timestamp (1970). nil is the only honest
// way to say "none".
type Event struct {
	UID        string
	Summary    string
	StartEpoch *int64
}

// dtRE captures the six date components. It is deliberately not anchored at the
// end: a trailing "Z" is allowed and inspected separately.
var dtRE = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})`)

// unfold applies RFC 5545 line unfolding: a line starting with a space or tab
// is a continuation of the previous one.
func unfold(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")

	var out []string
	for _, raw := range strings.Split(text, "\n") {
		if len(raw) > 0 && (raw[0] == ' ' || raw[0] == '\t') && len(out) > 0 {
			out[len(out)-1] += raw[1:]
		} else {
			out = append(out, raw)
		}
	}
	return out
}

// unescapeText undoes the TEXT escaping (\n \, \; \\) so a SUMMARY reads
// naturally.
func unescapeText(value string) string {
	r := strings.NewReplacer(
		`\n`, " ",
		`\N`, " ",
		`\,`, ",",
		`\;`, ";",
		`\\`, `\`,
	)
	return r.Replace(value)
}

// dtstartEpoch turns the (params, value) halves of a DTSTART line into POSIX
// seconds, or nil when the value has no time of day (an all-day event) or
// cannot be parsed.
//
// `loc` is the zone a FLOATING value is read in (nil = the server's own local
// zone); an explicit Z or TZID= in the line always wins over it.
func dtstartEpoch(params, rawValue string, loc *time.Location) *int64 {
	value := strings.TrimSpace(rawValue)
	m := dtRE.FindStringSubmatch(value)
	if m == nil {
		return nil
	}
	n := make([]int, 6)
	for i := 0; i < 6; i++ {
		n[i], _ = strconv.Atoi(m[i+1])
	}

	var zone *time.Location
	switch {
	case strings.HasSuffix(value, "Z"):
		zone = time.UTC
	case strings.Contains(params, "TZID="):
		tzid := strings.SplitN(params, "TZID=", 2)[1]
		tzid = strings.TrimSpace(strings.SplitN(tzid, ";", 2)[0])
		zone = Location(&tzid)
	default:
		zone = loc // floating: the calendar owner's own zone
	}
	if zone == nil {
		zone = time.Local
	}

	t := time.Date(n[0], time.Month(n[1]), n[2], n[3], n[4], n[5], 0, zone)
	return ptrInt64(t.Unix())
}

// ParseEvents returns one Event per VEVENT.
//
// `loc` is the zone a FLOATING "10:00" means, i.e. the calendar owner's own.
// nil falls back to the server's local zone, which is only right for a user who
// never picked a timezone.
func ParseEvents(text string, loc *time.Location) []Event {
	events := []Event{}

	var (
		inEvent bool
		uid     string
		summary string
		start   *int64
	)

	for _, line := range unfold(text) {
		switch {
		case line == "BEGIN:VEVENT":
			inEvent, uid, summary, start = true, "", "", nil

		case line == "END:VEVENT":
			if inEvent {
				events = append(events, Event{UID: uid, Summary: summary, StartEpoch: start})
			}
			inEvent = false

		case !inEvent:
			continue // outside an event - ignore calendar-level lines

		case strings.HasPrefix(line, "UID:"):
			uid = strings.TrimSpace(line[4:])

		case strings.HasPrefix(line, "SUMMARY:") || strings.HasPrefix(line, "SUMMARY;"):
			if i := strings.Index(line, ":"); i >= 0 {
				summary = unescapeText(line[i+1:])
			} else {
				summary = "" // a malformed "SUMMARY;" with no colon at all
			}

		case strings.HasPrefix(line, "DTSTART"):
			params, value, _ := strings.Cut(line, ":")
			start = dtstartEpoch(params, value, loc)
		}
	}
	return events
}
