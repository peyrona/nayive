// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// SOS - for someone who lives alone: three simple guards (2026-11-12).
// =============================================================================
//
//	SOS button   the launcher's red button: one press tells the contacts now.
//	Phone silent the Android app's long poll stops (dead battery, broken or
//	             switched-off phone) for `silent` hours: the SERVER tells the
//	             contacts - only a server can notice a phone that is gone.
//	Not used     nothing from the user for `idle` hours (no unlock, no launcher):
//	             first "Are you OK?" to the user; no answer in sosAnswer -> the
//	             contacts are told.
//	Danger watch a long press on SOS (2026-11-13): the SERVER counts sosWatchFor;
//	             not stopped by then -> the contacts are told. A phone taken or
//	             switched off cannot stop it. Stopped after it went out -> the
//	             contacts are told "safe now".
//	Danger PIN   (2026-11-14) with a PIN set, only the right PIN stops a watch.
//	             A wrong one (or none) LOOKS stopped - the same answer - but the
//	             contacts get "may be forced" at once and the positions go on.
//	             The Android app sends one every sosEvery while a watch counts
//	             or its alert is open (deviceState.Sos), sosAlertTTL at most.
//	             It ends with the right PIN (hold SOS again), a contact's "End
//	             alert", or after sosAlertTTL.
//
// Contacts are other Nayive users. They get a push (the app rings it) whose
// tap opens the launcher on the alert: who, when, the last position.
//
// One file, config/sos.json, outside every home - like location.json:
//
//	GET  /api/sos            (session) -> settings, the other users; stamps "alive"
//	PUT  /api/sos            (session) {contacts, silent, idle, quietFrom, quietTo}
//	POST /api/sos/ok         (session) "I'm OK": stamps alive, ends an ask
//	POST /api/sos/send       (session) {lat?, lon?, acc?, test?} -> {id, to:[{user, sent}]}
//	GET  /api/sos/alert/<id> (session) the alert, for its sender and its contacts
//	POST /api/sos/watch      (session) {lat?, lon?, acc?} starts (or restarts) a watch -> {left}
//	POST /api/sos/watch/pos  (session) {lat, lon, acc} a better position while it runs (or went out)
//	POST /api/sos/watch/send (session) {lat?, lon?, acc?} sends it now -> {id, to}
//	POST /api/sos/watch/stop (session) {pin?} "I'm safe" -> {safe: {id, to}?}; a wrong PIN answers the same
//	PUT  /api/sos/pin        (session) {old?, pin} sets ("" = removes) the danger PIN; `old` must open a set one
//	POST /api/sos/alert/<id>/end (session) a contact ends the open alert -> the contacts are told
//
// The phone tells its unlocks in its wait: /api/device/wait?unlock=<unix s>.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// Vars, not consts, so the tests can shorten them.
var (
	sosAnswer   = 15 * time.Minute // the "Are you OK?" waits this long for an answer
	sosGrace    = 15 * time.Minute // after a start, phones get this long to reconnect
	sosTick     = time.Minute
	sosWatchFor = 90 * time.Second // a danger watch goes out after this
	sosEvery    = 3 * time.Minute  // the app's positions while a watch is open
)

const (
	sosContactsMax = 10
	sosHoursMax    = 72
	sosAlertsKept  = 50
	sosAlertTTL    = 24 * 60 * 60        // seconds a contact's push is worth delivering
	sosAwakeSpan   = 31 * 24 * time.Hour // awake() looks no further back
)

// A press of SOS (or of Test) this soon after one that reached someone sends
// nothing new: the contacts' phones are still ringing (2 min). The page gets
// the earlier alert, its position brought up to date.
var sosSendGap = map[string]time.Duration{"sos": 5 * time.Minute, "test": time.Minute}

type sosUser struct {
	Owner     string   `json:"owner"`
	Contacts  []string `json:"contacts"`
	Silent    int      `json:"silent"`              // hours; 0 = off
	Idle      int      `json:"idle"`                // hours; 0 = off
	QuietFrom string   `json:"quietFrom,omitempty"` // "23:00": no idle ask, no silent alert until QuietTo
	QuietTo   string   `json:"quietTo,omitempty"`

	Alive      int64 `json:"alive,omitempty"`      // last sign of life (unix s)
	Asked      int64 `json:"asked,omitempty"`      // "Are you OK?" sent at; 0 = none open
	IdleDone   int64 `json:"idleDone,omitempty"`   // the ask already escalated
	SilentDone int64 `json:"silentDone,omitempty"` // the "seen" already alerted on

	Watch      int64  `json:"watch,omitempty"`      // a danger watch goes out at (unix s); 0 = none
	WatchAlert string `json:"watchAlert,omitempty"` // the alert a watch sent, until "I'm safe"
	Pin        string `json:"pin,omitempty"`        // the danger PIN, hashed (hashPassword); "" = none
}

type sosSent struct {
	User  string `json:"user"`
	Sent  int    `json:"sent"`            // devices the push reached
	Retry bool   `json:"retry,omitempty"` // none reached, for a reason that may pass: try again
}

type sosAlert struct {
	ID    string    `json:"id"`
	From  string    `json:"from"`
	Kind  string    `json:"kind"`            // sos | silent | idle | test | watch | forced | safe | ended
	At    int64     `json:"at"`              // unix s
	Since int64     `json:"since,omitempty"` // silent/idle: the last sign of life
	Pos   *lastPos  `json:"pos,omitempty"`
	To    []sosSent `json:"to"`
	By    string    `json:"by,omitempty"`   // ended: the contact who ended it
	Live  bool      `json:"live,omitempty"` // in a GET only: the sender's open watch alert
}

type sosFile struct {
	Users  []sosUser  `json:"users"`
	Alerts []sosAlert `json:"alerts"`
}

// Sos is the table, loaded on first use.
type Sos struct {
	mu      sync.Mutex
	path    string
	loaded  bool
	broken  bool
	data    sosFile
	started time.Time
	saved   map[string]int64 // owner -> the Alive last written to disk
	log     Logger
}

func NewSos(configDir string, log Logger) *Sos {
	return &Sos{path: filepath.Join(configDir, "sos.json"), log: log, started: time.Now(), saved: map[string]int64{}}
}

func (o *Sos) ensureLoaded() {
	if o.loaded {
		return
	}
	o.loaded = true
	ok, broken := loadTable(o.path, &o.data, o.log, "starting with no SOS settings")
	o.broken = broken
	if !ok {
		o.data = sosFile{}
	}
}

func (o *Sos) save() bool {
	if o.data.Users == nil {
		o.data.Users = []sosUser{}
	}
	if o.data.Alerts == nil {
		o.data.Alerts = []sosAlert{}
	}
	return saveTable(o.path, &o.broken, o.data, o.log)
}

// rowLocked is `owner`'s row, made when `make` is true. Caller holds mu.
func (o *Sos) rowLocked(owner string, make bool) *sosUser {
	for i := range o.data.Users {
		if o.data.Users[i].Owner == owner {
			return &o.data.Users[i]
		}
	}
	if !make {
		return nil
	}
	o.data.Users = append(o.data.Users, sosUser{Owner: owner})
	return &o.data.Users[len(o.data.Users)-1]
}

// Get is a copy of `owner`'s row (zero when none).
func (o *Sos) Get(owner string) sosUser {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	if u := o.rowLocked(owner, false); u != nil {
		c := *u
		c.Contacts = slices.Clone(u.Contacts)
		return c
	}
	return sosUser{Owner: owner}
}

// Set stores the settings part of `in` for its owner.
func (o *Sos) Set(in sosUser) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	u := o.rowLocked(in.Owner, true)
	before := *u
	u.Contacts, u.Silent, u.Idle, u.QuietFrom, u.QuietTo = in.Contacts, in.Silent, in.Idle, in.QuietFrom, in.QuietTo
	if u.Alive == 0 {
		u.Alive = time.Now().Unix() // switching it on is a sign of life
	}
	if !o.save() {
		*u = before // G8: "could not save" acts as not saved
		return false
	}
	return true
}

// Alive notes a sign of life of `owner` at `at` (unix s). An open ask ends.
// Written at most every few minutes: the launcher and every unlock call this.
func (o *Sos) Alive(owner string, at int64) {
	now := time.Now().Unix()
	if at > now || at <= 0 {
		at = now
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	u := o.rowLocked(owner, false)
	if u == nil || at <= u.Alive {
		return
	}
	asked := u.Asked != 0 && at >= u.Asked
	u.Alive = at
	if asked {
		u.Asked = 0
	}
	if !asked && at-o.saved[owner] < 300 {
		return // memory only; written at most every 5 minutes
	}
	if o.save() {
		o.saved[owner] = at
	}
}

// addAlert keeps `a`: the newest sosAlertsKept OF EACH SENDER (G5 - one
// user's sends never push out somebody else's), and never an open watch
// alert, whatever its age in the list.
func (o *Sos) addAlert(a sosAlert) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	o.data.Alerts = append(o.data.Alerts, a)
	open := map[string]bool{}
	for _, u := range o.data.Users {
		if u.WatchAlert != "" {
			open[u.WatchAlert] = true
		}
	}
	mine := 0
	for _, x := range o.data.Alerts {
		if x.From == a.From {
			mine++
		}
	}
	if mine > sosAlertsKept {
		drop := mine - sosAlertsKept
		kept := o.data.Alerts[:0]
		for _, x := range o.data.Alerts {
			if drop > 0 && x.From == a.From && !open[x.ID] {
				drop--
				continue // the oldest of this sender's first
			}
			kept = append(kept, x)
		}
		o.data.Alerts = kept
	}
	o.save()
}

// alertFor is alert `id` when `user` sent it or was told.
func (o *Sos) alertFor(id, user string) *sosAlert {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	for i := range o.data.Alerts {
		a := o.data.Alerts[i]
		if a.ID != id {
			continue
		}
		if a.From == user && a.Kind == "forced" {
			return nil // never shown on the phone a captor may hold
		}
		if a.From == user || slices.ContainsFunc(a.To, func(t sosSent) bool { return t.User == user }) {
			return &a
		}
	}
	return nil
}

// alertByID is `owner`'s alert `id`, for the server's own use (nothing hidden).
func (o *Sos) alertByID(owner, id string) *sosAlert {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	for i := range o.data.Alerts {
		if a := o.data.Alerts[i]; a.ID == id && a.From == owner {
			a.To = slices.Clone(a.To)
			return &a
		}
	}
	return nil
}

// setPin stores `owner`'s danger PIN hash ("" = none); false = not saved.
func (o *Sos) setPin(owner, hash string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	u := o.rowLocked(owner, true)
	before := *u
	u.Pin = hash
	if !o.save() {
		*u = before
		return false
	}
	return true
}

// DropUser forgets a deleted user: their row, and them as anyone's contact.
func (o *Sos) DropUser(name string) { o.RenameUser(name, "") }

// RenameUser follows an admin rename ("" = deleted).
func (o *Sos) RenameUser(oldName, newName string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	changed := false
	kept := o.data.Users[:0]
	for _, u := range o.data.Users {
		if u.Owner == oldName {
			changed = true
			if newName == "" {
				continue
			}
			u.Owner = newName
		}
		var cs []string
		for _, c := range u.Contacts {
			switch {
			case c != oldName:
				cs = append(cs, c)
			case newName != "":
				cs, changed = append(cs, newName), true
			default:
				changed = true
			}
		}
		u.Contacts = cs
		kept = append(kept, u)
	}
	o.data.Users = kept
	// G16: the alerts too - a renamed sender or contact keeps seeing them,
	// a deleted one's alerts (positions included) go with them.
	alerts := o.data.Alerts[:0]
	for _, a := range o.data.Alerts {
		if a.From == oldName {
			changed = true
			if newName == "" {
				continue
			}
			a.From = newName
		}
		if a.By == oldName {
			a.By, changed = newName, true
		}
		to := a.To[:0]
		for _, t := range a.To {
			if t.User == oldName {
				changed = true
				if newName == "" {
					continue
				}
				t.User = newName
			}
			to = append(to, t)
		}
		a.To = to
		alerts = append(alerts, a)
	}
	o.data.Alerts = alerts
	if changed {
		o.save()
	}
}

// -----------------------------------------------------------------------------
// the checks
// -----------------------------------------------------------------------------

// lastSeen is the newest "seen" of `owner`'s app phones; 0 = none.
func (d *Devices) lastSeen(owner string) int64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	var best int64
	for _, r := range d.rows {
		if r.Owner == owner && r.App > 0 {
			best = max(best, r.Seen, d.seen[r.ID])
		}
	}
	return best
}

// inQuiet: `t` falls in the "HH:MM"-"HH:MM" window (it may cross midnight).
func inQuiet(t time.Time, from, to string) bool {
	f, ok1 := hhmmMinutes(from)
	e, ok2 := hhmmMinutes(to)
	if !ok1 || !ok2 || f == e {
		return false
	}
	m := t.Hour()*60 + t.Minute()
	if f < e {
		return m >= f && m < e
	}
	return m >= f || m < e
}

// awake is how much of `from`..`to` fell outside the quiet window ("HH:MM"-
// "HH:MM", it may cross midnight), in `to`'s zone: a phone off for the night,
// or not touched in it, does not count the night. Without a window it is the
// whole span. Looks back no further than sosAwakeSpan.
func awake(from, to time.Time, quietFrom, quietTo string) time.Duration {
	if !to.After(from) {
		return 0
	}
	if to.Sub(from) > sosAwakeSpan {
		from = to.Add(-sosAwakeSpan)
	}
	total := to.Sub(from)
	f, ok1 := hhmmMinutes(quietFrom)
	e, ok2 := hhmmMinutes(quietTo)
	if !ok1 || !ok2 || f == e {
		return total
	}
	loc := to.Location()
	from = from.In(loc)
	next := 0 // the window ends the day it starts, or the next
	if e < f {
		next = 1
	}
	y, m, d := from.Date()
	for day := time.Date(y, m, d-1, 0, 0, 0, 0, loc); !day.After(to); day = day.AddDate(0, 0, 1) {
		qs := time.Date(day.Year(), day.Month(), day.Day(), f/60, f%60, 0, 0, loc)
		qe := time.Date(day.Year(), day.Month(), day.Day()+next, e/60, e%60, 0, 0, loc)
		if lo, hi := maxTime(qs, from), minTime(qe, to); hi.After(lo) {
			total -= hi.Sub(lo)
		}
	}
	return max(total, 0)
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func hhmmMinutes(s string) (int, bool) {
	t, err := time.Parse("15:04", s)
	if err != nil {
		return 0, false
	}
	return t.Hour()*60 + t.Minute(), true
}

// RunSos checks every user once a minute until ctx ends.
func (s *Server) RunSos(ctx context.Context) {
	t := time.NewTicker(sosTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sosTickSafe(time.Now())
		}
	}
}

func (s *Server) sosTickSafe(now time.Time) {
	defer func() {
		if err := recover(); err != nil {
			s.log.Error("sos: tick failed", "err", err)
		}
	}()
	s.sosCheck(now)
}

// sosCheck is one pass over every user with contacts.
func (s *Server) sosCheck(now time.Time) {
	s.sosRetry(now)
	o := s.sos
	o.mu.Lock()
	o.ensureLoaded()
	rows := slices.Clone(o.data.Users)
	o.mu.Unlock()

	for _, u := range rows {
		if len(u.Contacts) == 0 {
			continue
		}
		// A danger watch whose timer was lost (a restart): no grace, no quiet.
		if u.Watch != 0 && now.Unix() >= u.Watch {
			s.sosWatchFire(u.Owner, u.Watch, nil)
		}
		// An open watch alert ends by itself after sosAlertTTL: the positions stop.
		if id := u.WatchAlert; id != "" && u.Watch == 0 {
			if a := o.alertByID(u.Owner, id); a == nil || now.Unix()-a.At >= sosAlertTTL {
				if s.sosMark(u.Owner, func(r *sosUser) bool {
					if r.WatchAlert != id || r.Watch != 0 {
						return false
					}
					r.WatchAlert = ""
					return true
				}) {
					s.sosKick()
				}
			}
		}
		local := now
		if loc := Location(s.users.UserTZ("user", u.Owner)); loc != nil {
			local = now.In(loc)
		}
		quiet := inQuiet(local, u.QuietFrom, u.QuietTo)
		// After a start, phones and pages get sosGrace to reach us again.
		settled := now.Sub(o.started) > sosGrace
		awakeSince := func(at int64) time.Duration {
			return awake(time.Unix(at, 0), local, u.QuietFrom, u.QuietTo)
		}

		// Phone silent. "seen" only grows; one that went back (the newest was
		// in memory only, and the server restarted) is the same silence.
		if u.Silent > 0 && !quiet && settled {
			seen := s.devices.lastSeen(u.Owner)
			if seen > u.SilentDone && awakeSince(seen) > time.Duration(u.Silent)*time.Hour {
				if s.sosMark(u.Owner, func(r *sosUser) bool {
					if r.SilentDone >= seen {
						return false
					}
					r.SilentDone = seen
					return true
				}) {
					s.sosAlert(u.Owner, "silent", seen, nil)
				}
			}
		}

		// Not used.
		if u.Idle == 0 || u.Alive == 0 {
			continue
		}
		switch {
		case u.Asked == 0 && !quiet && settled && awakeSince(u.Alive) > time.Duration(u.Idle)*time.Hour:
			at := now.Unix()
			if s.sosMark(u.Owner, func(r *sosUser) bool {
				if r.Asked != 0 || r.Alive != u.Alive {
					return false
				}
				r.Asked = at
				return true
			}) {
				s.sosAsk(u.Owner)
			}
		case u.Asked != 0 && u.IdleDone != u.Asked && settled && now.Sub(time.Unix(u.Asked, 0)) > sosAnswer:
			asked := u.Asked
			if s.sosMark(u.Owner, func(r *sosUser) bool {
				if r.Asked != asked || r.IdleDone == asked {
					return false
				}
				r.IdleDone = asked
				return true
			}) {
				s.sosAlert(u.Owner, "idle", u.Alive, nil)
			}
		}
	}
}

// sosMark changes `owner`'s row under the lock and saves; false when `fn`
// declined (someone else got there first) or the row is gone. A mark that
// could not be saved is taken back, so the next tick tries again.
func (s *Server) sosMark(owner string, fn func(*sosUser) bool) bool {
	o := s.sos
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded() // G19: right after a restart nothing may have read the file yet
	u := o.rowLocked(owner, false)
	if u == nil {
		return false
	}
	before := *u
	if !fn(u) {
		return false
	}
	if !o.save() {
		*u = before
		return false
	}
	return true
}

// sosAsk pushes "Are you OK?" to the user's own devices.
func (s *Server) sosAsk(owner string) {
	for _, sub := range s.users.PushTargets(owner) {
		payload := map[string]any{
			"title": s.chat.phrase(sub.Lang, "sos.askTitle", "Are you OK?"),
			"body":  s.chat.phrase(sub.Lang, "sos.askBody", "Tap to answer. Without an answer in 15 minutes, your SOS contacts will be told."),
			"url":   URLPrefix + "/?sosok=1",
			"tag":   "sos-ask",
			"sos":   true,
		}
		deliverPush(s.push, s.users, s.log, owner, sub, payload, int(sosAnswer/time.Second))
	}
	s.log.Info("sos: asked", "user", owner)
}

// sosAlert tells every contact of `owner`. `since` is the last sign of life
// (silent/idle); `pos` the sender's fresh position, if any.
func (s *Server) sosAlert(owner, kind string, since int64, pos *lastPos) sosAlert {
	return s.sosAlertAs(newChatID(), owner, kind, since, pos)
}

// sosAlertAs is sosAlert under a given id.
func (s *Server) sosAlertAs(id, owner, kind string, since int64, pos *lastPos) sosAlert {
	return s.sosSend(sosAlert{ID: id, From: owner, Kind: kind, At: time.Now().Unix(), Since: since, Pos: pos})
}

// sosSend pushes `a` to its sender's contacts and keeps it.
func (s *Server) sosSend(a sosAlert) sosAlert {
	owner, kind := a.From, a.Kind
	u := s.sos.Get(owner)
	if a.Pos == nil {
		a.Pos = s.devices.Last(owner)
	}
	exists := s.users.ListUserNames()
	reached, retry := 0, false
	for _, c := range u.Contacts {
		if !slices.Contains(exists, c) {
			continue
		}
		sent, again := s.sosPush(a, c, sosAlertTTL)
		again = again && kind != "test"
		a.To = append(a.To, sosSent{User: c, Sent: sent, Retry: again})
		if sent > 0 {
			reached++
		}
		retry = retry || again
	}
	if a.To == nil {
		a.To = []sosSent{}
	}
	s.sos.addAlert(a)
	s.log.Info("sos: alert", "user", owner, "kind", kind, "contacts", len(a.To), "reached", reached)
	if reached == 0 && len(a.To) > 0 {
		s.log.Warn("sos: alert reached nobody", "user", owner, "kind", kind, "retrying", retry)
	}
	return a
}

// sosPush sends alert `a` to every device of contact `c`, worth delivering for
// `ttl` seconds. It answers the devices reached and, when none was, whether
// a failure may pass (network, push service busy): worth another try.
func (s *Server) sosPush(a sosAlert, c string, ttl int) (sent int, retry bool) {
	for _, sub := range s.users.PushTargets(c) {
		title, body := s.sosText(sub.Lang, a.Kind, a.From)
		payload := map[string]any{
			"title": title,
			"body":  strings.ReplaceAll(body, "{by}", a.By),
			"url":   URLPrefix + "/?sos=" + a.ID,
			"tag":   "sos-" + a.ID,
			"sos":   a.Kind != "test" && a.Kind != "safe" && a.Kind != "ended", // no alarm ring for these
		}
		status, _ := deliverPush(s.push, s.users, s.log, c, sub, payload, ttl)
		switch {
		case status >= 200 && status < 300:
			sent++
		case pushTransient(status):
			retry = true
		}
	}
	return sent, retry && sent == 0
}

// sosRetry tries again every contact an alert did not reach for a reason that
// may pass, until a device takes it or the alert is sosAlertTTL old.
func (s *Server) sosRetry(now time.Time) {
	o := s.sos
	o.mu.Lock()
	o.ensureLoaded()
	var due []sosAlert
	expired := false
	for i := range o.data.Alerts {
		a := &o.data.Alerts[i]
		for j := range a.To {
			if !a.To[j].Retry {
				continue
			}
			if now.Unix()-a.At >= sosAlertTTL {
				a.To[j].Retry, expired = false, true
				s.log.Warn("sos: alert never reached a contact", "user", a.From, "kind", a.Kind, "contact", a.To[j].User)
				continue
			}
			c := *a
			c.To = slices.Clone(a.To)
			due = append(due, c)
			break
		}
	}
	if expired {
		o.save()
	}
	o.mu.Unlock()

	for _, a := range due {
		ttl := sosAlertTTL - int(now.Unix()-a.At)
		for _, t := range a.To {
			if !t.Retry {
				continue
			}
			sent, again := s.sosPush(a, t.User, ttl)
			if sent > 0 {
				s.log.Info("sos: alert reached a contact on a later try", "user", a.From, "contact", t.User)
			}
			if sent > 0 || !again {
				o.setSent(a.ID, t.User, sent)
			}
		}
	}
}

// setSent notes that alert `id` reached `sent` devices of `user` (no more tries).
func (o *Sos) setSent(id, user string, sent int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for i := range o.data.Alerts {
		if o.data.Alerts[i].ID != id {
			continue
		}
		for j := range o.data.Alerts[i].To {
			if t := &o.data.Alerts[i].To[j]; t.User == user && t.Retry {
				t.Sent, t.Retry = sent, false
				o.save()
			}
		}
		return
	}
}

// recentSent is `owner`'s newest `kind` alert, when it is younger than
// sosSendGap and reached someone; with a fresh `pos`, that alert takes it.
func (o *Sos) recentSent(owner, kind string, now time.Time, pos *lastPos) *sosAlert {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	for i := len(o.data.Alerts) - 1; i >= 0; i-- {
		a := &o.data.Alerts[i]
		if a.From != owner || a.Kind != kind {
			continue
		}
		if now.Sub(time.Unix(a.At, 0)) >= sosSendGap[kind] ||
			!slices.ContainsFunc(a.To, func(t sosSent) bool { return t.Sent > 0 }) {
			return nil
		}
		if pos != nil {
			a.Pos = pos
			o.save()
		}
		c := *a
		c.To = slices.Clone(a.To)
		return &c
	}
	return nil
}

func (s *Server) sosText(lang, kind, owner string) (string, string) {
	title := strings.ReplaceAll(s.chat.phrase(lang, "sos.alertTitle", "SOS - {name}"), "{name}", owner)
	var body string
	switch kind {
	case "silent":
		body = s.chat.phrase(lang, "sos.bodySilent", "{name}'s phone has stopped answering. Tap to see the last position.")
	case "idle":
		body = s.chat.phrase(lang, "sos.bodyIdle", "{name} has not used the phone for hours and did not answer. Tap to see the last position.")
	case "test":
		title = "TEST - " + title
		body = s.chat.phrase(lang, "sos.bodyTest", "This is only a test of {name}'s SOS. Nothing to do.")
	case "watch":
		body = s.chat.phrase(lang, "sos.bodyWatch", "{name} felt in danger and did not stop the alarm. Tap to see where.")
	case "forced":
		body = s.chat.phrase(lang, "sos.bodyForced", "{name} may be forced: the alarm was stopped without the right PIN. The position keeps coming. Tap to see where.")
	case "safe":
		title = strings.ReplaceAll(s.chat.phrase(lang, "sos.safeTitle", "{name} is safe"), "{name}", owner)
		body = s.chat.phrase(lang, "sos.bodySafe", "The earlier SOS alert from {name} is over.")
	case "ended":
		title = strings.ReplaceAll(s.chat.phrase(lang, "sos.endedTitle", "SOS over - {name}"), "{name}", owner)
		body = s.chat.phrase(lang, "sos.bodyEnded", "{by} ended the SOS alert from {name}.")
	default:
		body = s.chat.phrase(lang, "sos.bodySos", "{name} pressed SOS. Tap to see where.")
	}
	return title, strings.ReplaceAll(body, "{name}", owner)
}

// -----------------------------------------------------------------------------
// the danger watch
// -----------------------------------------------------------------------------

// sosWatchStart opens (or starts again) `owner`'s danger watch; false = not saved.
// The tick in sosCheck is the backup of the timer (a restart loses it). An
// alert still open stays: the right PIN on this watch tells the contacts "safe".
func (s *Server) sosWatchStart(owner string) (int64, bool) {
	end := time.Now().Add(sosWatchFor).Unix()
	if !s.sosMark(owner, func(r *sosUser) bool {
		r.Watch = end
		return true
	}) {
		return 0, false
	}
	s.sosKick()
	time.AfterFunc(time.Until(time.Unix(end, 0)), func() {
		defer func() {
			if err := recover(); err != nil {
				s.log.Error("sos: watch failed", "err", err)
			}
		}()
		s.sosWatchFire(owner, end, nil)
	})
	s.log.Info("sos: watch started", "user", owner)
	return end, true
}

// sosWatchFire sends the watch that goes out at `end` (0 = the open one), once.
// nil when there is none: stopped, already sent, or not saved (the tick tries again).
func (s *Server) sosWatchFire(owner string, end int64, pos *lastPos) *sosAlert {
	id := newChatID()
	if !s.sosMark(owner, func(r *sosUser) bool {
		if r.Watch == 0 || (end != 0 && r.Watch != end) {
			return false
		}
		r.Watch, r.WatchAlert = 0, id
		return true
	}) {
		return nil
	}
	s.sosKick()
	a := s.sosAlertAs(id, owner, "watch", 0, pos)
	return &a
}

// sosWatchForce: a stop without the right PIN. The contacts get "may be
// forced" at once; it takes the place of the watch's count, or of its open
// alert. nil when nothing was open.
func (s *Server) sosWatchForce(owner string) *sosAlert {
	id := newChatID()
	if !s.sosMark(owner, func(r *sosUser) bool {
		if r.Watch == 0 && r.WatchAlert == "" {
			return false
		}
		r.Watch, r.WatchAlert = 0, id
		return true
	}) {
		return nil
	}
	s.sosKick()
	a := s.sosAlertAs(id, owner, "forced", 0, nil)
	return &a
}

// sosKick wakes the phones' waits: whether they send positions changed.
func (s *Server) sosKick() {
	if s.devices != nil {
		s.devices.Kick()
	}
}

// sosEveryFor is how often `owner`'s app sends its position (seconds); 0 = no
// need. On while a watch counts, or while its alert is open (sosAlertTTL at most).
func (s *Server) sosEveryFor(owner string) int {
	u := s.sos.Get(owner)
	if u.Watch == 0 && u.WatchAlert == "" {
		return 0
	}
	if u.Watch == 0 {
		if a := s.sos.alertByID(owner, u.WatchAlert); a == nil || time.Now().Unix()-a.At >= sosAlertTTL {
			return 0
		}
	}
	return int(sosEvery / time.Second)
}

// sosFollow gives `owner`'s open watch alert the app's newest position.
func (s *Server) sosFollow(owner string, p lastPos) {
	if id := s.sos.Get(owner).WatchAlert; id != "" {
		s.sos.setPos(id, roundedForFind(p))
	}
}

// sosLive: alert `a` is a danger watch's (or its "may be forced") and it is
// the sender's OPEN one - a contact may follow and end it. An older alert of
// hers is never live (G2): whoever got it - even a contact she has removed
// since - neither follows her now nor ends her current alarm. Who may ask at
// all is alertFor's check: the alert's own recipients.
func sosLive(a sosAlert, u sosUser) bool {
	return (a.Kind == "watch" || a.Kind == "forced") && u.WatchAlert == a.ID &&
		time.Now().Unix()-a.At < sosAlertTTL
}

// validPin: 4 to 8 digits.
func validPin(p string) bool {
	if len(p) < 4 || len(p) > 8 {
		return false
	}
	for _, c := range p {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// pinTries: wrong old PINs per user. 5 in 15 minutes, then it waits.
var pinTries = struct {
	sync.Mutex
	m map[string][]time.Time
}{m: map[string][]time.Time{}}

// pinBlocked notes a wrong try (when `wrong`) and tells whether `user` must wait.
func pinBlocked(user string, wrong bool) bool {
	pinTries.Lock()
	defer pinTries.Unlock()
	cut := time.Now().Add(-15 * time.Minute)
	var kept []time.Time
	for _, t := range pinTries.m[user] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	if wrong {
		kept = append(kept, time.Now())
	}
	pinTries.m[user] = kept
	return len(kept) >= 5
}

// watchStop ends `owner`'s danger watch. `sent` is the alert it already sent
// ("" = it had not gone out). false: not saved - the watch still runs.
func (o *Sos) watchStop(owner string) (sent string, ok bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	u := o.rowLocked(owner, false)
	if u == nil || (u.Watch == 0 && u.WatchAlert == "") {
		return "", true
	}
	before := *u
	sent = u.WatchAlert
	u.Watch, u.WatchAlert = 0, ""
	if !o.save() {
		*u = before
		return "", false
	}
	return sent, true
}

// setPos gives alert `id` a newer position.
func (o *Sos) setPos(id string, p lastPos) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	for i := range o.data.Alerts {
		if a := &o.data.Alerts[i]; a.ID == id {
			if a.Pos == nil || p.At >= a.Pos.At {
				a.Pos = &p
				o.save()
			}
			return
		}
	}
}

// sosPosIn is a position a page sends.
type sosPosIn struct {
	Lat *float64 `json:"lat"`
	Lon *float64 `json:"lon"`
	Acc *float64 `json:"acc"`
}

// pos is the position, nil when none or not valid.
func (b sosPosIn) pos() *lastPos {
	if b.Lat == nil || b.Lon == nil || !validLatLon(*b.Lat, *b.Lon) {
		return nil
	}
	p := lastPos{Lat: *b.Lat, Lon: *b.Lon, At: time.Now().Unix(), Source: "browser"}
	if b.Acc != nil {
		p.Acc = *b.Acc
	}
	return &p
}

// -----------------------------------------------------------------------------
// the routes
// -----------------------------------------------------------------------------

func (s *Server) apiSos(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if sess.Role == "admin" {
		sendError(w, r, http.StatusForbidden, "SOS is per user")
		return
	}
	user := sess.User
	rest := strings.Trim(r.PathValue("rest"), "/")

	switch {
	case rest == "" && r.Method == http.MethodGet:
		s.sos.Alive(user, 0)
		u := s.sos.Get(user)
		others := []string{}
		for _, n := range s.users.ListUserNames() {
			if n != user {
				others = append(others, n)
			}
		}
		if u.Contacts == nil {
			u.Contacts = []string{}
		}
		sendJSON(w, r, http.StatusOK, map[string]any{
			"contacts": u.Contacts, "silent": u.Silent, "idle": u.Idle,
			"quietFrom": u.QuietFrom, "quietTo": u.QuietTo,
			"users": others, "phone": s.devices.lastSeen(user) > 0, "pin": u.Pin != "",
			"watch": max(u.Watch-time.Now().Unix(), 0), // seconds a running danger watch has left
		})

	case rest == "" && r.Method == http.MethodPut:
		var body struct {
			Contacts  []string `json:"contacts"`
			Silent    int      `json:"silent"`
			Idle      int      `json:"idle"`
			QuietFrom string   `json:"quietFrom"`
			QuietTo   string   `json:"quietTo"`
		}
		if !readJSONBody(w, r, &body) {
			return
		}
		exists := s.users.ListUserNames()
		var cs []string
		for _, c := range body.Contacts {
			if c != user && slices.Contains(exists, c) && !slices.Contains(cs, c) {
				cs = append(cs, c)
			}
		}
		if len(cs) > sosContactsMax {
			sendError(w, r, http.StatusBadRequest, "too many contacts")
			return
		}
		// G18: the danger PIN guards "stop"; emptying the contacts must not
		// get round it. While a watch counts or its alert is open, contacts
		// may be added, never removed.
		if cur := s.sos.Get(user); cur.Watch != 0 || cur.WatchAlert != "" {
			for _, c := range cur.Contacts {
				if !slices.Contains(cs, c) && slices.Contains(exists, c) {
					sendError(w, r, http.StatusConflict, "a contact cannot be removed during a danger watch")
					return
				}
			}
		}
		if body.Silent < 0 || body.Silent > sosHoursMax || body.Idle < 0 || body.Idle > sosHoursMax {
			sendError(w, r, http.StatusBadRequest, "hours out of range")
			return
		}
		for _, t := range []string{body.QuietFrom, body.QuietTo} {
			if _, ok := hhmmMinutes(t); t != "" && !ok {
				sendError(w, r, http.StatusBadRequest, "time must be HH:MM")
				return
			}
		}
		if !s.sos.Set(sosUser{Owner: user, Contacts: cs, Silent: body.Silent, Idle: body.Idle,
			QuietFrom: body.QuietFrom, QuietTo: body.QuietTo}) {
			sendError(w, r, http.StatusInternalServerError, "could not save")
			return
		}
		if cs == nil {
			cs = []string{}
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"ok": true, "contacts": cs})

	case rest == "ok" && r.Method == http.MethodPost:
		s.sos.Alive(user, 0)
		sendJSON(w, r, http.StatusOK, map[string]any{"ok": true})

	case rest == "send" && r.Method == http.MethodPost:
		var body struct {
			Lat  *float64 `json:"lat"`
			Lon  *float64 `json:"lon"`
			Acc  *float64 `json:"acc"`
			Test bool     `json:"test"`
		}
		if !readJSONBody(w, r, &body) {
			return
		}
		if len(s.sos.Get(user).Contacts) == 0 {
			sendError(w, r, http.StatusConflict, "no SOS contacts")
			return
		}
		var pos *lastPos
		if body.Lat != nil && body.Lon != nil && validLatLon(*body.Lat, *body.Lon) {
			p := lastPos{Lat: *body.Lat, Lon: *body.Lon, At: time.Now().Unix(), Source: "browser"}
			if body.Acc != nil {
				p.Acc = *body.Acc
			}
			if !body.Test {
				s.devices.NoteLast(user, p)
			}
			p = roundedForFind(p)
			pos = &p
		}
		kind := "sos"
		if body.Test {
			kind = "test"
		}
		if a := s.sos.recentSent(user, kind, time.Now(), pos); a != nil {
			sendJSON(w, r, http.StatusOK, map[string]any{"id": a.ID, "to": a.To})
			return
		}
		a := s.sosAlert(user, kind, 0, pos)
		sendJSON(w, r, http.StatusOK, map[string]any{"id": a.ID, "to": a.To})

	case rest == "watch" && r.Method == http.MethodPost:
		var body sosPosIn
		if !readJSONBody(w, r, &body) {
			return
		}
		if len(s.sos.Get(user).Contacts) == 0 {
			sendError(w, r, http.StatusConflict, "no SOS contacts")
			return
		}
		if p := body.pos(); p != nil {
			s.devices.NoteLast(user, *p)
		}
		end, ok := s.sosWatchStart(user)
		if !ok {
			sendError(w, r, http.StatusInternalServerError, "could not save")
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"ok": true, "left": end - time.Now().Unix()})

	case rest == "watch/pos" && r.Method == http.MethodPost:
		var body sosPosIn
		if !readJSONBody(w, r, &body) {
			return
		}
		p := body.pos()
		if p == nil {
			sendError(w, r, http.StatusBadRequest, "no position")
			return
		}
		u := s.sos.Get(user)
		if u.Watch == 0 && u.WatchAlert == "" {
			sendError(w, r, http.StatusConflict, "no danger watch")
			return
		}
		s.devices.NoteLast(user, *p)
		if u.WatchAlert != "" {
			s.sos.setPos(u.WatchAlert, roundedForFind(*p)) // it went out: the contacts see where now
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"ok": true})

	case rest == "watch/send" && r.Method == http.MethodPost:
		var body sosPosIn
		if !readJSONBody(w, r, &body) {
			return
		}
		pos := body.pos()
		if pos != nil {
			s.devices.NoteLast(user, *pos)
			p := roundedForFind(*pos)
			pos = &p
		}
		a := s.sosWatchFire(user, 0, pos)
		// The timer got there first: its alert (the pushes may still be going).
		for i := 0; a == nil && i < 50; i++ {
			id := s.sos.Get(user).WatchAlert
			if id == "" {
				break
			}
			if a = s.sos.alertFor(id, user); a == nil {
				time.Sleep(100 * time.Millisecond)
			}
		}
		if a == nil {
			sendError(w, r, http.StatusConflict, "no danger watch")
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"id": a.ID, "to": a.To})

	case rest == "watch/stop" && r.Method == http.MethodPost:
		var body struct {
			Pin string `json:"pin"`
		}
		// G4: the build before the PIN posts no body at all; that is {pin: ""}.
		if err := readJSON(w, r, &body); err != nil && !errors.Is(err, io.EOF) {
			sendBodyError(w, r, err)
			return
		}
		if before := s.sos.Get(user); before.Pin != "" {
			if right, _ := checkPassword(body.Pin, before.Pin); !right {
				// It looks stopped - the answer the right PIN gets - but is not.
				out := map[string]any{"ok": true}
				if a := s.sosWatchForce(user); a != nil && before.WatchAlert != "" {
					out["safe"] = map[string]any{"id": newChatID(), "to": a.To}
				}
				s.log.Warn("sos: watch stopped without the right PIN", "user", user)
				sendJSON(w, r, http.StatusOK, out)
				return
			}
		}
		sent, ok := s.sos.watchStop(user)
		if !ok {
			sendError(w, r, http.StatusInternalServerError, "could not stop")
			return
		}
		s.sosKick()
		out := map[string]any{"ok": true}
		if a := s.sos.alertByID(user, sent); sent != "" && a != nil && time.Now().Unix()-a.At < sosAlertTTL {
			safe := s.sosAlert(user, "safe", 0, nil)
			out["safe"] = map[string]any{"id": safe.ID, "to": safe.To}
		}
		s.log.Info("sos: watch stopped", "user", user, "wentOut", sent != "")
		sendJSON(w, r, http.StatusOK, out)

	case rest == "pin" && r.Method == http.MethodPut:
		var body struct {
			Old string `json:"old"`
			Pin string `json:"pin"`
		}
		if !readJSONBody(w, r, &body) {
			return
		}
		if body.Pin != "" && !validPin(body.Pin) {
			sendError(w, r, http.StatusBadRequest, "the PIN is 4 to 8 digits")
			return
		}
		if pinBlocked(user, false) {
			sendError(w, r, http.StatusTooManyRequests, "too many tries - wait 15 minutes")
			return
		}
		if hash := s.sos.Get(user).Pin; hash != "" {
			if right, _ := checkPassword(body.Old, hash); !right {
				pinBlocked(user, true)
				sendError(w, r, http.StatusForbidden, "wrong PIN")
				return
			}
		}
		hash := hashPassword(body.Pin)
		if !s.sos.setPin(user, hash) {
			sendError(w, r, http.StatusInternalServerError, "could not save")
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"ok": true, "pin": hash != ""})

	case strings.HasPrefix(rest, "alert/") && strings.HasSuffix(rest, "/end") && r.Method == http.MethodPost:
		id := strings.TrimSuffix(strings.TrimPrefix(rest, "alert/"), "/end")
		a := s.sos.alertFor(id, user)
		if a == nil || a.From == user {
			sendError(w, r, http.StatusNotFound, "no such alert")
			return
		}
		owner := a.From
		if !sosLive(*a, s.sos.Get(owner)) || !s.sosMark(owner, func(r *sosUser) bool {
			if r.WatchAlert != id {
				return false // not (or no longer) this alert's watch
			}
			r.Watch, r.WatchAlert = 0, ""
			return true
		}) {
			sendError(w, r, http.StatusConflict, "this alert is already over")
			return
		}
		s.sosKick()
		s.sosSend(sosAlert{ID: newChatID(), From: owner, Kind: "ended", At: time.Now().Unix(), By: user})
		s.log.Info("sos: alert ended by a contact", "user", owner, "by", user)
		sendJSON(w, r, http.StatusOK, map[string]any{"ok": true})

	case strings.HasPrefix(rest, "alert/") && r.Method == http.MethodGet:
		a := s.sos.alertFor(strings.TrimPrefix(rest, "alert/"), user)
		if a == nil {
			sendError(w, r, http.StatusNotFound, "no such alert")
			return
		}
		a.Live = sosLive(*a, s.sos.Get(a.From))
		if p := s.devices.Last(a.From); a.Live && p != nil && (a.Pos == nil || p.At > a.Pos.At) {
			rp := roundedForFind(*p) // still open: where the phone is now
			a.Pos = &rp
		}
		sendJSON(w, r, http.StatusOK, a)

	default:
		sendError(w, r, http.StatusNotFound, "no such endpoint")
	}
}
