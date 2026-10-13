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
// The queue lives in memory, like the rings and the finds: a restart loses
// what an offline phone had not fetched yet.

import (
	"encoding/json"
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
	exp   int64  // unix ms: dropped after, like a push's TTL
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
// False when there is no such phone showing notes (the sender then sees a 410).
func (d *Devices) queueNote(id string, raw []byte, ttl int) bool {
	var p struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		Tag   string `json:"tag"`
		URL   string `json:"url"`
		Quiet bool   `json:"quiet"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return false
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
		return false
	}
	now := time.Now().UnixMilli()
	d.noteSeq = max(d.noteSeq+1, now)
	note := deviceNote{ID: d.noteSeq, Title: p.Title, Body: p.Body, Tag: p.Tag, URL: p.URL,
		Quiet: p.Quiet, exp: now + int64(ttl)*1000}

	kept := []deviceNote{}
	for _, n := range d.notes[id] {
		if n.exp > now && (p.Tag == "" || n.Tag != p.Tag) {
			kept = append(kept, n)
		}
	}
	kept = append(kept, note)
	if len(kept) > appNotesMax {
		kept = kept[len(kept)-appNotesMax:]
	}
	d.notes[id] = kept
	d.kickLocked()
	return true
}

// notesFor is what phone `id` has not acked yet, oldest first; nil when none.
func (d *Devices) notesFor(id string) []deviceNote {
	d.mu.Lock()
	defer d.mu.Unlock()
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
	var kept []deviceNote
	for _, n := range d.notes[id] {
		if n.ID > last {
			kept = append(kept, n)
		}
	}
	if len(kept) == 0 {
		delete(d.notes, id)
	} else {
		d.notes[id] = kept
	}
	d.kickLocked()
}
