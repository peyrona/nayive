package main

// =============================================================================
// User accounts and the API path sandbox.
// =============================================================================
//
//   - authentication (the admin account in config/server.json, regular users in
//     homes/<user>/data/config.json)
//   - the admin panel's user list
//   - ResolvePath: map an API path to a real file, refusing anything outside
//     the caller's allowed roots
//   - the per-user disk quota / usage numbers
//   - the per-user push subscriptions and the small per-account settings
//
// THIS IS THE SECURITY CORE. Two ideas to hold onto:
//
//  1. PASSWORDS ARE STORED IN PLAINTEXT in JSON files. That is a deliberate
//     (documented) choice for a three-person personal server, carried over from
//     the Python unchanged - hashing them here would lock every existing
//     account out. It remains the biggest single design smell in the project.
//
//  2. ResolvePath is the ONLY thing standing between "?file=../../etc/passwd"
//     and the filesystem. It works by splitting the path into segments,
//     rejecting "..", joining under a fixed root, resolving symlinks, and then
//     checking the result is still inside that root. Study it.

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Bounds every setting is clamped to. A hand-edited config.json can hold
// anything; these are what the server will actually honour.
const (
	TrashDaysMin = 1
	TrashDaysMax = 90 // hard ceiling: trash is auto-purged after at most 90 days

	TripDaysMin     = 0 // 0 = this user wants no "prepare for trip" reminders
	TripDaysMax     = 90
	TripDaysDefault = 3

	// Sane bounds for the per-user "longest side of a photo" setting. Below
	// ~200 px a photo stops being a photo; above 20000 nothing real is that big
	// and the browser canvas would fall over anyway.
	PhotoMaxMin = 200
	PhotoMaxMax = 20000

	PushWindowDefault = 30 // minutes before an event that the ping is sent
	PushWindowMin     = 1
	PushWindowMax     = 1440 // 24 h - a sane ceiling on "coming up"
	MaxPushSubs       = 12   // past this, the oldest device is dropped

	usageTTL = time.Hour // re-measure a home's size after an hour, just in case
)

// UILangs are the interface languages, and must match LANGS in
// apps/shared/i18n.js.
var UILangs = []string{"es", "en", "pt", "fr", "de", "it", "la"}

// UserConfig is homes/<user>/data/config.json.
//
// java: almost every field is a POINTER, because "absent" and "zero" mean
// different things throughout: no quota vs a quota of 0, never chose a language
// vs chose "no preference". Python gets this from None; Go needs nil.
type UserConfig struct {
	Password         string   `json:"password"`
	Quota            *float64 `json:"quota,omitempty"`
	PhotoMax         *int     `json:"photo_max,omitempty"`
	Lang             *string  `json:"lang,omitempty"`
	TZ               *string  `json:"tz,omitempty"`
	TrashDays        *int     `json:"trash_days,omitempty"`
	TripReminderDays *int     `json:"trip_reminder_days,omitempty"`

	// RawQuota and RawPhotoMax are the two numbers EXACTLY as the file spells
	// them.
	//
	// java: Go turns a float64 12 back into the token "12"; Python turns the
	// float 12.0 into "12.0". Both parse to the same number, but the admin
	// panel's user list echoes the stored value straight back, and two servers
	// answering "12" and "12.0" for the same account is the kind of difference
	// that costs an afternoon later. Keeping the raw token settles it.
	RawQuota    json.RawMessage `json:"-"`
	RawPhotoMax json.RawMessage `json:"-"`

	// raw is the whole file, key by key and IN ORDER, so a field this server
	// does not know about survives a rewrite - and so does the shape of the
	// file itself. See orderedjson.go.
	raw *orderedJSON `json:"-"`
}

// pyFloat is a float64 that marshals the way Python renders one.
//
// java: Go turns float64(12) into the token "12"; Python's json.dump turns the
// float 12.0 into "12.0". Both parse back to the same number, so nothing
// BREAKS - but config.json is a file a person opens, and two servers writing
// the same account differently is the kind of thing that costs an afternoon
// years later. A quota is always a float here, as it is in the Python, so it
// always carries its decimal point.
type pyFloat float64

func (f pyFloat) MarshalJSON() ([]byte, error) {
	// 'g' with -1 digits is the shortest form that round-trips - the same rule
	// Python's repr() follows, including the "2e-06" shape for small values.
	out := strconv.FormatFloat(float64(f), 'g', -1, 64)
	if !strings.ContainsAny(out, ".eEnN") { // no point, no exponent, not inf/NaN
		out += ".0"
	}
	return []byte(out), nil
}

// PushKeys is the crypto material one browser handed us.
type PushKeys struct {
	P256dh string `json:"p256dh"`
	Auth   string `json:"auth"`
}

// PushSub is ONE browser's notification subscription.
//
// SECURITY: an endpoint is a capability - anyone holding it can send that user
// notifications. Never log one, and never return one from the API.
type PushSub struct {
	Endpoint string   `json:"endpoint"`
	Keys     PushKeys `json:"keys"`
	Lang     string   `json:"lang"`
	Label    string   `json:"label"`
	Created  int64    `json:"created"`
}

// pushFile is the on-disk shape of push.json.
//
// java: WindowMinutes is RAW here, not an int, for one reason: a plain int
// cannot tell "the key is missing" from "the key says 0", and those mean
// different things. Missing is "nobody ever set it" -> the 30-minute default.
// Zero is a value the user typed, and it clamps UP to the one-minute floor.
// Reading it as an int made a stored 0 answer 30, which is a forty-times
// difference in when a person's phone rings.
type pushFile struct {
	WindowMinutes json.RawMessage `json:"window_minutes"`
	Subs          []PushSub       `json:"subs"`
}

// PushConfig is homes/<user>/data/push.json.
//
// "window_minutes" is a SIBLING of "subs", not a property of one: the user must
// be able to set "warn me 20 minutes before" on a device that currently has
// notifications switched off.
type PushConfig struct {
	WindowMinutes int       `json:"window_minutes"`
	Subs          []PushSub `json:"subs"`
}

// UserInfo is one row of the admin panel's user list.
type UserInfo struct {
	Name string `json:"name"`
	// java: json.RawMessage is a []byte that marshals VERBATIM - the bytes go
	// out exactly as they came in, and a nil one marshals as `null`, which is
	// what "no quota set" has always looked like to the panel.
	Quota       json.RawMessage `json:"quota"`
	PhotoMax    json.RawMessage `json:"photo_max"`
	Usage       int64           `json:"usage"`
	HasPassword bool            `json:"has_password"`
}

// Users owns everything about accounts. One instance per server.
type Users struct {
	cfg    *Config
	shares *Shares
	log    Logger

	// cfgMu serialises every read-modify-write of a
	// homes/<user>/data/config.json, so two concurrent changes (say a password
	// and a trash-days setting) cannot clobber each other or leave a
	// half-written file behind.
	cfgMu sync.Mutex

	// usageMu guards the disk-usage cache below.
	usageMu sync.Mutex
	usage   map[string]usageEntry
}

type usageEntry struct {
	bytes    int64
	measured time.Time
}

func NewUsers(cfg *Config, shares *Shares, log Logger) *Users {
	return &Users{cfg: cfg, shares: shares, log: log, usage: make(map[string]usageEntry)}
}

func (u *Users) homeDir(user string) string { return filepath.Join(u.cfg.HomesDir, user) }
func (u *Users) cfgPath(user string) string {
	return filepath.Join(u.homeDir(user), "data", "config.json")
}
func (u *Users) pushPath(user string) string {
	return filepath.Join(u.homeDir(user), "data", "push.json")
}

// -----------------------------------------------------------------------------
// reading and writing a user's config.json
// -----------------------------------------------------------------------------

// readUserConfig reads one account's settings. A missing, unreadable or
// malformed file - or valid JSON that is not an object - reads as "no
// settings", never as an error: a hand-edited config.json must not blow up a
// caller, and must not accidentally sign anyone in.
//
// java: EVERY FIELD IS DECODED ON ITS OWN, and a field that fails is simply
// left unset. That is not fussiness - it is the behaviour the Python has, and
// the difference bites. A single hand-typed `"quota": "abc"` makes
// json.Unmarshal into the whole struct fail on that field and leave a pointer
// to ZERO behind, which means "this user's quota is 0 bytes" and every upload
// they make answers 507. Python's per-field `try: float(q) except: None` reads
// it as "no quota set", which is the only sane reading. Decoding field by field
// is how you get that in Go.
func readUserConfig(path string) UserConfig {
	var out UserConfig

	raw, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	out.raw = newOrderedJSON()
	if err := json.Unmarshal(raw, out.raw); err != nil {
		return UserConfig{raw: newOrderedJSON()} // not an object, or not JSON at all
	}
	fields := out.raw.Fields()

	// The two numbers, kept EXACTLY as the file spells them as well as parsed.
	out.RawQuota = fields["quota"]
	out.RawPhotoMax = fields["photo_max"]

	readField(fields, "password", &out.Password)
	out.Quota = readNumber[float64](fields, "quota")
	out.PhotoMax = readNumber[int](fields, "photo_max")
	out.Lang = readOptional[string](fields, "lang")
	out.TZ = readOptional[string](fields, "tz")
	out.TrashDays = readNumber[int](fields, "trash_days")
	out.TripReminderDays = readNumber[int](fields, "trip_reminder_days")

	// If the two numbers did not parse, their raw form is not worth keeping
	// either: writing it back would preserve the very value we just refused.
	if out.Quota == nil {
		out.RawQuota = nil
	}
	if out.PhotoMax == nil {
		out.RawPhotoMax = nil
	}
	return out
}

// isJSONNull spots a literal `null`.
//
// java: json.Unmarshal happily decodes `null` into any type by leaving it at
// its ZERO VALUE and reporting no error, so without this test a
// `"quota": null` reads as a quota of 0 rather than as "no quota" - and 0 is
// the one value that locks the account out of writing anything at all.
func isJSONNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

// readField fills `dst` from one key, leaving it untouched when the key is
// absent or holds the wrong type.
func readField[T any](fields map[string]json.RawMessage, key string, dst *T) {
	raw, found := fields[key]
	if !found {
		return
	}
	var value T
	if json.Unmarshal(raw, &value) == nil {
		*dst = value
	}
}

// readOptional is readField for a field whose ABSENCE is meaningful - a nil
// result means "the account never chose", which is not the same as "".
//
// java: `[T any]` is a type parameter, Go's generics. This project uses them
// in exactly these two helpers and nowhere else: they save writing the same
// six-line function once per type, and anything more elaborate would be harder
// to read than the repetition it saves.
func readOptional[T any](fields map[string]json.RawMessage, key string) *T {
	raw, found := fields[key]
	if !found || isJSONNull(raw) {
		return nil
	}
	var value T
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return &value
}

// readNumber is readOptional for a number, and it also accepts the number
// written as a JSON STRING.
//
// java: Python's `int(v)` and `float(v)` parse "30" as happily as 30, and
// hand-edited config files in this project really do contain both. encoding/json
// refuses a string for a numeric field, so the string form is retried here.
func readNumber[T ~int | ~float64](fields map[string]json.RawMessage, key string) *T {
	raw, found := fields[key]
	if !found || isJSONNull(raw) {
		return nil
	}

	// java: EVERYTHING GOES THROUGH float64 FIRST, even when T is int. Go's
	// decoder refuses 25.7 for an int field; Python's int(25.7) is 25, and a
	// hand-edited file really does contain values like that. Converting a
	// float64 to an int truncates toward zero, which is exactly what int() does.
	var n float64
	if json.Unmarshal(raw, &n) != nil {
		// The number written as a JSON STRING - int("25") and float("2.5") both
		// work in Python, and config files here contain both spellings.
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return nil
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return nil
		}
		n = parsed
	}
	value := T(n)
	return &value
}

// writeUserConfig writes the settings back atomically, keeping every unknown
// field the file carried.
func writeUserConfig(path string, cfg UserConfig) error {
	fields := cfg.raw.Clone()
	put := func(key string, value any) error {
		fields.Put(key, value)
		return nil
	}
	if err := put("password", cfg.Password); err != nil {
		return err
	}
	// Only the fields that are actually set are written, so removing a quota
	// really removes the key rather than storing null.
	// The raw token is written back untouched whenever the value did not
	// change, so a rewrite of some OTHER field cannot silently turn a stored
	// 12.0 into a 12.
	if cfg.Quota != nil {
		if cfg.RawQuota != nil && sameNumber(cfg.RawQuota, *cfg.Quota) {
			fields.Set("quota", cfg.RawQuota)
		} else if err := put("quota", pyFloat(*cfg.Quota)); err != nil {
			return err
		}
	} else {
		fields.Remove("quota")
	}
	if cfg.PhotoMax != nil {
		if cfg.RawPhotoMax != nil && sameNumber(cfg.RawPhotoMax, float64(*cfg.PhotoMax)) {
			fields.Set("photo_max", cfg.RawPhotoMax)
		} else if err := put("photo_max", *cfg.PhotoMax); err != nil {
			return err
		}
	} else {
		fields.Remove("photo_max")
	}
	if cfg.Lang != nil {
		if err := put("lang", *cfg.Lang); err != nil {
			return err
		}
	}
	if cfg.TZ != nil {
		if err := put("tz", *cfg.TZ); err != nil {
			return err
		}
	}
	if cfg.TrashDays != nil {
		if err := put("trash_days", *cfg.TrashDays); err != nil {
			return err
		}
	}
	if cfg.TripReminderDays != nil {
		if err := put("trip_reminder_days", *cfg.TripReminderDays); err != nil {
			return err
		}
	}
	return atomicWriteJSON(path, fields, 4)
}

// updateUserConfig merges a change into the file and writes it back. Reports
// false when the account has no config.json. Caller holds cfgMu.
func updateUserConfig(path string, change func(*UserConfig)) bool {
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return false
	}
	cfg := readUserConfig(path)
	change(&cfg)
	return writeUserConfig(path, cfg) == nil
}

// -----------------------------------------------------------------------------
// account creation and renaming
// -----------------------------------------------------------------------------

// SaveAccountOptions is what the admin panel may change about an account.
//
// java: Python signals "leave this field alone" with a module-level sentinel
// object. Go signals it with nil: a nil pointer here is "not supplied", and a
// pointer to the zero value is "remove it".
type SaveAccountOptions struct {
	Password string // "" keeps the current one

	// Quota and PhotoMax arrive as RAW JSON, because the three cases the panel
	// can send are not three values of one type:
	//
	//	absent                  leave the field exactly as it is
	//	null, 0, "0" or ""      remove it
	//	a number, or a number
	//	  written as a string   set it
	//	anything else           reject the whole request
	//
	// Collapsing "abc" into "remove" would silently wipe a quota because
	// somebody mistyped it, which is why the Python answers 400 there and so
	// does this.
	Quota    json.RawMessage
	SetQuota bool
	PhotoMax json.RawMessage
	SetPhoto bool

	MustExist *bool // true = "update" (fail if missing); false = "create" (fail if present)
}

// numberOrRemove classifies one raw JSON value the way save_user_account does.
func numberOrRemove[T ~int | ~float64](raw json.RawMessage) (value *T, remove bool, bad bool) {
	trimmed := strings.TrimSpace(string(raw))
	switch trimmed {
	case "", "null", `""`, "0", `"0"`, "0.0":
		return nil, true, false
	}
	if n := readNumber[T](map[string]json.RawMessage{"v": raw}, "v"); n != nil {
		if float64(*n) == 0 {
			return nil, true, false // 0.0, 0e0 and friends
		}
		return n, false, false
	}
	return nil, false, true
}

// SaveAccount creates or updates homes/<name>/data/config.json under cfgMu, so
// it never races the user's own password write.
//
// It returns a status string the API maps to an HTTP response: "created",
// "updated", "exists", "missing", "bad-quota" or "bad-photo-max".
func (u *Users) SaveAccount(name string, opts SaveAccountOptions) string {
	home := u.homeDir(name)
	path := u.cfgPath(name)

	u.cfgMu.Lock()
	defer u.cfgMu.Unlock()

	info, err := os.Stat(path)
	existed := err == nil && !info.IsDir()
	if opts.MustExist != nil {
		if *opts.MustExist && !existed {
			return "missing"
		}
		if !*opts.MustExist && existed {
			return "exists"
		}
	}

	var cfg UserConfig
	if existed {
		cfg = readUserConfig(path)
	}

	if opts.Password != "" {
		cfg.Password = opts.Password
	}
	// No password given = keep the current one. An account may also have none
	// at all: the person signs in with a blank password and the launcher then
	// forces them to pick one (see Authenticate / NeedsPassword). The field
	// stays present and empty in the file.

	if opts.SetQuota {
		value, remove, bad := numberOrRemove[float64](opts.Quota)
		switch {
		case bad:
			return "bad-quota"
		case remove:
			cfg.Quota, cfg.RawQuota = nil, nil
		default:
			if math.IsNaN(*value) || math.IsInf(*value, 0) {
				return "bad-quota"
			}
			cfg.Quota, cfg.RawQuota = value, nil // re-rendered, not echoed
		}
	}
	if opts.SetPhoto {
		value, remove, bad := numberOrRemove[int](opts.PhotoMax)
		switch {
		case bad:
			return "bad-photo-max"
		case remove:
			cfg.PhotoMax, cfg.RawPhotoMax = nil, nil
		default:
			if *value < PhotoMaxMin || *value > PhotoMaxMax {
				return "bad-photo-max"
			}
			cfg.PhotoMax, cfg.RawPhotoMax = value, nil
		}
	}

	os.MkdirAll(filepath.Join(home, "data"), 0o755)
	os.MkdirAll(filepath.Join(home, "files"), 0o755)
	if err := writeUserConfig(path, cfg); err != nil {
		u.log.Error("cannot save account", "user", name, "err", err)
	}

	if existed {
		return "updated"
	}
	return "created"
}

// RenameAccount renames homes/<old> to homes/<new>.
//
// Everything the account owns - settings, files, photos, calendar, its own
// trash - lives inside that one folder, so moving the folder IS the rename;
// there is no other place a user name is written down.
//
// Returns "renamed", "missing", "exists" or "rename-failed". Renaming to the
// same name is a no-op and reports "renamed". The caller checks `new` with
// ValidUsername first, and drops the user's sessions afterwards: a live session
// still points at the old folder.
func (u *Users) RenameAccount(old, name string) string {
	if old == name {
		return "renamed"
	}
	src, dst := u.homeDir(old), u.homeDir(name)

	// The same lock SaveAccount takes, so a rename can never cut in between
	// that helper's "read config.json" and its "write it back".
	u.cfgMu.Lock()
	defer u.cfgMu.Unlock()

	if info, err := os.Stat(u.cfgPath(old)); err != nil || info.IsDir() {
		return "missing"
	}
	// java: Lstat, not Stat: Stat FOLLOWS symlinks and reports "does not exist"
	// for a broken one - yet that dangling link would still occupy the name and
	// make the rename fail.
	if _, err := os.Lstat(dst); err == nil {
		return "exists"
	}
	if err := os.Rename(src, dst); err != nil {
		return "rename-failed"
	}
	return "renamed"
}

// NormaliseUsername is what every entry point runs a typed name through before
// anything else looks at it.
//
// THE PROBLEM IT SOLVES. "José" can be written two ways that look exactly the
// same: with a precomposed "é" (one character), or with an "e" followed by a
// separate combining acute. A browser sends the first; a name pasted from a Mac
// file listing, or from some older systems, can be the second. Left alone they
// are two different byte strings, so they would be two different home folders
// that nobody could tell apart - and a person who created their account one way
// and typed it the other could not sign in.
//
// Python solves it by REFUSING anything that is not already in NFC form, which
// works but shows the person "invalid name, try again" for a name that is
// perfectly good. This port converts instead. Nothing is refused for the way it
// happened to be typed, and after the conversion two spellings of the same name
// really are the same string - which is the property that matters.
//
// java: golang.org/x/text is a Go-team module living outside the standard
// library, and it is the ONLY dependency this server has. It is vendored into
// the repo (see vendor/), so `go build` still needs no network and nothing
// installed - which was the point of the port. See docs/go-port.md.
func NormaliseUsername(name string) string {
	return norm.NFC.String(strings.TrimSpace(name))
}

// ValidUsername is the rule for a safe home-folder name, used on account
// creation AND on login, so the two can never disagree.
//
// Allowed: a letter or digit of ANY language, plus . _ - ; 1-64 characters;
// never "." / ".." / a leading dot. Rejected: control characters, whitespace,
// zero-width and bidi-override marks.
//
// It expects a name that has ALREADY been through NormaliseUsername - the
// combining-mark test below would otherwise reject a perfectly ordinary "José"
// for the way it was typed. Callers that take a name from the outside world
// normalise first; there is no path into this function that does not.
func ValidUsername(name string) bool {
	if name == "" || len(name) > 64 || name == "." || name == ".." {
		return false
	}
	if strings.HasPrefix(name, ".") {
		return false
	}
	for _, c := range name {
		// A combining mark that SURVIVED normalisation - a Devanagari virama,
		// say - is not part of a precomposed letter and is refused, exactly as
		// Python's str.isalnum() refuses it. What normalisation has already
		// removed by this point is the accent that had a precomposed form, and
		// that is the case this rule used to catch by accident.
		if unicode.Is(unicode.Mn, c) || unicode.Is(unicode.Me, c) {
			return false
		}
		if c == '.' || c == '_' || c == '-' {
			continue
		}
		// isalnum() in Python is Unicode-aware: any script's letters count.
		// isprintable() is False for control / format / separator characters,
		// which is what actually needs blocking.
		if !unicode.IsPrint(c) {
			return false
		}
		if !unicode.IsLetter(c) && !unicode.IsDigit(c) && !unicode.IsNumber(c) {
			return false
		}
	}
	return true
}

// ListUsers is every regular user: those with a homes/<name>/data/config.json.
//
// It calls DirSize on every home, which walks tens of GB of photos. Anything
// that only wants names must use ListUserNames instead.
func (u *Users) ListUsers() []UserInfo {
	out := []UserInfo{}
	for _, name := range u.ListUserNames() {
		cfg := readUserConfig(u.cfgPath(name))
		out = append(out, UserInfo{
			Name:        name,
			Quota:       cfg.RawQuota,
			PhotoMax:    cfg.RawPhotoMax,
			Usage:       DirSize(u.homeDir(name)), // .trash included: it is real disk
			HasPassword: cfg.Password != "",
		})
	}
	return out
}

// ListUserNames is just the names of the regular users - no quota, no usage, no
// password, and no walk of anyone's disk.
func (u *Users) ListUserNames() []string {
	entries, err := os.ReadDir(u.cfg.HomesDir)
	if err != nil {
		return []string{}
	}
	out := []string{}
	for _, e := range entries {
		if !e.IsDir() {
			continue // a symlink is reported as a link, not a dir: skipped
		}
		if info, err := os.Stat(filepath.Join(u.cfg.HomesDir, e.Name(), "data", "config.json")); err != nil || info.IsDir() {
			continue
		}
		out = append(out, e.Name())
	}
	sort.SliceStable(out, func(i, j int) bool {
		return strings.ToLower(out[i]) < strings.ToLower(out[j])
	})
	return out
}

// -----------------------------------------------------------------------------
// authentication
// -----------------------------------------------------------------------------

// sameSecret is a constant-time compare.
//
// java: a normal `a == b` on strings returns as soon as two characters differ,
// leaking the length of the matching prefix through timing. ConstantTimeCompare
// always scans the whole input. Java spells it MessageDigest.isEqual. Use it
// for anything an attacker could probe: passwords, HMACs, tokens.
func sameSecret(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// Authenticate returns "admin" or "user" for good credentials, else "".
func (u *Users) Authenticate(user, password string) string {
	if user == "" {
		return ""
	}

	var adminName, adminPassword string
	u.cfg.Read(func(s *ServerConfig) {
		if s.Admin != nil {
			adminName, adminPassword = s.Admin.Name, s.Admin.Password
		}
	})
	if adminPassword != "" && user == adminName && sameSecret(password, adminPassword) {
		return "admin"
	}

	// A regular user: homes/<user>/data/config.json must exist with a matching
	// password. The SAME name rule as account creation - which is also what
	// keeps the name from escaping homes/ (no "/", "\" or ".." can pass it).
	if !ValidUsername(user) {
		return ""
	}
	path := u.cfgPath(user)
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return ""
	}
	stored := readUserConfig(path).Password
	if stored != "" {
		if sameSecret(password, stored) {
			return "user"
		}
		return ""
	}

	// A password-less account (freshly created by the admin): a blank password
	// signs the person in. The launcher then makes them set a real one before
	// they can do anything - see NeedsPassword.
	if password == "" {
		return "user"
	}
	return ""
}

// NeedsPassword reports a regular account that exists but still has no password
// set - the launcher uses this to force the "pick a password" dialog on first
// sign-in.
func (u *Users) NeedsPassword(role, user string) bool {
	if role != "user" {
		return false
	}
	path := u.cfgPath(user)
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return false
	}
	return readUserConfig(path).Password == ""
}

// SetPassword changes the password of the signed-in account (the admin's goes
// in config/server.json, a regular user's in their own config.json).
func (u *Users) SetPassword(role, user, newPassword string) bool {
	if newPassword == "" {
		return false
	}
	if role == "admin" {
		err := u.cfg.Update(func(s *ServerConfig) {
			name := user
			if s.Admin != nil && s.Admin.Name != "" {
				name = s.Admin.Name
			}
			// Rebuild the whole admin block from scratch - anything else that
			// was in it (there should not be) is dropped.
			s.Admin = &AdminAccount{Name: name, Password: newPassword}
		})
		return err == nil
	}

	u.cfgMu.Lock()
	defer u.cfgMu.Unlock()
	return updateUserConfig(u.cfgPath(user), func(c *UserConfig) { c.Password = newPassword })
}

// -----------------------------------------------------------------------------
// Interface language (the ACCOUNT's, not the device's)
// -----------------------------------------------------------------------------
//
// The launcher's "Mi cuenta" dialog stores the chosen language here so it
// follows the PERSON from phone to PC, instead of living only in that browser's
// localStorage. The device still decides while nobody is signed in: the sign-in
// screen is translated too, and there is no account to ask yet.
//
// Three states, and the difference between the first two matters:
//
//	nil    the account never said anything - true of every account that existed
//	       before this setting did. Each device keeps whatever it had, so the
//	       upgrade changes nothing for anybody.
//	""     the user picked "por defecto" ON PURPOSE: no account language, every
//	       device follows its own browser. It syncs down like any other choice.
//	"es"   a real choice; every device signed into this account adopts it.
//
// The admin's own language goes in config/server.json under "admin_lang", at the
// TOP level - NOT inside the "admin" block, which SetPassword rebuilds from
// scratch (anything parked in there is lost on the next password change).

// UserLang is this account's interface language: a code from UILangs, "" for an
// explicit "no preference", or nil when the account never chose one. An
// unreadable or hand-edited value reads as nil - never as a choice.
func (u *Users) UserLang(role, user string) *string {
	var raw *string
	if role == "admin" {
		u.cfg.Read(func(s *ServerConfig) { raw = s.AdminLang })
	} else {
		raw = readUserConfig(u.cfgPath(user)).Lang
	}
	if raw == nil {
		return nil
	}
	v := strings.ToLower(strings.TrimSpace(*raw))
	if v == "" {
		return &v // "por defecto", chosen on purpose
	}
	if !contains(UILangs, v) {
		return nil
	}
	return &v
}

// SetUserLang stores this account's interface language. `code` is a UILangs
// code, or "" for "no preference". Returns the stored string and whether it was
// accepted - a language we do not translate is refused rather than silently
// ignored, so the browser can tell a saved choice from a lost one.
func (u *Users) SetUserLang(role, user, code string) (string, bool) {
	code = strings.ToLower(strings.TrimSpace(code))
	if code != "" && !contains(UILangs, code) {
		return "", false
	}
	if role == "admin" {
		if err := u.cfg.Update(func(s *ServerConfig) { s.AdminLang = &code }); err != nil {
			return "", false
		}
		return code, true
	}
	u.cfgMu.Lock()
	defer u.cfgMu.Unlock()
	ok := updateUserConfig(u.cfgPath(user), func(c *UserConfig) { c.Lang = &code })
	return code, ok
}

// -----------------------------------------------------------------------------
// Timezone (which wall clock this person's times mean)
// -----------------------------------------------------------------------------
//
// A timezone belongs to the PERSON, not to the box, so it is stored exactly
// like the language. There is no server-wide default: an account that never
// picked one reads as nil and every caller falls back to the server's own local
// time. Read by ics.go (what a floating "10:00" means) and by reminders.go (the
// clock printed in the push message).

// UserTZ is this account's IANA timezone name ("Europe/Madrid"), or nil when
// the account never chose one.
func (u *Users) UserTZ(role, user string) *string {
	var raw *string
	if role == "admin" {
		u.cfg.Read(func(s *ServerConfig) { raw = s.AdminTZ })
	} else {
		raw = readUserConfig(u.cfgPath(user)).TZ
	}
	if raw == nil {
		return nil
	}
	v := strings.TrimSpace(*raw)
	if v == "" {
		return nil
	}
	return &v
}

// SetUserTZ stores this account's timezone. `name` is an IANA zone name, or ""
// to clear the choice.
//
// Refusing an unknown name matters: the browser must be able to tell a saved
// choice from a lost one, or the picker would show a zone the reminder thread
// silently ignores.
func (u *Users) SetUserTZ(role, user, name string) (string, bool) {
	name = strings.TrimSpace(name)
	if name != "" {
		// java: LoadLocation errors on a zone this box does not know, which is
		// exactly Python's `name not in available_timezones()` check. The
		// binary embeds the IANA database (see the tzdata import in main.go),
		// so this answers the same on a VPS with no tzdata package installed.
		if _, err := time.LoadLocation(name); err != nil {
			return "", false
		}
	}
	if role == "admin" {
		if err := u.cfg.Update(func(s *ServerConfig) { s.AdminTZ = &name }); err != nil {
			return "", false
		}
		return name, true
	}
	u.cfgMu.Lock()
	defer u.cfgMu.Unlock()
	ok := updateUserConfig(u.cfgPath(user), func(c *UserConfig) { c.TZ = &name })
	return name, ok
}

// Location is the tzinfo for an IANA zone name, or nil ("use the server's own
// local time"). THE single source of truth for "which wall clock do we use".
func Location(name *string) *time.Location {
	if name == nil || strings.TrimSpace(*name) == "" {
		return nil
	}
	loc, err := time.LoadLocation(strings.TrimSpace(*name))
	if err != nil {
		return nil
	}
	return loc
}

// -----------------------------------------------------------------------------
// the day-count settings: trash retention and trip lead time
// -----------------------------------------------------------------------------

// UserTrashDays is how many days this user keeps items in their trash before
// the daily sweep purges them. nil means "not set" - the caller falls back to
// the server-wide default. A negative value disables the sweep for this user.
func (u *Users) UserTrashDays(user string) *int {
	v := readUserConfig(u.cfgPath(user)).TrashDays
	if v == nil {
		return nil
	}
	if *v < 0 {
		return v
	}
	clamped := clampInt(*v, TrashDaysMin, TrashDaysMax) // a hand-edited 0 can't nuke the can
	return &clamped
}

// UserTripReminderDays is how many days before a trip's start date this user is
// reminded of it - by a push AND by a "Preparar viaje a ..." task the Tasks app
// adds (same lead time, same trip id). Falls back to the server-wide default.
// 0 means "off".
func (u *Users) UserTripReminderDays(user string) int {
	v := readUserConfig(u.cfgPath(user)).TripReminderDays
	if v == nil {
		var d *int
		u.cfg.Read(func(s *ServerConfig) { d = s.TripReminderDays })
		if d == nil {
			return TripDaysDefault
		}
		v = d
	}
	return clampInt(*v, TripDaysMin, TripDaysMax)
}

// SetDaysSetting is the shared body of the two settings above: clamp `value` to
// [lo, hi] and store it - in config/server.json (the server-wide default) when
// the caller is the admin, else in the user's own config.json.
//
// java: `apply` is a function value picking which field to write. Java would
// need an interface or a lambda; here it is a two-line closure at each call site.
func (u *Users) SetDaysSetting(role, user, value string, lo, hi int,
	applyServer func(*ServerConfig, int), applyUser func(*UserConfig, int)) (int, bool) {

	days, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return 0, false
	}
	days = clampInt(days, lo, hi)

	if role == "admin" {
		if err := u.cfg.Update(func(s *ServerConfig) { applyServer(s, days) }); err != nil {
			return 0, false
		}
		return days, true
	}
	u.cfgMu.Lock()
	defer u.cfgMu.Unlock()
	ok := updateUserConfig(u.cfgPath(user), func(c *UserConfig) { applyUser(c, days) })
	return days, ok
}

// SetUserTrashDays sets the trash retention period for the signed-in account.
func (u *Users) SetUserTrashDays(role, user, value string) (int, bool) {
	return u.SetDaysSetting(role, user, value, TrashDaysMin, TrashDaysMax,
		func(s *ServerConfig, d int) { s.TrashDays = &d },
		func(c *UserConfig, d int) { c.TrashDays = &d })
}

// SetUserTripReminderDays sets the trip-reminder lead time for the signed-in
// account.
func (u *Users) SetUserTripReminderDays(role, user, value string) (int, bool) {
	return u.SetDaysSetting(role, user, value, TripDaysMin, TripDaysMax,
		func(s *ServerConfig, d int) { s.TripReminderDays = &d },
		func(c *UserConfig, d int) { c.TripReminderDays = &d })
}

// sameNumber reports whether a raw JSON token holds exactly this value, so the
// token can be written back instead of a re-rendered one.
func sameNumber(raw json.RawMessage, value float64) bool {
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil {
		return false
	}
	return n == value
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// -----------------------------------------------------------------------------
// per-user push subscriptions
// -----------------------------------------------------------------------------

// cleanSub normalises one stored subscription, or reports it unusable.
//
// Tolerant on read: a hand-edited or half-written entry is dropped, never
// raised, so one bad line cannot stop the reminder loop for everyone.
func cleanSub(raw PushSub) (PushSub, bool) {
	endpoint := strings.TrimSpace(raw.Endpoint)
	if !strings.HasPrefix(endpoint, "https://") || len(endpoint) > 1024 {
		return PushSub{}, false
	}
	p256dh := strings.TrimSpace(raw.Keys.P256dh)
	auth := strings.TrimSpace(raw.Keys.Auth)
	if p256dh == "" || auth == "" {
		return PushSub{}, false
	}
	lang := strings.ToLower(strings.TrimSpace(raw.Lang))
	if !contains(UILangs, lang) {
		lang = "es"
	}
	label := raw.Label
	if len(label) > 40 {
		label = label[:40]
	}
	created := raw.Created
	if created < 0 {
		created = 0
	}
	return PushSub{
		Endpoint: endpoint,
		Keys:     PushKeys{P256dh: p256dh, Auth: auth},
		Lang:     lang,
		Label:    label,
		Created:  created,
	}, true
}

// UserPush is this user's notification settings. Always well-formed: a missing
// file, a malformed one, or entries that fail cleanSub all read as "no
// devices", never as an error.
func (u *Users) UserPush(user string) PushConfig {
	var stored pushFile
	loadJSONFile(u.pushPath(user), &stored)

	out := PushConfig{
		WindowMinutes: ClampWindow(stored.WindowMinutes),
		Subs:          []PushSub{},
	}
	for _, s := range stored.Subs {
		if clean, ok := cleanSub(s); ok {
			out.Subs = append(out.Subs, clean)
		}
	}
	return out
}

// ClampWindow turns one raw JSON value into a usable "minutes before an event".
//
// Absent, null, or something that is not a number at all -> the default. A real
// number -> clamped into [1, 1440], so a typed 0 becomes one minute rather than
// silently becoming half an hour.
func ClampWindow(raw json.RawMessage) int {
	n := readNumber[int](map[string]json.RawMessage{"v": raw}, "v")
	if n == nil {
		return PushWindowDefault
	}
	return clampInt(*n, PushWindowMin, PushWindowMax)
}

// SetPushWindow sets "how many minutes before an event", leaving the devices
// alone. Returns the stored int, or false when the user has no home directory.
func (u *Users) SetPushWindow(user string, minutes json.RawMessage) (int, bool) {
	path := u.pushPath(user)
	u.cfgMu.Lock()
	defer u.cfgMu.Unlock()
	if info, err := os.Stat(filepath.Dir(path)); err != nil || !info.IsDir() {
		return 0, false
	}
	data := u.UserPush(user)
	data.WindowMinutes = ClampWindow(minutes)
	if err := atomicWriteJSON(path, data, 4); err != nil {
		return 0, false
	}
	return data.WindowMinutes, true
}

// AddPushSub registers (or refreshes) ONE device.
//
// Returns "added", "updated", "invalid" or "no-home".
//
// Dedup is by endpoint and ONLY by endpoint - one browser profile has exactly
// one, and re-subscribing the same profile (permission re-granted, a
// pushsubscriptionchange, a fresh login) must REPLACE in place, not append.
func (u *Users) AddPushSub(user, endpoint, p256dh, auth, lang, label string, window json.RawMessage) string {
	fresh, ok := cleanSub(PushSub{
		Endpoint: endpoint,
		Keys:     PushKeys{P256dh: p256dh, Auth: auth},
		Lang:     lang,
		Label:    label,
		Created:  time.Now().Unix(),
	})
	if !ok {
		return "invalid"
	}
	// The keys must be real crypto material, not just non-empty strings: a bad
	// one would otherwise sit there and fail on every tick, forever.
	if err := ValidateKeys(fresh.Keys.P256dh, fresh.Keys.Auth); err != nil {
		return "invalid"
	}

	path := u.pushPath(user)
	u.cfgMu.Lock()
	defer u.cfgMu.Unlock()
	if info, err := os.Stat(filepath.Dir(path)); err != nil || !info.IsDir() {
		return "no-home"
	}

	data := u.UserPush(user)
	hit := -1
	for i, s := range data.Subs {
		if s.Endpoint == fresh.Endpoint {
			hit = i
			break
		}
	}

	result := "added"
	if hit < 0 {
		if len(data.Subs) >= MaxPushSubs {
			// Drop the oldest device.
			sort.SliceStable(data.Subs, func(i, j int) bool {
				return data.Subs[i].Created < data.Subs[j].Created
			})
			data.Subs = data.Subs[1:]
		}
		data.Subs = append(data.Subs, fresh)
	} else {
		if data.Subs[hit].Created != 0 {
			fresh.Created = data.Subs[hit].Created
		}
		data.Subs[hit] = fresh
		result = "updated"
	}

	if window != nil {
		data.WindowMinutes = ClampWindow(window)
	}
	if err := atomicWriteJSON(path, data, 4); err != nil {
		u.log.Error("cannot save push.json", "user", user, "err", err)
	}
	return result
}

// RemovePushSub forgets one device. True when something was actually removed.
//
// Called both by the user turning notifications off and by the reminder loop
// when a push service answers 404/410 ("this subscription no longer exists").
//
// The filter is on the endpoint VALUE, never on a list index: the reminder loop
// decides "entry 2 is dead" from a snapshot it read seconds earlier, and by now
// an HTTP request may have rewritten the list so entry 2 is a different device.
func (u *Users) RemovePushSub(user, endpoint string) bool {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return false
	}
	path := u.pushPath(user)

	u.cfgMu.Lock()
	defer u.cfgMu.Unlock()
	if info, err := os.Stat(filepath.Dir(path)); err != nil || !info.IsDir() {
		return false
	}
	data := u.UserPush(user)
	kept := make([]PushSub, 0, len(data.Subs))
	for _, s := range data.Subs {
		if s.Endpoint != endpoint {
			kept = append(kept, s)
		}
	}
	if len(kept) == len(data.Subs) {
		return false
	}
	data.Subs = kept
	return atomicWriteJSON(path, data, 4) == nil
}

// HasPushSub answers "is THIS browser already registered?" for the Mi cuenta
// sheet.
func (u *Users) HasPushSub(user, endpoint string) bool {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return false
	}
	for _, s := range u.UserPush(user).Subs {
		if s.Endpoint == endpoint {
			return true
		}
	}
	return false
}

// -----------------------------------------------------------------------------
// THE SANDBOX
// -----------------------------------------------------------------------------

// IsSharedPath reports an API path that is something ANOTHER user lent us -
// anything under "shared/". Asked on the four operations an "add" grant must
// still refuse: overwrite, delete, rename/move and re-share.
func IsSharedPath(reqPath string) bool {
	parts := splitPath(unquotePath(reqPath))
	return len(parts) > 0 && parts[0] == "shared"
}

// Resolve maps an API path to where it lives on disk, and says whether
// the caller may WRITE it.
//
// Accepted: "data/<x>", "files/<x>", "apps/<x>", "shared/<slug>/..." - or, for
// the admin, anything under the base directory.
//
// Returns ("", false) when the path is not allowed. Comparison is done on path
// SEGMENTS, never string prefixes, so a name like "EE.UU..txt" is not mistaken
// for a traversal attempt.
//
// The answer also carries the ROOT the containment check was made against, so
// every operation on the path can go through os.Root - see sandbox.go.
func (u *Users) Resolve(role, user, reqPath string) (Resolved, bool) {
	parts := splitPath(unquotePath(reqPath))
	if hasDotDot(parts) {
		return Resolved{}, false
	}
	if hasSegment(parts, ".trash") {
		return Resolved{}, false // the trash can is only touched through trash.go
	}

	var root, target string
	writable := false

	if role == "admin" {
		root = u.cfg.BaseDir
		target = filepath.Join(append([]string{u.cfg.BaseDir}, parts...)...)
		writable = true
	} else {
		if len(parts) == 0 {
			return Resolved{}, false
		}
		switch top := parts[0]; {
		case top == "data" || top == "files":
			home, err := resolveExisting(u.homeDir(user))
			if err != nil {
				return Resolved{}, false
			}
			root = home
			target = filepath.Join(append([]string{home}, parts...)...)
			writable = true

		case top == "apps":
			root = u.cfg.AppsDir
			target = filepath.Join(append([]string{u.cfg.BaseDir}, parts...)...)
			writable = false

		case top == "shared":
			// Something ANOTHER user shared with us. The path is rooted at
			// THEIR folder, and is never writable: that one flag is what makes
			// every existing write guard (PUT, mkdir, rename, delete) refuse a
			// shared path with no extra code.
			if len(parts) < 2 {
				// "shared" alone is a virtual folder, listed by the API, not a
				// real directory.
				return Resolved{}, false
			}
			grant := u.shares.Find(user, parts[1])
			base := u.shares.RootPath(grant)
			if base == "" {
				return Resolved{}, false // no such grant, or it moved away
			}
			if len(parts) > 2 && parts[2] == ExtraSeg {
				// "shared/<slug>/~/<the owner's own path>" - a shared TRIP also
				// lends what it POINTS at outside its own folder: its linked
				// documents and its photo folder. The whitelist is read out of
				// the trip's own trip.json on every request, so a document the
				// owner adds later is lent as well, and one they take out stops
				// being lent.
				extra := u.shares.ExtraPath(grant, parts[3:])
				if extra == "" {
					return Resolved{}, false
				}
				// These files live outside the trip folder, so the containment
				// check at the end has to be against the OWNER's home instead -
				// which is exactly the boundary that matters.
				home, err := resolveExisting(u.homeDir(grant.Owner))
				if err != nil {
					return Resolved{}, false
				}
				root, target, writable = home, extra, false // extras are only ever lent
			} else {
				// parts[2:] is the path INSIDE the shared item; for a shared
				// single file that slice is empty and target == root, which the
				// containment check below allows.
				root = base
				target = filepath.Join(append([]string{base}, parts[2:]...)...)
				// An "add" grant lets the recipient PUT a NEW file into the
				// folder - their own photos into the album someone hosts.
				// writable=true alone would also open overwrite, delete, rename
				// and re-share, so the file API closes those four itself by
				// asking IsSharedPath.
				writable = CanAdd(grant)
			}

		default:
			return Resolved{}, false
		}
	}

	// THE crucial step: collapse any leftover ".." and follow every symlink to
	// a real location, then check we are still inside the root. A symlink
	// escape gets caught here because the target has already been moved to
	// wherever the link actually points.
	resolvedRoot, err := resolveExisting(root)
	if err != nil {
		return Resolved{}, false
	}
	resolvedTarget, err := resolveExisting(target)
	if err != nil {
		return Resolved{}, false
	}
	if !isInside(resolvedRoot, resolvedTarget) {
		return Resolved{}, false
	}
	return newResolved(resolvedRoot, resolvedTarget, writable)
}

// ResolvePath is Resolve for the callers that need only the absolute path: the
// share API's "is this mine?" check, the folder listings, and the tests.
func (u *Users) ResolvePath(role, user, reqPath string) (string, bool) {
	p, ok := u.Resolve(role, user, reqPath)
	if !ok {
		return "", false
	}
	return p.Abs, p.Writable
}

// -----------------------------------------------------------------------------
// quota and the cached disk usage
// -----------------------------------------------------------------------------

// UserPhotoMax is the longest side (in pixels) a photo of this user may keep.
// nil = no limit, upload the original.
func (u *Users) UserPhotoMax(user string) *int {
	px := readUserConfig(u.cfgPath(user)).PhotoMax
	if px == nil || *px < PhotoMaxMin || *px > PhotoMaxMax {
		return nil
	}
	return px
}

// UserQuotaBytes is the user's disk quota in bytes ("quota" is a number of
// gigabytes). nil means "no quota set".
func (u *Users) UserQuotaBytes(user string) *int64 {
	q := readUserConfig(u.cfgPath(user)).Quota
	if q == nil {
		return nil
	}
	return ptrInt64(int64(*q * 1024 * 1024 * 1024))
}

// UserUsageBytes is the bytes the user's home takes that count against their
// quota - data/ + files/ AND .trash/. A trashed file still occupies the disk, so
// it still counts; space comes back only when the trash is emptied.
//
// CACHED. Measuring a home means walking every file under it, which with a
// photo library is tens of thousands of stat() calls, and it used to happen on
// EVERY upload of a user with a quota. Now the figure is measured at most once
// per usageTTL per user and kept current in between by AdjustUsage.
func (u *Users) UserUsageBytes(user string) int64 {
	u.usageMu.Lock()
	hit, found := u.usage[user]
	u.usageMu.Unlock()
	if found && time.Since(hit.measured) < usageTTL {
		return hit.bytes
	}

	total := DirSize(u.homeDir(user)) // the slow walk (.trash included)

	u.usageMu.Lock()
	u.usage[user] = usageEntry{bytes: total, measured: time.Now()}
	u.usageMu.Unlock()
	return total
}

// AdjustUsage adds `delta` bytes (may be negative) to the cached figure, if
// there is one. No figure yet means nothing to do: the next read measures.
func (u *Users) AdjustUsage(user string, delta int64) {
	u.usageMu.Lock()
	defer u.usageMu.Unlock()
	if hit, found := u.usage[user]; found {
		hit.bytes += delta
		if hit.bytes < 0 {
			hit.bytes = 0
		}
		u.usage[user] = hit
	}
}

// ForgetUsage drops the cached figure for `user` (or, with "", for everyone) so
// the next read measures afresh.
func (u *Users) ForgetUsage(user string) {
	u.usageMu.Lock()
	defer u.usageMu.Unlock()
	if user == "" {
		clear(u.usage)
		return
	}
	delete(u.usage, user)
}

// HomeOwner is the user whose home an absolute path lies in, or "".
func (u *Users) HomeOwner(absPath string) string {
	return homeOwner(u.cfg.HomesDir, absPath)
}
