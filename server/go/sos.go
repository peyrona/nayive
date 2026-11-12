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
//
// The phone tells its unlocks in its wait: /api/device/wait?unlock=<unix s>.

import (
	"context"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// Vars, not consts, so the tests can shorten them.
var (
	sosAnswer = 15 * time.Minute // the "Are you OK?" waits this long for an answer
	sosGrace  = 15 * time.Minute // after a start, phones get this long to reconnect
	sosTick   = time.Minute
)

const (
	sosContactsMax = 10
	sosHoursMax    = 72
	sosAlertsKept  = 50
	sosAlertTTL    = 24 * 60 * 60 // seconds a contact's push is worth delivering
)

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
}

type sosSent struct {
	User string `json:"user"`
	Sent int    `json:"sent"` // devices the push reached
}

type sosAlert struct {
	ID    string    `json:"id"`
	From  string    `json:"from"`
	Kind  string    `json:"kind"`            // sos | silent | idle | test
	At    int64     `json:"at"`              // unix s
	Since int64     `json:"since,omitempty"` // silent/idle: the last sign of life
	Pos   *lastPos  `json:"pos,omitempty"`
	To    []sosSent `json:"to"`
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
	u.Contacts, u.Silent, u.Idle, u.QuietFrom, u.QuietTo = in.Contacts, in.Silent, in.Idle, in.QuietFrom, in.QuietTo
	if u.Alive == 0 {
		u.Alive = time.Now().Unix() // switching it on is a sign of life
	}
	return o.save()
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

// addAlert keeps `a`, the newest sosAlertsKept only.
func (o *Sos) addAlert(a sosAlert) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensureLoaded()
	o.data.Alerts = append(o.data.Alerts, a)
	if n := len(o.data.Alerts); n > sosAlertsKept {
		o.data.Alerts = o.data.Alerts[n-sosAlertsKept:]
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
		if a.From == user || slices.ContainsFunc(a.To, func(t sosSent) bool { return t.User == user }) {
			return &a
		}
	}
	return nil
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

// quietEnd is the last end of the quiet window at or before `t` (unix s); 0
// when there is no window. Silence and idleness are counted from no earlier
// than this, so a phone off for the night does not alarm at its end.
func quietEnd(t time.Time, from, to string) int64 {
	f, ok1 := hhmmMinutes(from)
	e, ok2 := hhmmMinutes(to)
	if !ok1 || !ok2 || f == e {
		return 0
	}
	end := time.Date(t.Year(), t.Month(), t.Day(), e/60, e%60, 0, 0, t.Location())
	if end.After(t) {
		end = end.AddDate(0, 0, -1)
	}
	return end.Unix()
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
	o := s.sos
	o.mu.Lock()
	o.ensureLoaded()
	rows := slices.Clone(o.data.Users)
	o.mu.Unlock()

	for _, u := range rows {
		if len(u.Contacts) == 0 {
			continue
		}
		local := now
		if loc := Location(s.users.UserTZ("user", u.Owner)); loc != nil {
			local = now.In(loc)
		}
		quiet := inQuiet(local, u.QuietFrom, u.QuietTo)
		woke := quietEnd(local, u.QuietFrom, u.QuietTo)

		// Phone silent.
		if u.Silent > 0 && !quiet && now.Sub(o.started) > sosGrace {
			seen := s.devices.lastSeen(u.Owner)
			if seen > 0 && seen != u.SilentDone && now.Sub(time.Unix(max(seen, woke), 0)) > time.Duration(u.Silent)*time.Hour {
				if s.sosMark(u.Owner, func(r *sosUser) bool {
					if r.SilentDone == seen {
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
		case u.Asked == 0 && !quiet && now.Sub(time.Unix(max(u.Alive, woke), 0)) > time.Duration(u.Idle)*time.Hour:
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
		case u.Asked != 0 && u.IdleDone != u.Asked && now.Sub(time.Unix(u.Asked, 0)) > sosAnswer:
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
// declined (someone else got there first) or the row is gone.
func (s *Server) sosMark(owner string, fn func(*sosUser) bool) bool {
	o := s.sos
	o.mu.Lock()
	defer o.mu.Unlock()
	u := o.rowLocked(owner, false)
	if u == nil || !fn(u) {
		return false
	}
	return o.save()
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
	u := s.sos.Get(owner)
	a := sosAlert{ID: newChatID(), From: owner, Kind: kind, At: time.Now().Unix(), Since: since, Pos: pos}
	if a.Pos == nil {
		a.Pos = s.devices.Last(owner)
	}
	exists := s.users.ListUserNames()
	for _, c := range u.Contacts {
		if !slices.Contains(exists, c) {
			continue
		}
		sent := 0
		for _, sub := range s.users.PushTargets(c) {
			title, body := s.sosText(sub.Lang, kind, owner)
			payload := map[string]any{
				"title": title,
				"body":  body,
				"url":   URLPrefix + "/?sos=" + a.ID,
				"tag":   "sos-" + a.ID,
				"sos":   kind != "test",
			}
			if status, _ := deliverPush(s.push, s.users, s.log, c, sub, payload, sosAlertTTL); status >= 200 && status < 300 {
				sent++
			}
		}
		a.To = append(a.To, sosSent{User: c, Sent: sent})
	}
	if a.To == nil {
		a.To = []sosSent{}
	}
	s.sos.addAlert(a)
	s.log.Info("sos: alert", "user", owner, "kind", kind, "contacts", len(a.To))
	return a
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
	default:
		body = s.chat.phrase(lang, "sos.bodySos", "{name} pressed SOS. Tap to see where.")
	}
	return title, strings.ReplaceAll(body, "{name}", owner)
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
			"users": others, "phone": s.devices.lastSeen(user) > 0,
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
		a := s.sosAlert(user, kind, 0, pos)
		sendJSON(w, r, http.StatusOK, map[string]any{"id": a.ID, "to": a.To})

	case strings.HasPrefix(rest, "alert/") && r.Method == http.MethodGet:
		a := s.sos.alertFor(strings.TrimPrefix(rest, "alert/"), user)
		if a == nil {
			sendError(w, r, http.StatusNotFound, "no such alert")
			return
		}
		sendJSON(w, r, http.StatusOK, a)

	default:
		sendError(w, r, http.StatusNotFound, "no such endpoint")
	}
}
