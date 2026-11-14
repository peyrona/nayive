package main

// =============================================================================
// search_all.go - the launcher's search: contacts, events, chats and notes at once.
// =============================================================================
//
//	GET /api/search?in=contacts,events,chats,notes&name=has:ana&name=not:pérez
//	                &from=<text>&since=<unix s>&until=<unix s>&tz=<zone>&limit=N
//
// Read only: it never writes anything. Files are Drive's search
// (/api/files?search=1) and mail is eMail's (/api/mail/<a>/list?q=); the
// launcher asks those itself, beside this.
//
//	in      the kinds wanted (default: all four)
//	name    repeated; the rules of Drive's search (search.go): "has" and "not"
//	        are what the launcher sends - a word or "phrase" that must, or must
//	        not, be somewhere in the record. Folded like every search
//	        (accents, case, ß, umlauts both ways). No rule: every record.
//	from    chats only: the sender's name holds this text
//	since   events and chats: at or after (unix s)
//	until   events and chats: before (unix s)
//	tz      the page's zone: an all-day event's day starts at ITS midnight
//	limit   per kind (default 50, at most 200)
//
// Answer: {"contacts": [...], "events": [...], "chats": [...], "notes": [...],
// "more": {"contacts": bool, ...}} - only the kinds asked for. A filter a
// kind has nothing to test with (a date on a contact, "from" on an event)
// leaves that kind out: the page does not ask for it then.
//
// The admin has no contacts, calendar, chat or notes: every list is empty.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	searchAllLimit = 50
	searchAllMax   = 200
)

// ContactHit is one card found: contact/index.html?uid=<uid>.
type ContactHit struct {
	UID   string `json:"uid"`
	Name  string `json:"name"`
	Email string `json:"email,omitempty"`
	Tel   string `json:"tel,omitempty"`
	Org   string `json:"org,omitempty"`
}

// EventHit is one event found: calendar/index.html?date=<day>. A repeating
// one is listed once, at its next start (or its first, when none is to come).
type EventHit struct {
	UID   string `json:"uid"`
	Title string `json:"title"`
	At    int64  `json:"at,omitempty"` // unix s; 0 for an all-day event
	Day   string `json:"day"`          // "2006-01-02" on the page's clock
	Where string `json:"where,omitempty"`
	Rep   bool   `json:"rep,omitempty"` // it repeats
}

// NoteHit is one quick note found (shared/notes.js, data/notes/notes.json):
// the launcher opens it in place. Text is a snippet around the first word.
type NoteHit struct {
	ID     string `json:"id"`
	Title  string `json:"title,omitempty"`
	Text   string `json:"text,omitempty"`
	Color  *int   `json:"color,omitempty"`
	Pinned bool   `json:"pinned,omitempty"`
}

type searchAll struct {
	rules        []nameRule
	from         []string // foldForms
	since, until int64
	loc          *time.Location
	limit        int
}

// text is true when every rule holds somewhere in `fields`.
func (q searchAll) text(fields ...string) bool {
	if len(q.rules) == 0 {
		return true
	}
	all := foldForms(strings.Join(fields, "\n"))
	for _, r := range q.rules {
		if !r.match(all) {
			return false
		}
	}
	return true
}

// snip is up to snipLen runes of text around the first word the search
// asked for (a "has" rule), so a hit deep in a long message still shows.
func (q searchAll) snip(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) <= snipLen {
		return text
	}
	at := 0
	for _, r := range q.rules {
		if r.op != "has" && r.op != "starts" {
			continue
		}
		// fold rune by rune, so a place in the folded text is one in `runes`
		var b strings.Builder
		var owner []int
		for i, c := range runes {
			f := fold(string(c))
			b.WriteString(f)
			for range len(f) {
				owner = append(owner, i)
			}
		}
		if k := strings.Index(b.String(), r.texts[0]); k >= 0 {
			at = owner[k]
		}
		break
	}
	start := max(0, at-snipLen/3)
	end := min(len(runes), start+snipLen)
	start = max(0, end-snipLen)
	out := string(runes[start:end])
	if start > 0 {
		out = "…" + out
	}
	if end < len(runes) {
		out += "…"
	}
	return out
}

const snipLen = 160

// in is true when unix second t is within [since, until).
func (q searchAll) in(t int64) bool {
	return (q.since == 0 || t >= q.since) && (q.until == 0 || t < q.until)
}

func (s *Server) apiSearchAll(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		sendError(w, r, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	raw := Query(r.URL.Query())
	rules, err := parseNameRules(raw["name"])
	if err != nil {
		sendError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	q := searchAll{rules: rules, limit: searchAllLimit}
	if f := strings.TrimSpace(raw.Get("from")); fold(f) != "" {
		q.from = foldForms(f)
	}
	for _, b := range []struct {
		key string
		dst *int64
	}{{"since", &q.since}, {"until", &q.until}} {
		if v := raw.Get(b.key); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n < 0 {
				sendError(w, r, http.StatusBadRequest, "bad "+b.key)
				return
			}
			*b.dst = n
		}
	}
	if v := raw.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			sendError(w, r, http.StatusBadRequest, "bad limit")
			return
		}
		q.limit = min(n, searchAllMax)
	}
	tz := raw.Get("tz")
	if q.loc = Location(&tz); q.loc == nil {
		if q.loc = Location(s.users.UserTZ("user", sess.User)); q.loc == nil {
			q.loc = time.Local
		}
	}

	want := map[string]bool{"contacts": true, "events": true, "chats": true, "notes": true}
	if v := raw.Get("in"); v != "" {
		want = map[string]bool{}
		for _, k := range strings.Split(v, ",") {
			want[strings.TrimSpace(k)] = true
		}
	}
	dated := q.since > 0 || q.until > 0
	out := map[string]any{}
	more := map[string]bool{}
	user := ""
	if sess.Role == "user" {
		user = sess.User
	}
	home := filepath.Join(s.cfg.HomesDir, user, "data")

	if want["contacts"] && !dated && q.from == nil {
		hits := []ContactHit{}
		if user != "" {
			hits = searchContacts(filepath.Join(home, "contacts.vcf"), q)
		}
		out["contacts"], more["contacts"] = cutHits(hits, q.limit)
	}
	if want["events"] && q.from == nil {
		hits := []EventHit{}
		if user != "" {
			hits = searchEvents(filepath.Join(home, "calendar.ics"), q, time.Now())
		}
		out["events"], more["events"] = cutHits(hits, q.limit)
	}
	if want["chats"] {
		hits := []ChatHit{}
		if user != "" {
			hits, more["chats"] = s.chat.Search(user, func(text, from string, at int64) bool {
				if !q.in(at / 1000) {
					return false
				}
				if q.from != nil && !anyForm(foldForms(from), q.from, strings.Contains) {
					return false
				}
				return q.text(text)
			}, q.snip, q.limit)
		}
		out["chats"] = hits
	}
	if want["notes"] && !dated && q.from == nil {
		hits := []NoteHit{}
		if user != "" {
			hits = searchNotes(filepath.Join(home, "notes", "notes.json"), q)
		}
		out["notes"], more["notes"] = cutHits(hits, q.limit)
	}
	out["more"] = more
	sendJSON(w, r, http.StatusOK, out)
}

func cutHits[T any](hits []T, n int) ([]T, bool) {
	if len(hits) > n {
		return hits[:n], true
	}
	return hits, false
}

// searchContacts reads the Contacts app's file (vcardLines, mail_compose.go)
// and answers its cards that hold every rule, by name.
func searchContacts(path string, q searchAll) []ContactHit {
	hits := []ContactHit{}
	f, err := os.Open(path)
	if err != nil {
		return hits
	}
	defer f.Close()
	var (
		card   ContactHit
		fields []string
	)
	for _, l := range vcardLines(f) {
		key, val, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		params := strings.Split(strings.ToUpper(key), ";")
		prop := params[0]
		if i := strings.IndexByte(prop, '.'); i >= 0 { // "item1.EMAIL"
			prop = prop[i+1:]
		}
		v := strings.TrimSpace(vcardUnescape(vcardDecode(val, params[1:], strings.Split(key, ";")[1:])))
		switch prop {
		case "BEGIN":
			card, fields = ContactHit{}, nil
		case "UID":
			card.UID = v
		case "FN":
			card.Name = v
			fields = append(fields, v)
		case "N", "NICKNAME", "TITLE", "NOTE", "CATEGORIES", "ADR":
			fields = append(fields, strings.ReplaceAll(v, ";", " "))
		case "ORG":
			org := strings.TrimSpace(strings.ReplaceAll(v, ";", " "))
			if card.Org == "" {
				card.Org = org
			}
			fields = append(fields, org)
		case "EMAIL":
			if card.Email == "" {
				card.Email = v
			}
			fields = append(fields, v)
		case "TEL":
			if card.Tel == "" {
				card.Tel = v
			}
			// "669816" finds "+34 669 81 65 18" too
			fields = append(fields, v, strings.Map(func(r rune) rune {
				if r >= '0' && r <= '9' || r == '+' {
					return r
				}
				return -1
			}, v))
		case "END":
			if card.Name == "" {
				card.Name = card.Email
			}
			if card.UID != "" && card.Name != "" && q.text(fields...) {
				hits = append(hits, card)
			}
			card, fields = ContactHit{}, nil
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return fold(hits[i].Name) < fold(hits[j].Name) })
	return hits
}

// searchNotes reads the quick notes and answers those that hold every rule in
// their title, text or (an old checklist's) items: pinned first, then the
// latest changed. A missing or damaged file finds nothing.
func searchNotes(path string, q searchAll) []NoteHit {
	hits := []NoteHit{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return hits
	}
	var list []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Text  string `json:"text"`
		Items []struct {
			Text string `json:"text"`
		} `json:"items"`
		Pinned  bool    `json:"pinned"`
		Color   *int    `json:"color"`
		Updated float64 `json:"updated"`
	}
	if json.Unmarshal(raw, &list) != nil {
		return hits
	}
	type found struct {
		NoteHit
		at float64
	}
	var all []found
	for _, n := range list {
		body := n.Text
		for _, it := range n.Items {
			body += "\n" + it.Text
		}
		if n.ID == "" || strings.TrimSpace(n.Title+body) == "" || !q.text(n.Title, body) {
			continue
		}
		all = append(all, found{NoteHit{ID: n.ID, Title: strings.TrimSpace(n.Title), Text: q.snip(body), Color: n.Color, Pinned: n.Pinned}, n.Updated})
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Pinned != all[j].Pinned {
			return all[i].Pinned
		}
		return all[i].at > all[j].at
	})
	for _, h := range all {
		hits = append(hits, h.NoteHit)
	}
	return hits
}

// searchEvents reads the calendar (ics.go) and answers the events that hold
// every rule and start within [since, until): coming ones first, soonest
// first; then past ones, latest first.
func searchEvents(path string, q searchAll, now time.Time) []EventHit {
	hits := []EventHit{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return hits
	}
	type found struct {
		EventHit
		when int64 // to sort by: the start, or the day's midnight
	}
	var all []found
	seen := map[string]int{} // UID -> index in all: an override of a series is the series
	for _, ev := range ParseEvents(string(raw), q.loc) {
		if !q.text(ev.Summary, ev.Location, ev.Desc) {
			continue
		}
		h := found{EventHit: EventHit{UID: ev.UID, Title: ev.Summary, Where: ev.Location, Rep: ev.rule != nil || ev.dayRule != nil}}
		day, series := ev.dayEvent(q.loc)
		switch {
		case series: // an all-day series (a birthday): its next day
			at, ok := eventWhen(day, q, now.Add(-24*time.Hour)) // today's still counts
			if !ok {
				continue
			}
			h.Day = time.Unix(at, 0).In(q.loc).Format("2006-01-02")
			h.when = at
		case ev.StartEpoch != nil:
			at, ok := eventWhen(ev, q, now)
			if !ok {
				continue
			}
			h.At, h.when = at, at
			h.Day = time.Unix(at, 0).In(q.loc).Format("2006-01-02")
		case ev.Day != "":
			d, err := time.ParseInLocation("2006-01-02", ev.Day, q.loc)
			if err != nil || !q.in(d.Unix()) {
				continue
			}
			h.Day, h.when = ev.Day, d.Unix()
		default:
			continue
		}
		if i, dup := seen[ev.UID]; dup && ev.UID != "" {
			if abs64(h.when-now.Unix()) < abs64(all[i].when-now.Unix()) {
				all[i] = h
			}
			continue
		}
		seen[ev.UID] = len(all)
		all = append(all, h)
	}
	t := now.Unix()
	sort.SliceStable(all, func(i, j int) bool {
		a, b := all[i].when, all[j].when
		if (a >= t) != (b >= t) {
			return a >= t
		}
		if a >= t {
			return a < b
		}
		return a > b
	})
	for _, h := range all {
		hits = append(hits, h.EventHit)
	}
	return hits
}

// eventWhen is the start to show for a timed event: a single one's own start;
// a repeating one's first start from now (or from `since`) up to `until` -
// when none is to come and no date was asked, its first start ever.
func eventWhen(ev Event, q searchAll, now time.Time) (int64, bool) {
	if ev.rule == nil {
		return *ev.StartEpoch, q.in(*ev.StartEpoch)
	}
	from := now
	if q.since > 0 {
		from = time.Unix(q.since, 0)
	} else if q.until > 0 {
		from = ev.start
	}
	to := from.AddDate(3, 0, 0)
	if q.until > 0 {
		to = time.Unix(q.until-1, 0) // StartsBetween's `to` is inclusive
	}
	if !to.Before(from) {
		for _, t := range ev.StartsBetween(from, to) {
			return t.Unix(), true
		}
	}
	if q.since == 0 && q.until == 0 {
		return *ev.StartEpoch, true
	}
	return 0, false
}

func abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}
