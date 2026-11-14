package main

// =============================================================================
// Notifications through the Android app, with no Google in between.
// =============================================================================
//
// Web push on Android goes through Google (FCM): a phone without Google -
// GrapheneOS, LineageOS, /e/OS without microG - never gets it. But the app
// already holds its own connection here (devices.go, the long poll), so every
// notification can ride on it instead:
//
//   - PushTargets is what each sender notifies: push.json's browsers, with
//     each phone of the app (from appNotesMin) as one more target, endpoint
//     appEndpoint+<phone id>. The Chrome inside that phone's TWA is left out:
//     the app shows the same notification, it must not come twice.
//   - VapidStore.SendJSON hands such a target to queueNote instead of a push
//     service; the phone's wait carries the queue as "notes", the app shows
//     them and acks the last id it showed (POST /api/device/ack {notes}).
//
// Everything else stays as it was: the senders, their words, their "sent"
// keys, deliverPush's rules. iPhones and computers keep web push. A call
// still rings through the app's own "call" (only its "missed" is a note), and
// a phone not seen for appNotesStale gets nothing here - its Chrome gets web
// push again, as before the app.
//
// The queue is kept on disk too, config/device-notes.json (D4): a note is
// "sent" only once it is there, so a restart (every deploy) never loses what
// an offline phone had not fetched yet. A note that could not be written is
// answered 503 and the sender tries again. Full (appNotesMax), the oldest
// plain note goes first - never an SOS one - and each one dropped is logged
// (D5).

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	appNotesMin   = 6                   // the first APK (versionCode) that shows notes itself
	appEndpoint   = "nayive-app:"       // + the phone's id: a push target that is a phone
	appNotesMax   = 30                  // queued per phone; the oldest go first
	appNotesStale = 14 * 24 * time.Hour // not seen this long: no notes, its Chrome gets web push
	appNoteBody   = 1000                // runes of text kept
)

// deviceNote is one notification waiting for a phone - the fields sw.js reads
// from a web push.
type deviceNote struct {
	ID    int64  `json:"id"` // grows, across restarts too (a clock in ms)
	Title string `json:"title"`
	Body  string `json:"body,omitempty"`
	Tag   string `json:"tag,omitempty"` // the same tag replaces, as in sw.js
	URL   string `json:"url,omitempty"` // a path on this server
	Quiet bool   `json:"quiet,omitempty"`
	Sos   bool   `json:"sos,omitempty"` // an SOS alert or "Are you OK?": the app rings it (sos.go)
	exp   int64  // unix ms: dropped after, like a push's TTL
}

// storedNote is a note as config/device-notes.json keeps it: with its expiry.
type storedNote struct {
	deviceNote
	Exp int64 `json:"exp"`
}

type deviceNotesFile struct {
	Phones map[string][]storedNote `json:"phones"`
}

func (d *Devices) notesPath() string {
	return filepath.Join(filepath.Dir(d.path), "device-notes.json")
}

// loadNotes reads the queue kept on disk: only live notes of phones still
// enrolled. Caller holds mu, from ensureLoaded.
func (d *Devices) loadNotes() {
	var file deviceNotesFile
	if ok, broken := loadTable(d.notesPath(), &file, d.log, "starting with no queued notes"); !ok {
		d.notesBroken = broken
		return
	}
	now := time.Now().UnixMilli()
	for id, ns := range file.Phones {
		if d.rowLocked(id) == nil {
			continue
		}
		for _, n := range ns {
			if n.Exp > now {
				n.deviceNote.exp = n.Exp
				d.notes[id] = append(d.notes[id], n.deviceNote)
				d.noteSeq = max(d.noteSeq, n.ID)
			}
		}
	}
}

// saveNotes writes the whole queue. Caller holds mu. false: not written.
func (d *Devices) saveNotes() bool {
	file := deviceNotesFile{Phones: map[string][]storedNote{}}
	for id, ns := range d.notes {
		for _, n := range ns {
			file.Phones[id] = append(file.Phones[id], storedNote{deviceNote: n, Exp: n.exp})
		}
	}
	if !saveTable(d.notesPath(), &d.notesBroken, file, d.log) {
		return false
	}
	_ = os.Chmod(d.notesPath(), 0o600) // the notes' words: nobody else's business
	return true
}

// phoneLocale is what the phone's wait says about it.
type phoneLocale struct{ tz, lang string }

// HookPush lets the app's phones receive pushes (server.go). Call once,
// before serving.
func (d *Devices) HookPush(users *Users, push *VapidStore) {
	users.appTargets = func(user string, subs []PushSub) []PushSub {
		return d.pushTargets(user, subs, users.UserLang("user", user))
	}
	push.local = d.queueNote
}

// PushTargets is every device a notification for `user` goes to: push.json's
// browsers, plus the Android app's phones (push_app.go). Senders use this;
// showing and editing push.json use UserPush.
func (u *Users) PushTargets(user string) []PushSub {
	subs := u.UserPush(user).Subs
	if u.appTargets != nil {
		subs = u.appTargets(user, subs)
	}
	return subs
}

// notePhones is `user`'s phones that show notes, seen lately.
func (d *Devices) notePhones(user string) []deviceRow {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	var out []deviceRow
	for _, r := range d.rows {
		seen := max(r.Seen, d.seen[r.ID])
		if r.Owner == user && r.App >= appNotesMin && time.Since(time.Unix(seen, 0)) < appNotesStale {
			out = append(out, r)
		}
	}
	return out
}

// pushTargets: subs without the Chrome inside each phone, plus one target per
// phone. Its words: that Chrome's language, else the account's, else the
// phone's own. Its zone: the phone's, else that Chrome's ("" = the account's).
func (d *Devices) pushTargets(user string, subs []PushSub, accountLang *string) []PushSub {
	phones := d.notePhones(user)
	if len(phones) == 0 {
		return subs
	}
	inside := make(map[string]PushSub)
	out := make([]PushSub, 0, len(subs)+len(phones))
	for _, s := range subs {
		taken := false
		for _, p := range phones {
			if p.Endpoint != "" && p.Endpoint == s.Endpoint {
				inside[p.ID], taken = s, true
				break
			}
		}
		if !taken {
			out = append(out, s)
		}
	}
	for _, p := range phones {
		loc := d.localeOf(p.ID)
		sub := PushSub{Endpoint: appEndpoint + p.ID, Lang: "es", TZ: loc.tz}
		chrome, ok := inside[p.ID]
		switch {
		case ok:
			sub.Lang = chrome.Lang
		case accountLang != nil && *accountLang != "":
			sub.Lang = *accountLang
		case loc.lang != "":
			sub.Lang = loc.lang
		}
		if sub.TZ == "" && ok {
			sub.TZ = chrome.TZ
		}
		out = append(out, sub)
	}
	return out
}

// setLocale keeps what the phone's wait says: an IANA zone and a language.
func (d *Devices) setLocale(id, tz, lang string) {
	lang = strings.ToLower(strings.TrimSpace(lang))
	if !contains(UILangs, lang) {
		lang = ""
	}
	loc := phoneLocale{tz: cleanTZ(tz), lang: lang}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.locales[id] = loc
}

// setApp keeps the APK's versionCode, from the X-Nayive-App header of its
// wait: it says whether the phone shows notes. Written only when it changes.
func (d *Devices) setApp(id, header string) {
	code, err := strconv.Atoi(strings.TrimSpace(header))
	if err != nil || code <= 0 {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	if r := d.rowLocked(id); r != nil && r.App != code {
		r.App = code
		d.save()
	}
}

func (d *Devices) localeOf(id string) phoneLocale {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.locales[id]
}

// queueNote is VapidStore.local: one push for phone `id`, kept for its wait.
// 201 kept (on disk too), 410 no such phone showing notes, 503 not written
// (nothing kept: the sender tries again, D4).
func (d *Devices) queueNote(id string, raw []byte, ttl int) int {
	var p struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		Tag   string `json:"tag"`
		URL   string `json:"url"`
		Quiet bool   `json:"quiet"`
		Sos   bool   `json:"sos"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return http.StatusGone
	}
	if p.Title == "" {
		p.Title = "Nayive"
	}
	if body := []rune(p.Body); len(body) > appNoteBody {
		p.Body = string(body[:appNoteBody-1]) + "…"
	}
	if !strings.HasPrefix(p.URL, "/") || strings.HasPrefix(p.URL, "//") {
		p.URL = URLPrefix + "/" // the app opens it on this server, nowhere else
	}
	ttl = max(ttl, ttlMin)

	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	row := d.rowLocked(id)
	if row == nil || row.App < appNotesMin {
		return http.StatusGone
	}
	now := time.Now().UnixMilli()
	d.noteSeq = max(d.noteSeq+1, now)
	note := deviceNote{ID: d.noteSeq, Title: p.Title, Body: p.Body, Tag: p.Tag, URL: p.URL,
		Quiet: p.Quiet, Sos: p.Sos, exp: now + int64(ttl)*1000}

	kept := []deviceNote{}
	for _, n := range d.notes[id] {
		if n.exp > now && (p.Tag == "" || n.Tag != p.Tag) {
			kept = append(kept, n)
		}
	}
	kept = append(kept, note)
	// Full: the oldest plain note goes first, never an SOS one (D5) - and
	// never silently.
	for len(kept) > appNotesMax {
		drop := 0
		for i, n := range kept {
			if !n.Sos {
				drop = i
				break
			}
		}
		d.log.Warn("app phone: queue full, a note it never fetched dropped",
			"phone", id, "title", kept[drop].Title, "sos", kept[drop].Sos)
		kept = append(kept[:drop:drop], kept[drop+1:]...)
	}
	before, had := d.notes[id]
	d.notes[id] = kept
	if !d.saveNotes() {
		if had {
			d.notes[id] = before
		} else {
			delete(d.notes, id)
		}
		return http.StatusServiceUnavailable
	}
	d.kickLocked()
	return http.StatusCreated
}

// notesFor is what phone `id` has not acked yet, oldest first; nil when none.
func (d *Devices) notesFor(id string) []deviceNote {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded() // right after a restart: the queue kept on disk
	now := time.Now().UnixMilli()
	var out []deviceNote
	for _, n := range d.notes[id] {
		if n.exp > now {
			out = append(out, n)
		}
	}
	return out
}

// ackNotes forgets phone `id`'s notes up to `last`: it has shown them.
func (d *Devices) ackNotes(id string, last int64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	var kept []deviceNote
	for _, n := range d.notes[id] {
		if n.ID > last {
			kept = append(kept, n)
		}
	}
	gone := len(kept) < len(d.notes[id])
	if len(kept) == 0 {
		delete(d.notes, id)
	} else {
		d.notes[id] = kept
	}
	// Not written: the shown notes may show once more after a restart -
	// never one lost.
	if gone && !d.saveNotes() {
		d.log.Warn("app phone: acked notes not written; they may show again after a restart", "phone", id)
	}
	d.kickLocked()
}

// dropNotesLocked forgets the queue of phones that are gone. Caller holds mu.
func (d *Devices) dropNotesLocked(ids ...string) {
	changed := false
	for _, id := range ids {
		if _, ok := d.notes[id]; ok {
			delete(d.notes, id)
			changed = true
		}
	}
	if changed {
		d.saveNotes()
	}
}
