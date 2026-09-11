package main

// =============================================================================
// Native OS notifications for calendar events about to start.
// =============================================================================
//
// One background goroutine that, every pollInterval, reads each user's
// homes/<user>/data/calendar.ics and sends a Web Push message for every event
// whose start falls inside that user's window. The push service wakes the
// device even with the app closed, and apps/sw.js turns the message into a real
// notification in the OS notification centre.
//
// The same loop runs two chores (both safe to re-run on a restart): the session
// sweep every tick, and the trash sweep once a day.
//
// It also pushes a TRIP reminder: once a day, at tripHour on the USER's own
// clock, every homes/<user>/data/trips/<dir>/trip.json whose "startDate" falls
// within their lead time is announced. The Tasks app keeps doing its own thing -
// it adds a "Preparar viaje a ..." task when it opens - because the two are
// different channels: the task is the to-do you tick off, the push is what
// reaches you with every app closed. Both are keyed on the trip's id, so
// neither doubles up on itself.
//
// ONE NOTIFICATION PER DEVICE
// -----------------------------------------------------------------------------
// A user can have several devices - phone, tablet, laptop - each with its own
// subscription. Every one of them must ring, so the "already sent" key carries a
// short hash of the endpoint:
//
//	"<user>|<device>|<uid>@<epoch>"
//
// Keying it per user instead would mean the first device that succeeded marked
// the event done and the other two were never told. (The device id sits in the
// MIDDLE so keyEpoch's split-from-the-right still finds the timestamp.)
//
// Already-sent CALENDAR keys live in memory only. A server restart can
// re-announce an event that is still inside its window - rare, and harmless,
// because that window is minutes wide.
//
// A trip's window is DAYS wide, so the same trick there would re-ring on every
// restart. Trip keys are therefore saved, per user, in
//
//	homes/<user>/data/reminders.json     {"trips": ["<device>|<id>@<epoch>", ...]}
//
// (no user part - the file already belongs to one). The epoch is midnight AFTER
// the trip's start day, so the pruning rule ("drop keys whose epoch is past")
// keeps the key for the whole of that day.
//
// WHEN A DEVICE GOES AWAY
// -----------------------------------------------------------------------------
// A push service answers 404 or 410 Gone when a subscription no longer exists
// (browser uninstalled, permission revoked, profile wiped). That is permanent,
// so we drop it from push.json there and then. Every other failure - a busy
// service, a rate limit, no network - is transient and the device is kept.
//
// 401/403 is the dangerous one: it means OUR VAPID key is wrong, not that the
// device is gone. Pruning on it would wipe every subscription on the server in
// a single tick, so it is logged loudly and nothing is deleted.
//
// java: NO LOCKS IN THIS FILE. Every field of Reminders below is touched by the
// one goroutine Run owns, and by nothing else - which is why `sent`, `fails`,
// `events` and `tripDay` are plain maps. The Python needs the same discipline
// and states it in a comment; here the race detector enforces it.

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	pollInterval = 60 * time.Second  // how often every calendar is re-scanned
	dailyChore   = 24 * time.Hour    // the once-a-day chore (trash sweep)
	maxSummary   = 120               // an event title longer than this is cut
	tripHour     = 9                 // the hour (user's own clock) a trip reminder goes out
	dailySeconds = int(24 * 60 * 60) // the TTL a trip push is sent with
)

// isoDate is deliberately anchored at both ends, so "2026-9-5" and "tomorrow"
// are both rejected - trip dates are compared AS TEXT below and that only works
// while they are all exactly yyyy-mm-dd.
var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// Reminders is the background worker.
type Reminders struct {
	cfg      *Config
	users    *Users
	trash    *Trash
	sessions *SessionStore
	push     *VapidStore
	log      Logger

	sent      map[string]int64     // "<user>|<device>|<uid>@<epoch>" -> the epoch
	fails     map[string]int       // "<user>|<device>" -> consecutive send failures
	events    map[string]cachedICS // home name -> the parsed calendar
	tripDay   map[string]string    // user -> the "yyyy-mm-dd" its trips were last scanned
	lastDaily time.Time

	phrases *phrasebook // the UI's own dictionaries
}

type cachedICS struct {
	mtime  time.Time
	tzName string
	events []Event
}

func NewReminders(cfg *Config, users *Users, trash *Trash, sessions *SessionStore,
	push *VapidStore, log Logger) *Reminders {
	return &Reminders{
		cfg: cfg, users: users, trash: trash, sessions: sessions, push: push, log: log,
		sent:    make(map[string]int64),
		fails:   make(map[string]int),
		events:  make(map[string]cachedICS),
		tripDay: make(map[string]string),
		phrases: newPhrasebook(cfg.AppsDir),
	}
}

// Run drives the loop until `ctx` is cancelled. Start it once from main.
//
// java: this is the whole of Python's ReminderService, which subclasses Thread
// and sleeps on an interruptible Event. Here it is a `for { select {} }` over a
// ticker and the context, which is the idiomatic shape and needs no stop flag.
func (r *Reminders) Run(ctx context.Context) {
	r.log.Info("reminders: started", "every", pollInterval.String())
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	r.safeTick() // once immediately, so a restart does not lose a whole minute
	for {
		select {
		case <-ctx.Done():
			r.log.Debug("reminders: stopped")
			return
		case <-ticker.C:
			r.safeTick()
		}
	}
}

// safeTick makes one bad calendar file cost only that tick.
//
// java: an unrecovered panic in a goroutine kills the WHOLE PROCESS - it is not
// like an uncaught exception on one Java thread. Python's `except Exception` in
// the loop body is only politeness; here it is what keeps the server up.
func (r *Reminders) safeTick() {
	defer func() {
		if err := recover(); err != nil {
			r.log.Error("reminders: tick failed", "err", err)
		}
	}()
	r.tick()
}

func (r *Reminders) tick() {
	now := time.Now()

	// Drop expired sessions every tick (cheap - just a map scan).
	r.sessions.Sweep()

	// Once a day (and once on the first tick after a restart): drop trashed
	// items past their retention period.
	if now.Sub(r.lastDaily) >= dailyChore {
		r.lastDaily = now
		r.trash.SweepExpired(r.cfg.TrashDays)
	}

	homes, err := os.ReadDir(r.cfg.HomesDir)
	if err != nil {
		return
	}
	sort.SliceStable(homes, func(i, j int) bool { return homes[i].Name() < homes[j].Name() })

	for _, home := range homes {
		if !home.IsDir() {
			continue
		}
		user := home.Name()

		cfg := r.users.UserPush(user)
		if len(cfg.Subs) == 0 {
			continue // no device registered: the same "nothing to do" as no calendar
		}
		window := time.Duration(cfg.WindowMinutes) * time.Minute
		tzName := r.userTZName(user)
		loc := Location(tzName)

		// Trips first: a user with no calendar file at all still gets these.
		r.tripTick(user, cfg.Subs, loc)

		events, ok := r.eventsFor(user, tzName, loc)
		if !ok {
			continue
		}
		for _, ev := range events {
			if ev.StartEpoch == nil {
				continue // all-day
			}
			start := time.Unix(*ev.StartEpoch, 0)
			if start.Before(now) || start.After(now.Add(window)) {
				continue
			}
			r.announce(user, cfg.Subs, ev, start, window, loc)
		}
	}

	// Forget keys whose event is now in the past, so the map cannot grow for ever.
	for key, epoch := range r.sent {
		if epoch < now.Unix() {
			delete(r.sent, key)
		}
	}
}

// announce pushes one event to every device of `user` that has not had it yet.
func (r *Reminders) announce(user string, subs []PushSub, ev Event, start time.Time,
	window time.Duration, loc *time.Location) {

	hhmm := formatHHMM(start, loc)
	for _, sub := range subs {
		dev := deviceID(sub.Endpoint)
		key := fmt.Sprintf("%s|%s|%s@%d", user, dev, ev.UID, start.Unix())
		if _, already := r.sent[key]; already {
			continue
		}
		title, body := r.eventText(sub.Lang, ev.Summary, hhmm)
		payload := map[string]string{
			"title": title,
			"body":  body,
			"url":   URLPrefix + "/calendar/",
			"tag":   ev.UID,
		}
		if r.send(user, sub, dev, payload, int(window.Seconds())) {
			r.sent[key] = start.Unix()
			r.log.Info("reminders: sent", "user", user, "event", ev.Summary)
		}
	}
}

// send POSTs one message to one device and deals with the answer. True when the
// push service accepted it (2xx) - the caller then marks it as sent.
//
// deliverPush (push_send.go) is the ONLY place that reads a status code. See
// WHEN A DEVICE GOES AWAY at the top: 404/410 is permanent and prunes the
// device, 401/403 is OUR key being wrong and must never prune. What is left -
// transient - is only counted here.
func (r *Reminders) send(user string, sub PushSub, dev string, payload any, ttl int) bool {
	status, err := deliverPush(r.push, r.users, r.log, user, sub, payload, ttl)
	fkey := user + "|" + dev

	if status >= 200 && status < 300 {
		delete(r.fails, fkey) // clear the failure counter
		return true
	}

	if pushTransient(status) {
		n := r.fails[fkey] + 1
		r.fails[fkey] = n
		if n == 1 || n%30 == 0 { // once, then hourly-ish, not every tick
			r.log.Warn("reminders: push failing", "user", user, "times", n, "err", err)
		}
	}
	return false
}

// -----------------------------------------------------------------------------
// Trips: one push per trip about to start
// -----------------------------------------------------------------------------

// tripTick is the once-a-day trip scan for one user, or nothing at all.
//
// The gate is the user's OWN clock, not the server's uptime: a trip lands at
// tripHour wherever they are, and stays at that hour across restarts. (Hanging
// it off the daily chore instead would move it to whatever time the process
// happened to boot.)
func (r *Reminders) tripTick(user string, subs []PushSub, loc *time.Location) {
	// ONE now() per user - the hour test and the date must not straddle a
	// midnight between two separate calls.
	stamp := time.Now()
	if loc != nil {
		stamp = stamp.In(loc)
	}
	today := stamp.Format("2006-01-02")

	if stamp.Hour() < tripHour || r.tripDay[user] == today {
		return
	}

	lead := r.users.UserTripReminderDays(user) // 0 = this user wants none
	// Called even with nothing due, and even when they are off: that is also
	// where a trip that has now been and gone loses its saved key.
	var trips []dueTrip
	if lead > 0 {
		trips = r.tripsDue(user, lead, today)
	}
	r.announceTrips(user, subs, trips, loc)

	// Marked only now, and only for a user who got this far (they have at least
	// one device): someone who registers their first one at noon is scanned
	// today, not tomorrow.
	r.tripDay[user] = today
}

type dueTrip struct {
	id    string
	dest  string
	start string // yyyy-mm-dd
}

// announceTrips pushes every due trip to every device that has not had it yet,
// then saves the keys - once, after the whole fan-out.
//
// `trips` may be empty and this still has work to do: the save at the end is
// what drops the keys of trips already past, so the file cannot grow for ever.
// Nothing new and nothing stale means no write at all, so a user with no trips
// never even gets the file.
func (r *Reminders) announceTrips(user string, subs []PushSub, trips []dueTrip, loc *time.Location) {
	path := filepath.Join(r.cfg.HomesDir, user, "data", "reminders.json")
	saved := loadTripKeys(path)

	keys := make(map[string]bool, len(saved))
	for k := range saved {
		keys[k] = true
	}

	for _, trip := range trips {
		epoch := tripKeyEpoch(trip.start, loc)
		for _, sub := range subs {
			dev := deviceID(sub.Endpoint)
			key := fmt.Sprintf("%s|%s@%d", dev, trip.id, epoch)
			if keys[key] {
				continue
			}
			title, body := r.tripText(sub.Lang, trip.dest, trip.start)
			payload := map[string]string{
				"title": title,
				"body":  body,
				"url":   URLPrefix + "/trips/",
				"tag":   "trip-" + trip.id,
			}
			if r.send(user, sub, dev, payload, dailySeconds) {
				keys[key] = true
				r.log.Info("reminders: trip sent", "user", user, "dest", trip.dest, "start", trip.start)
			}
		}
	}

	// The same pruning rule as `sent`, and it is why the epoch is the day AFTER.
	now := time.Now().Unix()
	keep := make(map[string]bool)
	for k := range keys {
		if keyEpoch(k) >= now {
			keep[k] = true
		}
	}
	if !sameKeySet(keep, saved) { // nothing new and nothing stale -> no write
		saveTripKeys(path, keep, r.log)
	}
}

// tripJSON is just enough of a trip.json to decide whether it is due.
type tripSummary struct {
	ID          json.RawMessage `json:"id"`
	Destination string          `json:"destination"`
	StartDate   string          `json:"startDate"`
}

// tripsDue lists every data/trips/<dir>/trip.json starting between today and
// `lead` days ahead.
//
// The same rule the Tasks app applies for its "Preparar viaje" task, including
// "a trip that starts today still counts". Dates are yyyy-mm-dd, so a plain
// string comparison IS a date comparison.
func (r *Reminders) tripsDue(user string, lead int, today string) []dueTrip {
	out := []dueTrip{}

	start, err := time.Parse("2006-01-02", today)
	if err != nil {
		return out
	}
	last := start.AddDate(0, 0, lead).Format("2006-01-02")

	tripsDir := filepath.Join(r.cfg.HomesDir, user, "data", "trips")
	entries, err := os.ReadDir(tripsDir)
	if err != nil {
		return out // no trips folder yet (or unreadable)
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		var trip tripSummary
		// A half-written or hand-mangled trip.json simply reads as empty and is
		// skipped by the checks below.
		loadJSONFile(filepath.Join(tripsDir, e.Name(), "trip.json"), &trip)

		id := strings.Trim(string(trip.ID), `"`)
		dest := strings.TrimSpace(trip.Destination)
		day := strings.TrimSpace(trip.StartDate)
		if id == "" || id == "null" || dest == "" || !validDate(day) {
			continue
		}
		if today <= day && day <= last {
			out = append(out, dueTrip{id: id, dest: dest, start: day})
		}
	}
	return out
}

// -----------------------------------------------------------------------------
// the calendar cache
// -----------------------------------------------------------------------------

// eventsFor is the parsed events of homes/<user>/data/calendar.ics, re-parsed
// only when the file's mtime changed since the last tick.
//
// A floating DTSTART is read in the OWNER's zone, so the cache is keyed on the
// zone name as well as the mtime: change your timezone and the same unchanged
// file has to be re-read, or every floating event would keep the old wall clock
// until the calendar happened to be edited.
func (r *Reminders) eventsFor(user string, tzName *string, loc *time.Location) ([]Event, bool) {
	path := filepath.Join(r.cfg.HomesDir, user, "data", "calendar.ics")
	info, err := os.Stat(path)
	if err != nil {
		delete(r.events, user)
		return nil, false // no calendar (or unreadable)
	}
	name := ""
	if tzName != nil {
		name = *tzName
	}
	if hit, found := r.events[user]; found && hit.mtime.Equal(info.ModTime()) && hit.tzName == name {
		return hit.events, true
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	// java: Go strings are just bytes; invalid UTF-8 survives the round trip
	// and only the regex-matched ASCII of a DTSTART is ever interpreted. That
	// is the same tolerance Python's errors="replace" buys.
	events := ParseEvents(string(raw), loc)
	r.events[user] = cachedICS{mtime: info.ModTime(), tzName: name, events: events}
	return events, true
}

// userTZName is the "tz" string in homes/<user>/data/config.json, or nil.
func (r *Reminders) userTZName(user string) *string {
	return r.users.UserTZ("user", user)
}

// -----------------------------------------------------------------------------
// the notification text
// -----------------------------------------------------------------------------

// phrase is one string from the UI's own apps/shared/i18n/<lang>.json, falling
// back lang -> es -> a built-in string (see phrasebook in push_send.go).
//
// The notification text lives in the SAME dictionaries the interface uses, so a
// translator edits one place and tools/check-i18n keeps them honest.
func (r *Reminders) phrase(lang, key, builtin string) string {
	return r.phrases.phrase(lang, key, builtin)
}

// eventText is (title, body) for one event, in the language THIS DEVICE
// subscribed in.
//
// java: the substitution is a plain string Replace, never a format call. An
// event called "Reunion {equipo}" would make Python's str.format raise and lose
// the notification entirely; Go's Sprintf would print "%!e(MISSING)" into the
// user's phone. Replace cannot fail on user text.
func (r *Reminders) eventText(lang, summary, hhmm string) (string, string) {
	title := r.phrase(lang, "push.eventTitle", "Recordatorio")
	body := r.phrase(lang, "push.eventBody", "«{summary}» empieza a las {time}.")
	return title, strings.NewReplacer("{summary}", ellipsis(summary), "{time}", hhmm).Replace(body)
}

// tripText is the same for one trip.
func (r *Reminders) tripText(lang, dest, start string) (string, string) {
	title := r.phrase(lang, "push.tripTitle", "Viaje próximo")
	body := r.phrase(lang, "push.tripBody", "Preparar viaje a {dest} (sale el {date}).")
	return title, strings.NewReplacer("{dest}", ellipsis(dest), "{date}", start).Replace(body)
}

// ellipsis cuts an over-long title, counting RUNES rather than bytes so an
// accented word is never chopped in half.
func ellipsis(text string) string {
	runes := []rune(text)
	if len(runes) <= maxSummary {
		return text
	}
	return string(runes[:maxSummary-1]) + "…"
}

// -----------------------------------------------------------------------------
// keys, dates and clocks
// -----------------------------------------------------------------------------

// deviceID is a short, stable id for one browser. Endpoints are long and are a
// capability to notify that user, so they never go in a log line or a key.
func deviceID(endpoint string) string {
	sum := sha1.Sum([]byte(endpoint))
	return hex.EncodeToString(sum[:])[:8]
}

// keyEpoch reads the timestamp off the end of an "...@12345" key.
func keyEpoch(key string) int64 {
	i := strings.LastIndex(key, "@")
	if i < 0 {
		return 0
	}
	n, err := strconv.ParseInt(key[i+1:], 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// validDate is true for a real "yyyy-mm-dd".
//
// Both halves matter. The regex alone would pass "2026-02-30", which the parse
// then rejects - and one mistyped trip.json must never cost that user the rest
// of their reminders. The parse alone is not enough either: it would accept
// other layouts, and the due test compares these dates AS TEXT.
func validDate(text string) bool {
	if !isoDate.MatchString(text) {
		return false
	}
	_, err := time.Parse("2006-01-02", text)
	return err == nil
}

// tripKeyEpoch is midnight AFTER the trip's start day, in `loc` (the server's
// own zone when nil), as epoch seconds.
//
// The "already sent" key carries this, and keys are pruned once their epoch is
// past. Using the start day's own midnight would prune the key hours before the
// day it belongs to is over, and a restart that afternoon would ring the same
// trip twice.
func tripKeyEpoch(start string, loc *time.Location) int64 {
	if loc == nil {
		loc = time.Local
	}
	d, err := time.ParseInLocation("2006-01-02", start, loc)
	if err != nil {
		return 0
	}
	return d.AddDate(0, 0, 1).Unix()
}

// formatHHMM is "HH:MM" for a moment, in `loc` when given, otherwise in the
// server's own local time (last resort).
func formatHHMM(t time.Time, loc *time.Location) string {
	if loc != nil {
		return t.In(loc).Format("15:04")
	}
	return t.Local().Format("15:04")
}

// -----------------------------------------------------------------------------
// the saved trip keys
// -----------------------------------------------------------------------------

// loadTripKeys reads one user's saved keys. Tolerant on read: a missing,
// malformed or hand-edited reminders.json is "nothing sent yet".
func loadTripKeys(path string) map[string]bool {
	out := make(map[string]bool)
	raw, found := loadOrderedJSON(path).Get("trips")
	if !found {
		return out
	}
	var trips []string
	if json.Unmarshal(raw, &trips) != nil {
		return out // a stray {"trips": 7} must not be iterated
	}
	for _, k := range trips {
		out[k] = true
	}
	return out
}

// saveTripKeys writes those keys back, KEEPING every other field the file may
// hold - it is this loop's own state file and may grow later.
//
// No lock: this goroutine is their only writer. atomicWriteJSON still means a
// reader never catches the file half-written.
func saveTripKeys(path string, keys map[string]bool, log Logger) {
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted) // a stable, diffable file

	file := loadOrderedJSON(path)
	file.Put("trips", sorted)

	if err := atomicWriteJSON(path, file, 4); err != nil {
		// A full disk must not stop the pushes; it only means the next restart
		// may repeat today's trip reminder.
		log.Error("reminders: cannot save trip keys", "path", path, "err", err)
	}
}

func sameKeySet(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}
