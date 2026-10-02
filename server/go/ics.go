package main

// =============================================================================
// A very small read-only iCalendar reader - only what the reminder loop needs.
// =============================================================================
//
// It unfolds RFC 5545 continuation lines, walks the file VEVENT by VEVENT, and
// turns each event's DTSTART into a UNIX timestamp. VALARM and VTIMEZONE blocks
// are ignored.
//
// A REPEATING event (RRULE) rings on every occurrence, not only its first date
// (S2-#3): StartsBetween expands it inside the push window, on the same dates
// the calendar's screen shows (rrule.js): FREQ DAILY / WEEKLY / MONTHLY /
// YEARLY, INTERVAL, COUNT or UNTIL, BYDAY (also "2TU", "-1FR"), BYMONTHDAY,
// BYMONTH, BYSETPOS, WKST; plus EXDATE, and an override (RECURRENCE-ID)
// replacing its occurrence. Any other rule (FREQ=HOURLY, BYYEARDAY, BYWEEKNO,
// BYHOUR, an ordinal BYDAY on a daily rule, BYMONTHDAY on a weekly one, a
// second RRULE...) still rings on its first date only.
//
// DTSTART forms the calendar app writes:
//
//	DTSTART;VALUE=DATE:20260829                  all-day   -> no time, skipped
//	DTSTART:20260829T100000                      floating  -> the reader's tz
//	DTSTART:20260829T090000Z                     UTC
//	DTSTART;TZID=Europe/Madrid:20260829T100000   zoned     -> that TZ
//
// java: TIME ZONES. Go has no "naive datetime" - every time.Time carries a
// Location, and time.Local is the box's own zone. So "aware" versus "naive"
// is simply which *time.Location is passed in: a nil one means time.Local. The zone a FLOATING value is read in
// is the DEVICE's own (PushSub.TZ, reminders.go), else the CALENDAR OWNER's
// (users.UserTZ); the box's local time is nobody's
// wall clock, and is only the last resort.

import (
	"regexp"
	"sort"
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

	start   time.Time      // StartEpoch on the wall clock of its own zone
	rule    *recurRule     // nil: rings once, at StartEpoch
	exdates map[int64]bool // occurrences taken out (EXDATE, or moved by an override)
	recurID *int64         // an override: the occurrence of its series it replaces
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
	t, ok := dtstartTime(params, rawValue, loc)
	if !ok {
		return nil
	}
	return ptrInt64(t.Unix())
}

// dtstartTime is dtstartEpoch as a time in the value's own zone - the wall
// clock a repeating event keeps (10:00 stays 10:00 across a DST change).
func dtstartTime(params, rawValue string, loc *time.Location) (time.Time, bool) {
	value := strings.TrimSpace(rawValue)
	m := dtRE.FindStringSubmatch(value)
	if m == nil {
		return time.Time{}, false
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
		tzid = strings.Trim(tzid, `"`) // TZID="Europe/Madrid" is legal RFC 5545 too
		zone = Location(&tzid)
	default:
		zone = loc // floating: the calendar owner's own zone
	}
	if zone == nil {
		zone = time.Local
	}

	return time.Date(n[0], time.Month(n[1]), n[2], n[3], n[4], n[5], 0, zone), true
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
		ev      Event
		rrules  []string
	)

	for _, line := range unfold(text) {
		switch {
		case line == "BEGIN:VEVENT":
			inEvent, uid, summary, start = true, "", "", nil
			ev, rrules = Event{}, nil

		case line == "END:VEVENT":
			if inEvent {
				ev.UID, ev.Summary, ev.StartEpoch = uid, summary, start
				if start != nil && len(rrules) == 1 { // a second RRULE: a rule we do not read
					ev.rule = parseRRule(rrules[0], ev.start.Location())
				}
				events = append(events, ev)
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
			start = nil
			if t, ok := dtstartTime(params, value, loc); ok {
				start, ev.start = ptrInt64(t.Unix()), t
			}

		case strings.HasPrefix(line, "RRULE:"):
			rrules = append(rrules, line[len("RRULE:"):])

		case strings.HasPrefix(line, "EXDATE"):
			params, value, _ := strings.Cut(line, ":")
			for _, v := range strings.Split(value, ",") {
				if t, ok := dtstartTime(params, v, loc); ok {
					if ev.exdates == nil {
						ev.exdates = map[int64]bool{}
					}
					ev.exdates[t.Unix()] = true
				}
			}

		case strings.HasPrefix(line, "RECURRENCE-ID"):
			params, value, _ := strings.Cut(line, ":")
			ev.recurID = dtstartEpoch(params, value, loc)
		}
	}

	// An override rings at its own DTSTART; the occurrence it replaces must
	// not ring as well.
	for _, o := range events {
		if o.recurID == nil {
			continue
		}
		for i := range events {
			m := &events[i]
			if m.UID == o.UID && m.recurID == nil {
				if m.exdates == nil {
					m.exdates = map[int64]bool{}
				}
				m.exdates[*o.recurID] = true
			}
		}
	}
	return events
}

// -----------------------------------------------------------------------------
// repeating events
// -----------------------------------------------------------------------------

// recurRule is one RRULE: FREQ DAILY / WEEKLY / MONTHLY / YEARLY with INTERVAL,
// COUNT or UNTIL, BYDAY (with an ordinal - "2TU", "-1FR" - on a monthly or
// yearly rule), BYMONTHDAY, BYMONTH, BYSETPOS and WKST. The occurrences are
// the ones the calendar's own screen shows (rrule.js, shared/ical.js): a
// DTSTART the rule does not match is not one of them.
type recurRule struct {
	freq       string // DAILY, WEEKLY, MONTHLY or YEARLY
	interval   int
	count      int       // 0: no COUNT
	until      time.Time // zero: no UNTIL; else the last instant allowed
	byday      []recurDay
	bymonthday []int // 1..31, or -1..-31 from the month's end
	bymonth    []time.Month
	bysetpos   []int // the n-th of each period's set, -1 = its last
	wkst       time.Weekday
}

// recurDay is one BYDAY entry: every such weekday of the period (n 0), or
// only the n-th one (-1: the last).
type recurDay struct {
	n  int
	wd time.Weekday
}

// icsDays maps BYDAY / WKST codes to Go's weekdays.
var icsDays = map[string]time.Weekday{
	"SU": time.Sunday, "MO": time.Monday, "TU": time.Tuesday, "WE": time.Wednesday,
	"TH": time.Thursday, "FR": time.Friday, "SA": time.Saturday,
}

// bydayRE is one BYDAY entry: an optional ordinal, then the weekday.
var bydayRE = regexp.MustCompile(`^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$`)

// recurMaxSteps caps one expansion: a daily rule from 1990 is ~13 000 steps.
// recurMaxYears is the same for a yearly rule, whose steps cost far more.
const (
	recurMaxSteps = 100000
	recurMaxYears = 1000
)

// recurInts reads a comma list of non-zero ints within [-max, max].
func recurInts(val string, max int) ([]int, bool) {
	var out []int
	for _, part := range strings.Split(val, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n == 0 || n < -max || n > max {
			return nil, false
		}
		out = append(out, n)
	}
	return out, true
}

// parseRRule reads an RRULE value, or nil when it is a rule we do not read
// (the event then rings on its first date only): FREQ HOURLY and finer,
// BYYEARDAY, BYWEEKNO, BYHOUR... `zone` is the event's: a date-only UNTIL
// means the end of that day there.
func parseRRule(value string, zone *time.Location) *recurRule {
	r := &recurRule{interval: 1, wkst: time.Monday}
	for _, part := range strings.Split(strings.TrimSpace(value), ";") {
		key, val, _ := strings.Cut(part, "=")
		switch strings.ToUpper(key) {
		case "FREQ":
			r.freq = strings.ToUpper(val)
		case "INTERVAL":
			n, err := strconv.Atoi(val)
			if err != nil || n < 1 {
				return nil
			}
			r.interval = n
		case "COUNT":
			n, err := strconv.Atoi(val)
			if err != nil || n < 1 {
				return nil
			}
			r.count = n
		case "UNTIL":
			if t, ok := dtstartTime("", val, zone); ok {
				r.until = t
			} else if d, err := time.ParseInLocation("20060102", strings.TrimSpace(val), zone); err == nil {
				r.until = d.AddDate(0, 0, 1).Add(-time.Second) // the whole day
			} else {
				return nil
			}
		case "BYDAY":
			for _, code := range strings.Split(strings.ToUpper(val), ",") {
				m := bydayRE.FindStringSubmatch(strings.TrimSpace(code))
				if m == nil {
					return nil
				}
				d := recurDay{wd: icsDays[m[2]]}
				if m[1] != "" {
					n, _ := strconv.Atoi(m[1])
					if n == 0 {
						return nil
					}
					d.n = n
				}
				r.byday = append(r.byday, d)
			}
		case "BYMONTHDAY":
			days, ok := recurInts(val, 31)
			if !ok {
				return nil
			}
			r.bymonthday = days
		case "BYMONTH":
			months, ok := recurInts(val, 12)
			if !ok {
				return nil
			}
			for _, m := range months {
				if m < 1 {
					return nil
				}
				r.bymonth = append(r.bymonth, time.Month(m))
			}
		case "BYSETPOS":
			pos, ok := recurInts(val, 366)
			if !ok {
				return nil
			}
			r.bysetpos = pos
		case "WKST":
			day, ok := icsDays[strings.ToUpper(val)]
			if !ok {
				return nil
			}
			r.wkst = day
		case "":
		default:
			return nil // BYYEARDAY, BYWEEKNO, BYHOUR, BYMINUTE...
		}
	}

	ordinal := false
	for _, d := range r.byday {
		ordinal = ordinal || d.n != 0
	}
	switch r.freq {
	case "DAILY":
		if ordinal {
			return nil // "2TU" means nothing inside one day
		}
	case "WEEKLY":
		if ordinal || r.bymonthday != nil {
			return nil // not allowed with WEEKLY (RFC 5545)
		}
	case "MONTHLY", "YEARLY":
	default:
		return nil
	}
	return r
}

// StartsBetween is every start of this event inside [from, to]: none for an
// all-day event, its one start for a plain one, each occurrence for a repeating
// one.
func (e Event) StartsBetween(from, to time.Time) []time.Time {
	if e.StartEpoch == nil {
		return nil
	}
	if e.rule == nil {
		s := time.Unix(*e.StartEpoch, 0)
		if s.Before(from) || s.After(to) || e.exdates[s.Unix()] {
			return nil
		}
		return []time.Time{s}
	}
	var out []time.Time
	e.rule.each(e.start, from, to, func(t time.Time) bool {
		if t.After(to) {
			return false
		}
		if !t.Before(from) && !e.exdates[t.Unix()] {
			out = append(out, t)
		}
		return true
	})
	return out
}

// each calls `yield` with the rule's occurrences from `s` on, in order, until
// it answers false, the rule ends, or a period starts after `to`. Every
// occurrence keeps s's wall clock in s's zone. With no COUNT to keep, it may
// start a little before `from` instead of at s: an old daily series is not
// walked from its first day.
//
// The `to` stop is what bounds a rule that never matches (BYMONTHDAY=31 with
// BYDAY=1MO): it yields nothing, so nothing else would end the walk. The step
// caps are the last guard: 1000 years is plenty for a yearly rule.
func (r *recurRule) each(s, from, to time.Time, yield func(time.Time) bool) {
	at := func(c civilDay) time.Time {
		return time.Date(c.y, c.m, c.d, s.Hour(), s.Minute(), s.Second(), 0, s.Location())
	}
	k := 0
	if r.count == 0 && from.After(s) {
		switch r.freq {
		case "DAILY":
			k = int(from.Sub(s).Hours()/24)/r.interval - 1
		case "WEEKLY":
			k = int(from.Sub(s).Hours()/(24*7))/r.interval - 1
		case "MONTHLY":
			k = ((from.Year()-s.Year())*12+int(from.Month()-s.Month()))/r.interval - 1
		case "YEARLY":
			k = (from.Year()-s.Year())/r.interval - 1
		}
		k = max(k, 0)
	}

	// The week s falls in, from WKST, and the weekdays as days after its start.
	var weekStart civilDay
	var offsets []int
	if r.freq == "WEEKLY" {
		weekStart = civil(s.Year(), s.Month(), s.Day()-(int(s.Weekday()-r.wkst)+7)%7)
		days := []time.Weekday{s.Weekday()}
		if len(r.byday) > 0 {
			days = nil
			for _, d := range r.byday {
				days = append(days, d.wd)
			}
		}
		for _, d := range days {
			offsets = append(offsets, (int(d-r.wkst)+7)%7)
		}
		sort.Ints(offsets)
	}

	limit := recurMaxSteps
	if r.freq == "YEARLY" {
		limit = recurMaxYears
	}
	n := 0
	for steps := 0; steps < limit; steps, k = steps+1, k+1 {
		// This period's set: one day, one week, one month or one year - and
		// its first day, past `to` = nothing more to look for.
		var set []civilDay
		var first civilDay
		switch r.freq {
		case "DAILY":
			c := civil(s.Year(), s.Month(), s.Day()+k*r.interval)
			first = c
			if r.monthOK(c) && r.monthDayOK(c) && r.weekdayOK(c) {
				set = []civilDay{c}
			}
		case "WEEKLY":
			first = civil(weekStart.y, weekStart.m, weekStart.d+k*7*r.interval)
			for _, off := range offsets {
				c := civil(first.y, first.m, first.d+off)
				if r.monthOK(c) {
					set = append(set, c)
				}
			}
		case "MONTHLY":
			first = civil(s.Year(), s.Month()+time.Month(k*r.interval), 1)
			if r.monthOK(first) {
				set = r.monthSet(first.y, first.m, s.Day(), nil)
			}
		case "YEARLY":
			y := s.Year() + k*r.interval
			first = civilDay{y, time.January, 1}
			switch {
			case len(r.bymonth) > 0:
				for _, m := range r.bymonth {
					set = append(set, r.monthSet(y, m, s.Day(), nil)...)
				}
			case len(r.bymonthday) > 0:
				var year []civilDay // BYDAY counted in the year: worked out once
				if len(r.byday) > 0 {
					year = r.bydayIn(y, 0)
				}
				for m := time.January; m <= time.December; m++ {
					set = append(set, r.monthSet(y, m, s.Day(), year)...)
				}
			case len(r.byday) > 0:
				set = r.bydayIn(y, 0)
			default:
				set = r.monthSet(y, s.Month(), s.Day(), nil)
			}
		}
		if time.Date(first.y, first.m, first.d, 0, 0, 0, 0, s.Location()).After(to) {
			return
		}
		set = r.setPos(sortDays(set))

		for _, c := range set {
			t := at(c)
			if t.Before(s) {
				continue // the first period, before the series starts
			}
			if !r.until.IsZero() && t.After(r.until) {
				return
			}
			n++
			if !yield(t) || (r.count > 0 && n >= r.count) {
				return
			}
		}
	}
}

// civilDay is a date with no clock and no zone: the calendar arithmetic runs
// on these, the wall clock is put back on at the end.
type civilDay struct {
	y int
	m time.Month
	d int
}

// civil normalises y-m-d (the 32nd of a month is the 1st of the next).
func civil(y int, m time.Month, d int) civilDay {
	t := time.Date(y, m, d, 12, 0, 0, 0, time.UTC)
	return civilDay{t.Year(), t.Month(), t.Day()}
}

func (c civilDay) weekday() time.Weekday {
	return time.Date(c.y, c.m, c.d, 12, 0, 0, 0, time.UTC).Weekday()
}

func (c civilDay) before(o civilDay) bool {
	if c.y != o.y {
		return c.y < o.y
	}
	if c.m != o.m {
		return c.m < o.m
	}
	return c.d < o.d
}

func daysIn(y int, m time.Month) int {
	return time.Date(y, m+1, 0, 12, 0, 0, 0, time.UTC).Day()
}

// sortDays sorts and drops repeats (BYMONTHDAY=1 with BYDAY=1MO can name
// one day twice).
func sortDays(set []civilDay) []civilDay {
	sort.Slice(set, func(i, j int) bool { return set[i].before(set[j]) })
	out := set[:0]
	for _, c := range set {
		if len(out) == 0 || c != out[len(out)-1] {
			out = append(out, c)
		}
	}
	return out
}

func (r *recurRule) monthOK(c civilDay) bool {
	if len(r.bymonth) == 0 {
		return true
	}
	for _, m := range r.bymonth {
		if m == c.m {
			return true
		}
	}
	return false
}

func (r *recurRule) monthDayOK(c civilDay) bool {
	if len(r.bymonthday) == 0 {
		return true
	}
	last := daysIn(c.y, c.m)
	for _, d := range r.bymonthday {
		if d == c.d || (d < 0 && last+1+d == c.d) {
			return true
		}
	}
	return false
}

// weekdayOK is BYDAY as a filter of bare weekdays (DAILY).
func (r *recurRule) weekdayOK(c civilDay) bool {
	if len(r.byday) == 0 {
		return true
	}
	wd := c.weekday()
	for _, d := range r.byday {
		if d.wd == wd {
			return true
		}
	}
	return false
}

// monthSet is the days of month y-m the rule names: its BYMONTHDAY (kept only
// on a BYDAY day when both are there), else its BYDAY, else `day` - which a
// shorter month does not have (the 31st, 29 February): no occurrence then.
// `year`: the BYDAY days counted in the whole year (a yearly rule with no
// BYMONTH, bydayIn(y, 0)); nil = counted in the month.
func (r *recurRule) monthSet(y int, m time.Month, day int, year []civilDay) []civilDay {
	last := daysIn(y, m)
	switch {
	case len(r.bymonthday) > 0:
		var set []civilDay
		for _, d := range r.bymonthday {
			if d < 0 {
				d = last + 1 + d
			}
			if d >= 1 && d <= last {
				set = append(set, civilDay{y, m, d})
			}
		}
		if len(r.byday) == 0 {
			return set
		}
		days := year
		if days == nil {
			days = r.bydayIn(y, m)
		}
		allowed := map[civilDay]bool{}
		for _, c := range days {
			allowed[c] = true
		}
		kept := set[:0]
		for _, c := range set {
			if allowed[c] {
				kept = append(kept, c)
			}
		}
		return kept
	case len(r.byday) > 0:
		return r.bydayIn(y, m)
	case day <= last:
		return []civilDay{{y, m, day}}
	}
	return nil
}

// bydayIn is the BYDAY days of month y-m, or of the whole year y when m is 0:
// every such weekday, or the n-th one (-1: the last).
func (r *recurRule) bydayIn(y int, m time.Month) []civilDay {
	first, days := civilDay{y, m, 1}, 0
	if m == 0 {
		first = civilDay{y, time.January, 1}
		days = time.Date(y, 12, 31, 12, 0, 0, 0, time.UTC).YearDay()
	} else {
		days = daysIn(y, m)
	}
	var set []civilDay
	for _, bd := range r.byday {
		var all []civilDay
		for i := 0; i < days; i++ {
			c := civil(first.y, first.m, 1+i)
			if c.weekday() == bd.wd {
				all = append(all, c)
			}
		}
		switch {
		case bd.n == 0:
			set = append(set, all...)
		case bd.n > 0 && bd.n <= len(all):
			set = append(set, all[bd.n-1])
		case bd.n < 0 && -bd.n <= len(all):
			set = append(set, all[len(all)+bd.n])
		}
	}
	return sortDays(set)
}

// setPos keeps the BYSETPOS members of one period's sorted set.
func (r *recurRule) setPos(set []civilDay) []civilDay {
	if len(r.bysetpos) == 0 {
		return set
	}
	var out []civilDay
	for _, p := range r.bysetpos {
		switch {
		case p > 0 && p <= len(set):
			out = append(out, set[p-1])
		case p < 0 && -p <= len(set):
			out = append(out, set[len(set)+p])
		}
	}
	return sortDays(out)
}
