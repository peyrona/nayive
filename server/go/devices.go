package main

// =============================================================================
// Devices - the phones of the Android app (android/, docs/android-app.md).
// =============================================================================
//
// The app is the PWA itself in a Trusted Web Activity, plus one foreground
// service that holds ONE long poll open here - the shape chatWait already
// uses. Through it the phone learns, with the screen off, what a web page
// cannot wait for:
//
//	GET /api/device/wait?v=V   (the app) -> {"v","hold","track","badge","call","find"}
//
//	track  a trip of the owner covers today, on the owner's clock (the rule
//	       positions.go keeps positions by): send positions
//	badge  the unread chat messages (the launcher's own count)
//	call   a Chat call ringing for the owner right now (chat_call.go hands it over)
//	find   "Buscar mi móvil" was pressed for THIS phone
//
// It answers at once when that differs from V (a hash of the answer the phone
// last saw), otherwise when something changes, otherwise after `hold` seconds.
// Held minutes, not the browser's 25 s: a phone reconnecting every 25 s never
// lets its radio sleep.
//
// ENROLMENT. The app makes its own token and opens /nayive/device.html#t=<token>
// in the TWA - a #fragment, never sent here, never logged. That page keeps it
// in the browser and goes on to the launcher, which - once the user is signed
// in - hands it over:
//
//	POST   /api/device/enrol            (session) {t, name, endpoint?} -> {"id"}
//	GET    /api/device                  (session) -> the phones, the finds, the last position
//	DELETE /api/device/<id>             (session) -> revoke: that token stops working
//	POST   /api/device/find             (session) {id} ring that phone
//	                                              {ask: true, endpoint?} push "¿Dónde estás?"
//	POST   /api/device/find/<fid>/stop  (session) stop it from the web
//	POST   /api/device/here             (session) {lat, lon, acc, find?} this browser's position
//
//	POST   /api/device/report           (the app) {positions?, find?}
//	POST   /api/device/ack              (the app) {call|find, act: decline|stop}
//
// The app's credential is its token, in the X-Nayive-Device header: a URL ends
// up in logs, a header does not. Only the token's SHA-256 is stored, in
// config/devices.json beside location.json - like that one, outside every home.
//
// NOTHING HERE CHANGES WHAT THE WEB DOES. /api/location/* (GPSLogger, Overland)
// is not touched, and web push still reaches every device - except two pushes
// to the ONE Chrome that sits inside an enrolled phone's TWA (its endpoint comes
// with the enrolment): a call's ring, which the app already rings, and the ±2 h
// "turn the location app on/off" alerts, since that phone switches itself.
//
// THE LAST POSITION. "Buscar mi móvil" also shows where the owner was last seen,
// from every source there is: this app, GPSLogger, Overland, a photo's GPS, a
// browser. positions.go keeps nothing between trips and rounds what it keeps to
// ~110 m, both on purpose, so this has a store of its own: ONE position per
// user, at ~1 m, in the user's data/devices/last.json, forgotten after
// lastPosTTL. It never goes into positions.json, the Journey map or /s/.

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Timeouts are vars, not consts, so the tests can shorten them.
var (
	deviceHold = 180 * time.Second // how long a wait is held
	findRing   = 5 * time.Minute   // "Buscar mi móvil" stops by itself after this
	findKeep   = 30 * time.Minute  // a finished find stays visible in the web dialog this long
)

const (
	deviceTokenMin  = 32              // bytes of the token's text; the app sends 43
	devicesMax      = 10              // phones per user
	deviceNameMax   = 60              // runes
	deviceOnline    = 5 * time.Minute // seen this recently: its wait is (or was just) open
	deviceSeenSave  = time.Hour       // "seen" reaches the disk at most this often
	deviceReportMax = 1000            // positions in one report
	lastPosTTL      = 30 * 24 * time.Hour
	deviceHeader    = "X-Nayive-Device"
)

// deviceRow is one line of config/devices.json.
type deviceRow struct {
	ID       string `json:"id"` // shown to the owner; NOT a credential
	Owner    string `json:"owner"`
	Hash     string `json:"hash"` // hex SHA-256 of the token
	Name     string `json:"name"`
	Created  int64  `json:"created"`
	Seen     int64  `json:"seen"`
	App      int    `json:"app,omitempty"`      // the APK's versionCode
	Endpoint string `json:"endpoint,omitempty"` // web push of the Chrome inside its TWA
}

type devicesFile struct {
	Devices []deviceRow `json:"devices"`
}

// deviceRing is a Chat call ringing for an account (chat_call.go's hook).
type deviceRing struct {
	ID    string // the call
	Owner string // whose chat the call lives in: this account, or another user's ("via")
	Pid   string // who is called there: "o", or the account's contact id
	From  string
	Video bool
	URL   string
	Until int64 // ms: rings no longer than this
}

// deviceFind is one press of "Buscar mi móvil".
type deviceFind struct {
	ID     string   `json:"id"`
	Device string   `json:"device"` // the phone; "" for the "¿Dónde estás?" push
	Owner  string   `json:"-"`
	Since  int64    `json:"since"` // ms
	State  string   `json:"state"` // ringing | stopped | cancelled | timeout | asked
	Ended  int64    `json:"ended,omitempty"`
	Pos    *lastPos `json:"pos,omitempty"` // what it reported
}

// lastPos is a position as the find dialog shows it.
type lastPos struct {
	Lat    float64 `json:"lat"`
	Lon    float64 `json:"lon"`
	Acc    float64 `json:"acc,omitempty"`
	At     int64   `json:"at"` // unix seconds, when it was TAKEN
	Source string  `json:"source"`
}

// Devices is the phone table plus what lives only in memory: the waits, the
// ringing calls, the finds.
type Devices struct {
	mu     sync.Mutex
	path   string
	homes  string
	loaded bool
	broken bool
	rows   []deviceRow
	seen   map[string]int64 // id -> unix seconds; on disk at most every deviceSeenSave
	log    Logger

	wake    chan struct{}          // closed and replaced on every change: each wait re-checks itself
	rings   map[string]*deviceRing // account -> the call ringing for it
	finds   map[string]*deviceFind // find id -> the find
	trips   map[string]tripsToday  // account -> "a trip covers today", cached a minute
	closing chan struct{}
	once    sync.Once

	lastMu sync.Mutex // one last.json write at a time
}

type tripsToday struct {
	on   bool
	when time.Time
}

func NewDevices(configDir, homesDir string, log Logger) *Devices {
	return &Devices{
		path:    filepath.Join(configDir, "devices.json"),
		homes:   homesDir,
		seen:    make(map[string]int64),
		log:     log,
		wake:    make(chan struct{}),
		rings:   make(map[string]*deviceRing),
		finds:   make(map[string]*deviceFind),
		trips:   make(map[string]tripsToday),
		closing: make(chan struct{}),
	}
}

// Close ends every open wait at once (a shutdown must not sit them out).
func (d *Devices) Close() { d.once.Do(func() { close(d.closing) }) }

// Kick wakes every wait; each one answers only if its phone's state changed.
// Safe to call with the chat hub's lock held: it takes nothing else.
func (d *Devices) Kick() {
	d.mu.Lock()
	d.kickLocked()
	d.mu.Unlock()
}

func (d *Devices) kickLocked() {
	close(d.wake)
	d.wake = make(chan struct{})
}

func (d *Devices) wakeChan() <-chan struct{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.wake
}

// -----------------------------------------------------------------------------
// the table on disk
// -----------------------------------------------------------------------------

// ensureLoaded fills the table the first time anything asks. Caller holds mu.
func (d *Devices) ensureLoaded() {
	if d.loaded {
		return
	}
	d.loaded = true
	raw, err := os.ReadFile(d.path)
	if err != nil {
		if !os.IsNotExist(err) {
			d.log.Error("devices.json is unreadable - starting with no phones", "err", err)
			d.broken = true
		}
		return
	}
	var file devicesFile
	if err := json.Unmarshal(raw, &file); err != nil {
		d.log.Error("devices.json is unreadable - starting with no phones", "err", err)
		d.broken = true
		return
	}
	for _, r := range file.Devices {
		if r.ID != "" && r.Owner != "" && len(r.Hash) == 64 {
			d.rows = append(d.rows, r)
		}
	}
}

// save writes the table back. Caller holds mu. Like Trackers.save, it never
// writes over a file that could not be read: that one is moved aside first.
func (d *Devices) save() {
	if d.broken {
		aside := d.path + ".broken-" + time.Now().Format("2006-01-02-150405")
		if err := os.Rename(d.path, aside); err != nil && !os.IsNotExist(err) {
			d.log.Error("devices.json is unreadable and cannot be moved aside - not saving", "err", err)
			return
		}
		d.broken = false
	}
	rows := make([]deviceRow, len(d.rows))
	for i, r := range d.rows {
		if s := d.seen[r.ID]; s > r.Seen {
			r.Seen = s
			d.rows[i].Seen = s
		}
		rows[i] = r
	}
	if err := atomicWriteJSON(d.path, devicesFile{Devices: rows}, 4); err != nil {
		d.log.Error("cannot save devices.json", "err", err)
	}
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// validDeviceToken: long enough, and only the characters a base64url token has.
func validDeviceToken(t string) bool {
	if len(t) < deviceTokenMin || len(t) > 128 {
		return false
	}
	for _, c := range t {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// ByToken is the phone holding this token, or nil. Also marks it seen.
func (d *Devices) ByToken(token string) *deviceRow {
	if !validDeviceToken(token) {
		return nil
	}
	h := []byte(tokenHash(token))
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	for i := range d.rows {
		if subtle.ConstantTimeCompare([]byte(d.rows[i].Hash), h) == 1 {
			d.touchLocked(i)
			r := d.rows[i]
			return &r
		}
	}
	return nil
}

// byID is a phone by its id, or nil (a wait checks its phone was not revoked).
func (d *Devices) byID(id string) *deviceRow {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	for i := range d.rows {
		if d.rows[i].ID == id {
			r := d.rows[i]
			return &r
		}
	}
	return nil
}

func (d *Devices) touchLocked(i int) {
	now := time.Now().Unix()
	d.seen[d.rows[i].ID] = now
	if now-d.rows[i].Seen >= int64(deviceSeenSave/time.Second) {
		d.save()
	}
}

func cleanDeviceName(name string) string {
	var b strings.Builder
	n := 0
	for _, r := range strings.TrimSpace(name) {
		if unicode.IsControl(r) {
			r = ' '
		}
		if n++; n > deviceNameMax {
			break
		}
		b.WriteRune(r)
	}
	if s := strings.TrimSpace(b.String()); s != "" {
		return s
	}
	return "Android"
}

var errTooManyDevices = errors.New("demasiados móviles; quita alguno en Mi cuenta")

// Enrol registers the phone holding `token` for `owner`, or refreshes it (name,
// endpoint). A token another account enrolled moves to this one: the phone
// belongs to whoever signed in on it last.
func (d *Devices) Enrol(owner, token, name, endpoint string, app int) (string, error) {
	h := tokenHash(token)
	name = cleanDeviceName(name)
	if len(endpoint) > 1024 || !strings.HasPrefix(endpoint, "https://") {
		endpoint = ""
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	now := time.Now().Unix()
	for i := range d.rows {
		if subtle.ConstantTimeCompare([]byte(d.rows[i].Hash), []byte(h)) != 1 {
			continue
		}
		r := &d.rows[i]
		r.Owner, r.Name, r.Seen = owner, name, now
		if endpoint != "" {
			r.Endpoint = endpoint
		}
		if app > 0 {
			r.App = app
		}
		d.save()
		d.kickLocked()
		return r.ID, nil
	}
	n := 0
	for _, r := range d.rows {
		if r.Owner == owner {
			n++
		}
	}
	if n >= devicesMax {
		return "", errTooManyDevices
	}
	id := newChatID()
	d.rows = append(d.rows, deviceRow{ID: id, Owner: owner, Hash: h, Name: name,
		Created: now, Seen: now, App: app, Endpoint: endpoint})
	d.save()
	d.kickLocked()
	d.log.Info("phone enrolled", "owner", owner, "id", id)
	return id, nil
}

// List is `owner`'s phones, newest first, with "seen" as fresh as it is.
func (d *Devices) List(owner string) []deviceRow {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	out := []deviceRow{}
	for _, r := range d.rows {
		if r.Owner == owner {
			if s := d.seen[r.ID]; s > r.Seen {
				r.Seen = s
			}
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	return out
}

// Revoke forgets one phone of `owner`; its token dies with it.
func (d *Devices) Revoke(owner, id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	kept := d.rows[:0:0]
	found := false
	for _, r := range d.rows {
		if r.Owner == owner && r.ID == id {
			found = true
			delete(d.seen, id)
			continue
		}
		kept = append(kept, r)
	}
	if found {
		d.rows = kept
		d.save()
		d.kickLocked()
		d.log.Info("phone revoked", "owner", owner, "id", id)
	}
	return found
}

// DropUser forgets a deleted user's phones.
func (d *Devices) DropUser(name string) { d.rename(name, "") }

// RenameUser moves a renamed user's phones to the new name.
func (d *Devices) RenameUser(oldName, newName string) { d.rename(oldName, newName) }

func (d *Devices) rename(owner, to string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	kept := d.rows[:0:0]
	found := false
	for _, r := range d.rows {
		if r.Owner != owner {
			kept = append(kept, r)
			continue
		}
		found = true
		if to != "" {
			r.Owner = to
			kept = append(kept, r)
		}
	}
	if found {
		d.rows = kept
		d.save()
		d.kickLocked()
	}
	delete(d.rings, owner)
	delete(d.trips, owner)
}

// linked is the phone of `account` whose TWA holds this web-push endpoint, or nil.
func (d *Devices) linked(account, endpoint string) *deviceRow {
	if endpoint == "" {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	for _, r := range d.rows {
		if r.Owner == account && r.Endpoint == endpoint {
			if s := d.seen[r.ID]; s > r.Seen {
				r.Seen = s
			}
			return &r
		}
	}
	return nil
}

// SkipCallPush: this push endpoint is the Chrome inside a phone whose app is
// connected, so the app rings the call itself - Chrome ringing too would be the
// same call twice. A phone not seen lately gets the push after all.
func (d *Devices) SkipCallPush(account, endpoint string) bool {
	r := d.linked(account, endpoint)
	return r != nil && time.Since(time.Unix(r.Seen, 0)) < deviceOnline
}

// HasApp: this push endpoint belongs to a phone with the app, which turns its
// positions on and off by itself - it needs no "turn it on" alert.
func (d *Devices) HasApp(account, endpoint string) bool {
	return d.linked(account, endpoint) != nil
}

// -----------------------------------------------------------------------------
// calls (the chat hub's hook) and finds
// -----------------------------------------------------------------------------

// OnCall is told, under the chat hub's lock, about every ring, missed and quiet
// of a call to `account`. Only the ring is kept; anything else ends it.
func (d *Devices) OnCall(account string, ring deviceRing, kind string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if kind == "ring" {
		r := ring
		d.rings[account] = &r
	} else if cur := d.rings[account]; cur != nil && cur.ID == ring.ID {
		delete(d.rings, account)
	} else {
		return
	}
	d.kickLocked()
}

// ringFor is the call ringing for `account` now, or nil.
func (d *Devices) ringFor(account string) *deviceRing {
	d.mu.Lock()
	defer d.mu.Unlock()
	r := d.rings[account]
	if r == nil {
		return nil
	}
	if time.Now().UnixMilli() > r.Until {
		delete(d.rings, account)
		return nil
	}
	c := *r
	return &c
}

func (d *Devices) dropRing(account, id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if r := d.rings[account]; r != nil && r.ID == id {
		delete(d.rings, account)
		d.kickLocked()
	}
}

// sweepFinds ends the finds that rang too long and forgets the old ones.
// Caller holds mu.
func (d *Devices) sweepFinds(now time.Time) {
	for id, f := range d.finds {
		switch {
		case f.State == "ringing" && now.Sub(time.UnixMilli(f.Since)) >= findRing:
			f.State, f.Ended = "timeout", now.UnixMilli()
			d.kickLocked()
		case f.State != "ringing" && now.Sub(time.UnixMilli(f.Since)) >= findKeep:
			delete(d.finds, id)
		}
	}
}

// StartFind rings phone `device` of `owner`. Pressing it again while it rings
// hands back the same find.
func (d *Devices) StartFind(owner, device string) (*deviceFind, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLoaded()
	ok := false
	for _, r := range d.rows {
		if r.Owner == owner && r.ID == device {
			ok = true
		}
	}
	if !ok {
		return nil, false
	}
	now := time.Now()
	d.sweepFinds(now)
	for _, f := range d.finds {
		if f.Device == device && f.State == "ringing" {
			c := *f
			return &c, true
		}
	}
	f := &deviceFind{ID: newChatID(), Device: device, Owner: owner, Since: now.UnixMilli(), State: "ringing"}
	d.finds[f.ID] = f
	d.kickLocked()
	c := *f
	return &c, true
}

// AskFind records a "¿Dónde estás?" push, so the answer has somewhere to land.
func (d *Devices) AskFind(owner string) *deviceFind {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := time.Now()
	d.sweepFinds(now)
	f := &deviceFind{ID: newChatID(), Owner: owner, Since: now.UnixMilli(), State: "asked"}
	d.finds[f.ID] = f
	c := *f
	return &c
}

// StopFind ends a find of `owner`: "stopped" from the phone, "cancelled" from
// the web. False when there is no such find.
func (d *Devices) StopFind(owner, id, state string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	f := d.finds[id]
	if f == nil || f.Owner != owner {
		return false
	}
	if f.State == "ringing" {
		f.State, f.Ended = state, time.Now().UnixMilli()
		d.kickLocked()
	}
	return true
}

// FoundAt stores what a find's phone (or browser) reported.
func (d *Devices) FoundAt(owner, id string, p lastPos) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	f := d.finds[id]
	if f == nil || f.Owner != owner {
		return false
	}
	f.Pos = &p
	return true
}

// ringingFind is the find that rings `device` now, or nil.
func (d *Devices) ringingFind(device string) *deviceFind {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sweepFinds(time.Now())
	for _, f := range d.finds {
		if f.Device == device && f.State == "ringing" {
			c := *f
			return &c
		}
	}
	return nil
}

// findsOf is `owner`'s recent finds, newest first.
func (d *Devices) findsOf(owner string) []deviceFind {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sweepFinds(time.Now())
	out := []deviceFind{}
	for _, f := range d.finds {
		if f.Owner == owner {
			out = append(out, *f)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Since > out[j].Since })
	return out
}

// -----------------------------------------------------------------------------
// the last position
// -----------------------------------------------------------------------------

func (d *Devices) lastPath(owner string) string {
	return filepath.Join(d.homes, owner, "data", "devices", "last.json")
}

// Last is where `owner` was last seen, or nil when there is none this recent.
func (d *Devices) Last(owner string) *lastPos {
	var p lastPos
	if !loadJSONFile(d.lastPath(owner), &p) || p.At <= 0 {
		return nil
	}
	if time.Since(time.Unix(p.At, 0)) > lastPosTTL {
		return nil
	}
	return &p
}

// NoteLast keeps `p` as `owner`'s last position if it is newer than the one
// there is. The user's home must already exist: nothing is created for a user
// who is not there.
func (d *Devices) NoteLast(owner string, p lastPos) {
	if !validLatLon(p.Lat, p.Lon) || p.At <= 0 || time.Unix(p.At, 0).After(time.Now().Add(positionFuture)) {
		return
	}
	if info, err := os.Stat(filepath.Join(d.homes, owner)); err != nil || !info.IsDir() {
		return
	}
	p.Lat = math.Round(p.Lat*1e5) / 1e5 // ~1 m: this store is for finding a phone
	p.Lon = math.Round(p.Lon*1e5) / 1e5
	if math.IsNaN(p.Acc) || p.Acc < 0 {
		p.Acc = 0
	}
	p.Acc = math.Min(math.Ceil(p.Acc), 100000)

	d.lastMu.Lock()
	defer d.lastMu.Unlock()
	var cur lastPos
	if loadJSONFile(d.lastPath(owner), &cur) && cur.At > p.At {
		return
	}
	path := d.lastPath(owner)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	if err := atomicWriteJSON(path, p, 1); err != nil {
		d.log.Error("cannot save the last position", "owner", owner, "err", err)
	}
}

// -----------------------------------------------------------------------------
// what a phone is told
// -----------------------------------------------------------------------------

type deviceCallOut struct {
	ID    string `json:"id"`
	From  string `json:"from"`
	Video bool   `json:"video"`
	URL   string `json:"url"`
	Until int64  `json:"until"`
}

type deviceFindOut struct {
	ID    string `json:"id"`
	Since int64  `json:"since"`
}

type deviceState struct {
	Track bool           `json:"track"`
	Badge int            `json:"badge"`
	Call  *deviceCallOut `json:"call"`
	Find  *deviceFindOut `json:"find"`
}

// version is what the phone echoes back: equal means nothing to tell it.
func (st deviceState) version() string {
	raw, _ := json.Marshal(st)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}

// tripToday: a trip of `owner` that keeps positions covers today, on the
// owner's clock. Cached a minute - every chat change wakes every wait.
func (s *Server) tripToday(owner string) bool {
	d := s.devices
	d.mu.Lock()
	if c, ok := d.trips[owner]; ok && time.Since(c.when) < time.Minute {
		d.mu.Unlock()
		return c.on
	}
	d.mu.Unlock()

	now := time.Now()
	if loc := Location(s.users.UserTZ("user", owner)); loc != nil { // nil: the server's own clock
		now = now.In(loc)
	}
	today := now.Format("2006-01-02")
	on := false
	for _, lt := range s.trackedTrips(owner) {
		if lt.trip.StartDate != "" && lt.trip.EndDate != "" &&
			lt.trip.StartDate <= today && today <= lt.trip.EndDate {
			on = true
			break
		}
	}
	d.mu.Lock()
	d.trips[owner] = tripsToday{on: on, when: time.Now()}
	d.mu.Unlock()
	return on
}

// deviceStateFor is the phone's whole state, and the next moment it changes
// by itself (a ring's deadline, a find's timeout) - zero when none.
func (s *Server) deviceStateFor(r *deviceRow) (deviceState, time.Time) {
	var next time.Time
	st := deviceState{Track: s.tripToday(r.Owner), Badge: s.chatUnreadOf(r.Owner)}
	if ring := s.devices.ringFor(r.Owner); ring != nil {
		st.Call = &deviceCallOut{ID: ring.ID, From: ring.From, Video: ring.Video, URL: ring.URL, Until: ring.Until}
		next = time.UnixMilli(ring.Until)
	}
	if f := s.devices.ringingFind(r.ID); f != nil {
		st.Find = &deviceFindOut{ID: f.ID, Since: f.Since}
		if end := time.UnixMilli(f.Since).Add(findRing); next.IsZero() || end.Before(next) {
			next = end
		}
	}
	return st, next
}

// -----------------------------------------------------------------------------
// the routes
// -----------------------------------------------------------------------------

// apiDevice is /api/device and everything under it.
func (s *Server) apiDevice(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(r.PathValue("rest"), "/")

	// The app's own three: the token is the whole credential.
	switch rest {
	case "wait", "report", "ack":
		dev := s.devices.ByToken(r.Header.Get(deviceHeader))
		if dev == nil {
			sendError(w, r, http.StatusUnauthorized, "este móvil no está dado de alta")
			return
		}
		switch rest {
		case "wait":
			if r.Method != http.MethodGet {
				sendError(w, r, http.StatusMethodNotAllowed, "use GET")
				return
			}
			s.deviceWait(w, r, dev)
		case "report":
			s.deviceReport(w, r, dev)
		case "ack":
			s.deviceAck(w, r, dev)
		}
		return
	}

	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if sess.Role == "admin" {
		sendError(w, r, http.StatusForbidden, "los móviles son por usuario; entra como usuario")
		return
	}
	user := sess.User
	parts := strings.Split(rest, "/")

	switch {
	case rest == "":
		if r.Method != http.MethodGet {
			sendError(w, r, http.StatusMethodNotAllowed, "use GET")
			return
		}
		s.deviceList(w, r, user)

	case rest == "enrol":
		if r.Method != http.MethodPost {
			sendError(w, r, http.StatusMethodNotAllowed, "use POST")
			return
		}
		var body struct {
			T        string `json:"t"`
			Name     string `json:"name"`
			Endpoint string `json:"endpoint"`
		}
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		if !validDeviceToken(body.T) {
			sendError(w, r, http.StatusBadRequest, "código de móvil no válido")
			return
		}
		id, err := s.devices.Enrol(user, body.T, body.Name, body.Endpoint, 0)
		if err != nil {
			sendError(w, r, http.StatusConflict, err.Error())
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"id": id})

	case rest == "find":
		if r.Method != http.MethodPost {
			sendError(w, r, http.StatusMethodNotAllowed, "use POST")
			return
		}
		s.deviceFindStart(w, r, user)

	case len(parts) == 3 && parts[0] == "find" && parts[2] == "stop":
		if r.Method != http.MethodPost {
			sendError(w, r, http.StatusMethodNotAllowed, "use POST")
			return
		}
		if !s.devices.StopFind(user, parts[1], "cancelled") {
			sendError(w, r, http.StatusNotFound, "esa búsqueda ya no existe")
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"ok": true})

	case rest == "here":
		if r.Method != http.MethodPost {
			sendError(w, r, http.StatusMethodNotAllowed, "use POST")
			return
		}
		var body struct {
			Lat  *float64 `json:"lat"`
			Lon  *float64 `json:"lon"`
			Acc  *float64 `json:"acc"`
			Find string   `json:"find"`
		}
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		if body.Lat == nil || body.Lon == nil || !validLatLon(*body.Lat, *body.Lon) {
			sendError(w, r, http.StatusBadRequest, "posición no válida")
			return
		}
		p := lastPos{Lat: *body.Lat, Lon: *body.Lon, At: time.Now().Unix(), Source: "browser"}
		if body.Acc != nil {
			p.Acc = *body.Acc
		}
		s.devices.NoteLast(user, p)
		if body.Find != "" {
			s.devices.FoundAt(user, body.Find, s.roundedForFind(p))
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"ok": true})

	case len(parts) == 1 && r.Method == http.MethodDelete:
		if !s.devices.Revoke(user, parts[0]) {
			sendError(w, r, http.StatusNotFound, "ese móvil no existe")
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		sendError(w, r, http.StatusNotFound, "no such endpoint")
	}
}

// roundedForFind is p as the find dialog shows it (same ~1 m as last.json).
func (s *Server) roundedForFind(p lastPos) lastPos {
	p.Lat = math.Round(p.Lat*1e5) / 1e5
	p.Lon = math.Round(p.Lon*1e5) / 1e5
	if math.IsNaN(p.Acc) || p.Acc < 0 {
		p.Acc = 0
	}
	p.Acc = math.Ceil(p.Acc)
	return p
}

type deviceOut struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Created int64  `json:"created"`
	Seen    int64  `json:"seen"`
	Online  bool   `json:"online"`
}

// deviceList is what the web shows: Mi cuenta's phones, and the find dialog.
func (s *Server) deviceList(w http.ResponseWriter, r *http.Request, user string) {
	out := []deviceOut{}
	for _, d := range s.devices.List(user) {
		out = append(out, deviceOut{ID: d.ID, Name: d.Name, Created: d.Created, Seen: d.Seen,
			Online: time.Since(time.Unix(d.Seen, 0)) < deviceOnline})
	}
	sendJSON(w, r, http.StatusOK, map[string]any{
		"devices": out,
		"finds":   s.devices.findsOf(user),
		"last":    s.devices.Last(user),
		"push":    len(s.users.UserPush(user).Subs),
	})
}

// deviceFindStart: {id} rings that phone; {ask: true} pushes "¿Dónde estás?" to
// every browser of the user with notifications, but the one asking.
func (s *Server) deviceFindStart(w http.ResponseWriter, r *http.Request, user string) {
	var body struct {
		ID       string `json:"id"`
		Ask      bool   `json:"ask"`
		Endpoint string `json:"endpoint"`
	}
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}
	if !body.Ask {
		f, ok := s.devices.StartFind(user, body.ID)
		if !ok {
			sendError(w, r, http.StatusNotFound, "ese móvil no existe")
			return
		}
		s.log.Info("find my phone", "owner", user, "device", body.ID)
		sendJSON(w, r, http.StatusOK, map[string]any{"find": f})
		return
	}

	f := s.devices.AskFind(user)
	var subs []PushSub
	for _, sub := range s.users.UserPush(user).Subs {
		if sub.Endpoint != body.Endpoint {
			subs = append(subs, sub)
		}
	}
	for _, sub := range subs {
		payload := map[string]any{
			"title": s.chat.phrase(sub.Lang, "find.askTitle", "¿Dónde estás?"),
			"body":  s.chat.phrase(sub.Lang, "find.askBody", "Toca para enviar dónde está este dispositivo."),
			"url":   URLPrefix + "/?here=" + f.ID,
			"tag":   "here-" + f.ID,
		}
		go deliverPush(s.push, s.users, s.log, user, sub, payload, int(findKeep/time.Second))
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"find": f, "asked": len(subs)})
}

// deviceWait is the phone's long poll. It never holds a lock while it waits.
func (s *Server) deviceWait(w http.ResponseWriter, r *http.Request, dev *deviceRow) {
	seen := queryValue(r, "v")
	deadline := time.Now().Add(deviceHold)
	for {
		// The channel is taken BEFORE the state is read: a change that lands
		// while it is being read still wakes this wait.
		wake := s.devices.wakeChan()
		st, next := s.deviceStateFor(dev)
		v := st.version()
		now := time.Now()
		if v != seen || !now.Before(deadline) {
			sendJSON(w, r, http.StatusOK, map[string]any{
				"v": v, "hold": int(deviceHold / time.Second),
				"track": st.Track, "badge": st.Badge, "call": st.Call, "find": st.Find,
			})
			return
		}
		until := deadline
		if !next.IsZero() && next.Before(until) {
			until = next.Add(50 * time.Millisecond)
		}
		timer := time.NewTimer(time.Until(until))
		select {
		case <-wake:
		case <-timer.C:
		case <-r.Context().Done():
			timer.Stop()
			return
		case <-s.devices.closing:
			timer.Stop()
			deadline = time.Now() // answer what there is, now
		}
		timer.Stop()
		if cur := s.devices.byID(dev.ID); cur == nil || cur.Owner != dev.Owner {
			sendError(w, r, http.StatusUnauthorized, "este móvil ya no está dado de alta")
			return
		}
	}
}

// deviceReport: positions from the app, and/or the answer to a find.
func (s *Server) deviceReport(w http.ResponseWriter, r *http.Request, dev *deviceRow) {
	if r.Method != http.MethodPost {
		sendError(w, r, http.StatusMethodNotAllowed, "use POST")
		return
	}
	var body struct {
		Positions []struct {
			Lat *float64 `json:"lat"`
			Lon *float64 `json:"lon"`
			Acc *float64 `json:"acc"`
			At  int64    `json:"at"`
		} `json:"positions"`
		Find string `json:"find"`
	}
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}
	if len(body.Positions) > deviceReportMax {
		body.Positions = body.Positions[len(body.Positions)-deviceReportMax:]
	}
	var ps []tripPosition
	for _, p := range body.Positions {
		if p.Lat == nil || p.Lon == nil {
			continue
		}
		ps = append(ps, tripPosition{Lat: *p.Lat, Lon: *p.Lon, Acc: accOrApp(p.Acc), At: stampOrNow(p.At), Source: "nayive"})
	}
	saved := s.recordPositions(dev.Owner, ps) // also keeps the newest as the last position
	if body.Find != "" && len(ps) > 0 {
		newest := ps[len(ps)-1]
		s.devices.FoundAt(dev.Owner, body.Find, s.roundedForFind(lastPos{
			Lat: newest.Lat, Lon: newest.Lon, Acc: newest.Acc, At: newest.At, Source: "nayive"}))
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"ok": true, "saved": saved})
}

// deviceAck: what the user did on the phone - declined a call, stopped the alarm.
func (s *Server) deviceAck(w http.ResponseWriter, r *http.Request, dev *deviceRow) {
	if r.Method != http.MethodPost {
		sendError(w, r, http.StatusMethodNotAllowed, "use POST")
		return
	}
	var body struct {
		Call string `json:"call"`
		Find string `json:"find"`
		Act  string `json:"act"`
	}
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}
	switch {
	case body.Call != "" && body.Act == "decline":
		if ring := s.devices.ringFor(dev.Owner); ring != nil && ring.ID == body.Call {
			s.chat.DeclineCall(ring.Owner, ring.ID, ring.Pid)
			s.devices.dropRing(dev.Owner, ring.ID)
		}
	case body.Find != "" && body.Act == "stop":
		s.devices.StopFind(dev.Owner, body.Find, "stopped")
	default:
		sendError(w, r, http.StatusBadRequest, "no sé qué hacer con eso")
		return
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"ok": true})
}

// assetLinks serves config/assetlinks.json at /.well-known/assetlinks.json:
// how Chrome knows the Android app may show this site full screen, with no
// address bar (a Trusted Web Activity). It holds the APK signing key's
// fingerprint, so it lives in config/, not in the repo. None there: 404, and
// the app still works - inside Chrome's own bar.
func (s *Server) assetLinks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		sendError(w, r, http.StatusMethodNotAllowed, "use GET")
		return
	}
	raw, err := os.ReadFile(filepath.Join(s.cfg.ConfigDir, "assetlinks.json"))
	if err != nil || !json.Valid(raw) {
		sendText(w, r, http.StatusNotFound, "Not found.\n")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	sendBytes(w, r, http.StatusOK, "application/json", raw)
}

// chatUnreadOf is the launcher's unread count for `user` (api_chat.go's own
// sum): the phone's badge.
func (s *Server) chatUnreadOf(user string) int {
	h := s.chat
	h.mu.Lock()
	defer h.mu.Unlock()
	o := h.owner(user)
	if o == nil {
		return 0
	}
	return s.chatUnread(chatActor{o: o, pid: "o"})
}
