package main

// =============================================================================
// Location alerts: "turn the location app on / off" around each trip.
// =============================================================================
//
// A location app (location.go) only sends while it runs, and running costs
// battery. So a user whose location URL is on gets two pushes for every trip
// that keeps positions ("track" not false in its trip.json):
//
//	ON   2 h before the trip starts   "turn the location app on"
//	OFF  2 h after the trip ends      "you can turn it off"
//
// When a trip starts and ends comes from the best there is:
//
//	start  the earliest departure time of a stage leaving on the trip's first
//	       day; with none, that day's 00:00 - ON then rings at 22:00 the
//	       evening before.
//	end    the latest arrival time of a stage arriving on the trip's last day;
//	       with none, OFF rings the next morning at tripHour: the trip is
//	       surely over, and 02:00 would wake the phone for nothing.
//
// Every time is on the OWNER's clock - the clock positions.go uses to decide
// which days a trip keeps. Switched-off stages count for nothing.
//
// An alert has a window, not a minute, so a restart or a busy push service only
// delays it: ON from its moment until OFF's (a trip made, or a phone
// registered, mid-trip still gets it), OFF for locationOffWindow.
//
// Back-to-back trips: an alert whose moment falls strictly INSIDE another
// trip's span (that trip's ON to its OFF) is skipped - the app must simply stay
// on. Otherwise a trip ending on the 15th and the next starting on the 16th,
// both without times, would say "turn it on" at 22:00 and "turn it off" the
// morning after.
//
// Sent keys are saved like the trip reminder's, in reminders.json beside
// "trips":
//
//	"location": ["<device>|<id>|on<moment>@<epoch>", ...]
//
// <moment> is when the alert was due, so a trip moved to other dates rings again
// at its new time. <epoch> is the END of the alert's window, so the pruning rule
// keeps the key as long as the alert could ring; it is matched without it,
// because a trip made longer mid-way moves ON's window end but must not ring ON
// twice.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	locationLead      = 2 * time.Hour  // ON this long before a trip starts, OFF this long after it ends
	locationOffWindow = 24 * time.Hour // how late an OFF may still go out
)

// clockText is the "HH:MM" a stage's time field starts with.
var clockText = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d`)

// locationTrip is what the alerts read of a trip.json.
type locationTrip struct {
	ID json.RawMessage `json:"id"`
	publicTripFile
	dir string // its folder name: the destination when it has none
}

// locationAlert is one push due for one trip.
type locationAlert struct {
	id    string
	dest  string
	on    bool      // true = "turn it on", false = "you can turn it off"
	at    time.Time // when it was due
	until time.Time // the end of its window
}

// locationTick sends one user's location alerts - only while their location URL
// is on: without one there is no app to turn on or off.
func (r *Reminders) locationTick(user string, subs []PushSub, loc *time.Location) {
	if r.trackers == nil || r.trackers.For(user) == nil {
		return
	}
	// A phone with the Android app turns its positions on and off by itself:
	// the Chrome inside it gets no alert (devices.go). Every other device does.
	if r.devices != nil {
		kept := subs[:0:0]
		for _, sub := range subs {
			if !r.devices.HasApp(user, sub.Endpoint) {
				kept = append(kept, sub)
			}
		}
		subs = kept
	}
	// Called even with nothing due: that is also where a trip now past loses
	// its keys, as in announceTrips.
	r.announceLocation(user, subs, locationAlertsDue(r.locationTrips(user), loc, time.Now()))
}

// locationTrips are every data/trips/<dir>/trip.json of the user.
func (r *Reminders) locationTrips(user string) []locationTrip {
	var out []locationTrip
	tripsDir := filepath.Join(r.cfg.HomesDir, user, "data", "trips")
	entries, err := os.ReadDir(tripsDir)
	if err != nil {
		return out // no trips folder yet (or unreadable)
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		var trip locationTrip
		if loadJSONFile(filepath.Join(tripsDir, e.Name(), "trip.json"), &trip) {
			trip.dir = e.Name()
			out = append(out, trip)
		}
	}
	return out
}

// announceLocation pushes every due alert to every device that has not had it
// yet, then saves the keys - once, and only when they changed.
func (r *Reminders) announceLocation(user string, subs []PushSub, due []locationAlert) {
	path := filepath.Join(r.cfg.HomesDir, user, "data", "reminders.json")
	saved := loadSentKeys(path, "location")

	sent := make(map[string]int64, len(saved)) // key without "@<epoch>" -> that epoch
	for k := range saved {
		if i := strings.LastIndex(k, "@"); i > 0 {
			sent[k[:i]] = keyEpoch(k)
		}
	}

	for _, a := range due {
		kind := "off"
		if a.on {
			kind = "on"
		}
		for _, sub := range subs {
			dev := deviceID(sub.Endpoint)
			key := fmt.Sprintf("%s|%s|%s%d", dev, a.id, kind, a.at.Unix())
			if epoch, done := sent[key]; done {
				if a.until.Unix() > epoch {
					sent[key] = a.until.Unix() // the trip grew: keep the key as long
				}
				continue
			}
			title, body := r.locationText(sub.Lang, a.on, a.dest)
			payload := map[string]string{
				"title": title,
				"body":  body,
				"url":   URLPrefix + "/trips/",
				"tag":   "trip-location-" + a.id, // OFF replaces a forgotten ON
			}
			ttl := int(time.Until(a.until) / time.Second)
			ttl = min(max(ttl, 60), dailySeconds)
			if r.send(user, sub, dev, payload, ttl) {
				sent[key] = a.until.Unix()
				r.log.Info("reminders: location alert sent", "user", user, "dest", a.dest, "kind", kind)
			}
		}
	}

	now := time.Now().Unix()
	keep := make(map[string]bool, len(sent))
	for k, epoch := range sent {
		if epoch >= now {
			keep[fmt.Sprintf("%s@%d", k, epoch)] = true
		}
	}
	if !sameKeySet(keep, saved) {
		saveSentKeys(path, "location", keep, r.log)
	}
}

// locationAlertsDue are the alerts whose window holds `now`, for the trips that
// keep positions.
func locationAlertsDue(trips []locationTrip, loc *time.Location, now time.Time) []locationAlert {
	type span struct {
		id, dest string
		on, off  time.Time
	}
	var spans []span
	for _, t := range trips {
		if t.Track != nil && !*t.Track {
			continue // "Save where I am" is off: nothing to send
		}
		id := strings.Trim(string(t.ID), `"`)
		if id == "" || id == "null" {
			continue
		}
		on, off, ok := locationMoments(t.publicTripFile, loc)
		if !ok {
			continue
		}
		dest := strings.TrimSpace(t.Destination)
		if dest == "" {
			dest = t.dir
		}
		spans = append(spans, span{id: id, dest: dest, on: on, off: off})
	}
	sort.SliceStable(spans, func(i, j int) bool { return spans[i].on.Before(spans[j].on) })

	// insideOther is true when moment m falls within a trip other than spans[i].
	insideOther := func(i int, m time.Time) bool {
		for j, o := range spans {
			if j != i && m.After(o.on) && m.Before(o.off) {
				return true
			}
		}
		return false
	}

	var out []locationAlert
	for i, s := range spans {
		if !now.Before(s.on) && now.Before(s.off) && !insideOther(i, s.on) {
			out = append(out, locationAlert{id: s.id, dest: s.dest, on: true, at: s.on, until: s.off})
		}
		last := s.off.Add(locationOffWindow)
		if !now.Before(s.off) && now.Before(last) && !insideOther(i, s.off) {
			out = append(out, locationAlert{id: s.id, dest: s.dest, on: false, at: s.off, until: last})
		}
	}
	return out
}

// locationMoments is when a trip's ON and OFF alerts are due, on the owner's
// clock `loc` (the server's own when nil). See the top for where each comes from.
func locationMoments(trip publicTripFile, loc *time.Location) (on, off time.Time, ok bool) {
	if loc == nil {
		loc = time.Local
	}
	if !validDate(trip.StartDate) || !validDate(trip.EndDate) || trip.EndDate < trip.StartDate {
		return on, off, false
	}

	first, last := "", "" // the first departure on day one, the last arrival on the last day
	for _, st := range trip.Stages {
		if st.Enabled != nil && !*st.Enabled {
			continue
		}
		if dep := clockText.FindString(st.StartTime); dep != "" && st.StartDate == trip.StartDate &&
			(first == "" || dep < first) {
			first = dep
		}
		if arr := clockText.FindString(st.EndTime); arr != "" && st.EndDate == trip.EndDate && arr > last {
			last = arr
		}
	}

	if first == "" {
		first = "00:00"
	}
	start, err := time.ParseInLocation("2006-01-02 15:04", trip.StartDate+" "+first, loc)
	if err != nil {
		return on, off, false
	}
	on = start.Add(-locationLead)

	if last != "" {
		end, err := time.ParseInLocation("2006-01-02 15:04", trip.EndDate+" "+last, loc)
		if err != nil {
			return on, off, false
		}
		off = end.Add(locationLead)
	} else {
		day, err := time.ParseInLocation("2006-01-02", trip.EndDate, loc)
		if err != nil {
			return on, off, false
		}
		off = time.Date(day.Year(), day.Month(), day.Day()+1, tripHour, 0, 0, 0, loc)
	}
	return on, off, off.After(on)
}

// locationText is (title, body) of one alert, in the language this device
// subscribed in.
func (r *Reminders) locationText(lang string, on bool, dest string) (string, string) {
	var title, body string
	if on {
		title = r.phrase(lang, "push.locationOnTitle", "Activa tu ubicación")
		body = r.phrase(lang, "push.locationOnBody", "Viaje a {dest}: activa la app de ubicación del móvil.")
	} else {
		title = r.phrase(lang, "push.locationOffTitle", "Ya puedes apagar tu ubicación")
		body = r.phrase(lang, "push.locationOffBody",
			"Tu viaje a {dest} ha terminado: ya puedes desactivar la app de ubicación del móvil.")
	}
	return title, strings.NewReplacer("{dest}", ellipsis(dest)).Replace(body)
}
