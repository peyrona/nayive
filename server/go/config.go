package main

// =============================================================================
// Config - config/server.json, the paths derived from it, and the one atomic
// write every other file uses.
// =============================================================================
//
// The Python original (lib/config.py) is a module whose IMPORT has side effects:
// it opens the config file, configures logging, and publishes CONFIG, HERE,
// BASE_DIR... as module-level globals that everything else imports. That is how
// Python does a singleton.
//
// Here there are no globals. Config is a value, built once in main() and passed
// to whoever needs it. That is what lets the tests stand two servers up in one
// process, which is exactly what a parity run against the Python needs.
//
// java: Go has no static initializer block and no import side effects worth
// relying on. `func init()` exists; this project does not use it.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// URLPrefix is the public mount point of the static apps in the browser. The
// disk folder stays "apps" (Config.AppsDir); this is only the leading path
// segment in the URL, e.g. https://example.com/nayive/tasks/ . Requests to the
// old "/apps/..." prefix are 301-redirected here.
const URLPrefix = "/nayive"

// CookieName is the session cookie. It must match what the browser apps expect.
const CookieName = "nayive_session"

// Logger is the slice of *slog.Logger this program uses.
//
// java: declaring the interface at the point of use, rather than taking
// *slog.Logger everywhere, is what lets a test pass a silent logger without a
// mocking framework. In Go the CONSUMER declares the interface.
type Logger interface {
	Debug(msg string, args ...any)
	Info(msg string, args ...any)
	Warn(msg string, args ...any)
	Error(msg string, args ...any)
}

// AdminAccount is the "admin" block of config/server.json.
//
// The password is stored in PLAINTEXT. That is a deliberate, documented choice
// for a three-person personal server, carried over from the Python unchanged -
// changing it here would lock every existing account out.
type AdminAccount struct {
	Name     string `json:"name"`
	Password string `json:"password"`
}

// ExternalStorage is the admin panel's "where big files get offloaded to" block.
// UI + config only for now: nothing moves files onto the mounted volume yet.
type ExternalStorage struct {
	Mount     string   `json:"mount"`
	AlwaysExt []string `json:"always_ext"`
	NeverExt  []string `json:"never_ext"`
	MinMB     float64  `json:"min_mb"`
}

// ServerConfig is config/server.json.
//
// java: the pointer fields are the nullable ones. A plain `int` cannot tell
// "absent" from "0", and for TrashDays the difference matters (a negative value
// disables the sweep; absent means "use the default"). *int can be nil.
type ServerConfig struct {
	Host             string           `json:"host"`
	Port             int              `json:"port"`
	LogLevel         string           `json:"log_level"`
	BaseDir          string           `json:"base_dir"`
	TLS              TLSConfig        `json:"tls"`
	Admin            *AdminAccount    `json:"admin"`
	AdminLang        *string          `json:"admin_lang"`
	AdminTZ          *string          `json:"admin_tz"`
	TrashDays        *int             `json:"trash_days"`
	SessionHours     *int             `json:"session_hours"`
	RememberDays     *int             `json:"remember_days"`
	TripReminderDays *int             `json:"trip_reminder_days"`
	PushContact      string           `json:"push_contact"`
	ExternalStorage  *ExternalStorage `json:"external_storage"`
}

// TLSConfig is the "tls" block. Empty paths mean "serve plain HTTP".
type TLSConfig struct {
	CertFile string `json:"cert_file"`
	KeyFile  string `json:"key_file"`
}

// Config is the running server's settings: the file's contents plus everything
// derived from it, resolved once at startup.
type Config struct {
	// mu guards Server, which the admin panel rewrites at runtime.
	//
	// java: a struct holding a mutex must never be COPIED once in use, so every
	// method below takes a pointer receiver and Config is always passed as *Config.
	mu sync.Mutex

	Server ServerConfig

	// raw is the WHOLE file as it was read, key by key.
	//
	// java: config/server.json is rewritten by the admin panel, and a struct
	// can only write back the fields it knows about. This deployment's file
	// carries a "tz" that no version of the server reads any more - and the
	// first password change would have deleted it. Python rewrites the dict it
	// loaded, so nothing is ever lost; keeping the raw map is how you get that
	// in Go.
	raw *orderedJSON

	Path      string // config/server.json
	Here      string // the run-root: the directory holding server.json's parent
	BaseDir   string
	AppsDir   string
	HomesDir  string
	ConfigDir string

	LogLevel     slog.Level
	LogLevelName string
	SessionTTL   time.Duration
	RememberTTL  time.Duration
	TrashDays    int
}

// LoadConfig reads `path` (config/server.json) and derives every path from it.
//
// Unlike lib/config.py, a MISSING file is not fatal here: the defaults are
// enough to boot, and the admin panel then opens with no login so the first
// admin can be created. A malformed file IS fatal - a hand-edit that lost the
// admin block must not silently unlock the panel.
func LoadConfig(path string) (*Config, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	// server.json lives in <run-root>/config/, so two levels up is the run-root.
	configDir := filepath.Dir(abs)
	here := filepath.Dir(configDir)

	cfg := &Config{
		Path:      abs,
		Here:      here,
		ConfigDir: configDir,
		Server: ServerConfig{
			Host:     "0.0.0.0",
			Port:     4343,
			LogLevel: "error",
			BaseDir:  ".",
		},
	}

	cfg.raw = newOrderedJSON()

	raw, err := os.ReadFile(abs)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("read %s: %w", abs, err)
	}
	if err == nil {
		if err := json.Unmarshal(raw, cfg.raw); err != nil {
			return nil, fmt.Errorf("parse %s: %w", abs, err)
		}
		// Field by field, and a field that does not fit its type is left at its
		// default rather than failing the whole file. A hand-typed
		// `"port": "4343"` boots the Python fine; refusing to start over it
		// would be a regression, not a safety feature.
		readField(cfg.raw.Fields(), "host", &cfg.Server.Host)
		readField(cfg.raw.Fields(), "log_level", &cfg.Server.LogLevel)
		readField(cfg.raw.Fields(), "base_dir", &cfg.Server.BaseDir)
		readField(cfg.raw.Fields(), "push_contact", &cfg.Server.PushContact)
		readField(cfg.raw.Fields(), "tls", &cfg.Server.TLS)
		if port := readNumber[int](cfg.raw.Fields(), "port"); port != nil {
			cfg.Server.Port = *port
		}
		cfg.Server.Admin = readOptional[AdminAccount](cfg.raw.Fields(), "admin")
		cfg.Server.AdminLang = readOptional[string](cfg.raw.Fields(), "admin_lang")
		cfg.Server.AdminTZ = readOptional[string](cfg.raw.Fields(), "admin_tz")
		cfg.Server.ExternalStorage = readOptional[ExternalStorage](cfg.raw.Fields(), "external_storage")
		cfg.Server.TrashDays = readNumber[int](cfg.raw.Fields(), "trash_days")
		cfg.Server.SessionHours = readNumber[int](cfg.raw.Fields(), "session_hours")
		cfg.Server.RememberDays = readNumber[int](cfg.raw.Fields(), "remember_days")
		cfg.Server.TripReminderDays = readNumber[int](cfg.raw.Fields(), "trip_reminder_days")
	}

	base := cfg.Server.BaseDir
	if base == "" {
		base = "."
	}
	if !filepath.IsAbs(base) {
		base = filepath.Join(here, base)
	}
	cfg.BaseDir = filepath.Clean(base)
	cfg.AppsDir = filepath.Join(cfg.BaseDir, "apps")
	cfg.HomesDir = filepath.Join(cfg.BaseDir, "homes")

	cfg.LogLevelName = strings.ToLower(strings.TrimSpace(cfg.Server.LogLevel))
	cfg.LogLevel = parseLevel(cfg.LogLevelName)
	cfg.SessionTTL = time.Duration(intOr(cfg.Server.SessionHours, 12)) * time.Hour
	cfg.RememberTTL = time.Duration(intOr(cfg.Server.RememberDays, 30)) * 24 * time.Hour
	cfg.TrashDays = intOr(cfg.Server.TrashDays, 30)
	return cfg, nil
}

// Addr is the "host:port" net/http wants.
func (c *Config) Addr() string {
	return c.Server.Host + ":" + strconv.Itoa(c.Server.Port)
}

// AdminIsConfigured reports whether the admin account has both a name and a
// password. Until it does, the admin panel opens with NO login so the first
// admin can be created.
func (c *Config) AdminIsConfigured() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	a := c.Server.Admin
	return a != nil && a.Name != "" && a.Password != ""
}

// AdminName is the configured admin's name, or "".
func (c *Config) AdminName() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.Server.Admin == nil {
		return ""
	}
	return c.Server.Admin.Name
}

// Update mutates the config under its lock and writes it back to disk.
//
// java: taking a FUNCTION as the argument means the caller cannot forget to
// unlock or forget to save - the whole read-modify-write is one call. Python
// does this with `with CONFIG_LOCK:` at each of the six call sites.
func (c *Config) Update(change func(*ServerConfig)) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	change(&c.Server)

	merged := c.merged()
	if err := atomicWriteJSON(c.Path, merged, 4); err != nil {
		return err
	}
	// Keep the raw copy in step with what is now on disk. Without this, every
	// save would start again from the file as it was AT BOOT, and a key added
	// by one save would be re-appended in a different place by the next -
	// Python rewrites the dict it has been mutating all along, so a new key
	// lands once and stays put.
	c.raw = merged
	return nil
}

// merged is the file to write: every key that was there, with the ones this
// server manages brought up to date.
//
// java: a field that is a POINTER is written only when it is set, so clearing a
// setting really removes the key rather than storing null - which is what the
// Python's dict.pop does.
func (c *Config) merged() *orderedJSON {
	out := c.raw.Clone()
	put := out.Put
	s := &c.Server
	put("host", s.Host)
	put("port", s.Port)
	put("log_level", s.LogLevel)
	put("base_dir", s.BaseDir)
	put("tls", s.TLS)
	if s.Admin != nil {
		put("admin", s.Admin)
	}
	if s.AdminLang != nil {
		put("admin_lang", *s.AdminLang)
	}
	if s.AdminTZ != nil {
		put("admin_tz", *s.AdminTZ)
	}
	if s.ExternalStorage != nil {
		put("external_storage", s.ExternalStorage)
	}
	if s.PushContact != "" {
		put("push_contact", s.PushContact)
	}
	// A fixed order, so two runs of the same change produce the same file.
	for _, pair := range []struct {
		key   string
		value *int
	}{
		{"trash_days", s.TrashDays}, {"session_hours", s.SessionHours},
		{"remember_days", s.RememberDays}, {"trip_reminder_days", s.TripReminderDays},
	} {
		if pair.value != nil {
			put(pair.key, *pair.value)
		}
	}
	return out
}

// Read runs `look` under the lock and is the only safe way to read a field the
// admin panel can rewrite.
func (c *Config) Read(look func(*ServerConfig)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	look(&c.Server)
}

func parseLevel(name string) slog.Level {
	switch name {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warning", "warn":
		return slog.LevelWarn
	case "critical":
		return slog.LevelError
	default:
		return slog.LevelError
	}
}

// intOr is the "value, or this default when absent" read, the equivalent of
// Python's CONFIG.get(key, default).
func intOr(p *int, fallback int) int {
	if p == nil {
		return fallback
	}
	return *p
}

// -----------------------------------------------------------------------------
// The atomic write
// -----------------------------------------------------------------------------

// tmpCounter makes two writers racing on the SAME file use distinct temp names.
//
// java: Go has no thread id to put in the name the way Python does, and
// goroutine ids are deliberately not exposed. An atomic counter does the same
// job, and filetree's temp-file regex only cares that there are two numbers.
var tmpCounter atomic.Uint64

// atomicWriteJSON writes `obj` as pretty JSON to `path` via a uniquely-named
// temp file and an atomic rename. THE one copy of the pattern - used for
// config/server.json, every homes/<user>/data/*.json the server writes, and the
// trash index. The caller holds whatever lock guards `path`.
//
// THE ATOMIC-WRITE PATTERN: write the new content to a temp file in the same
// directory, then rename it onto the real name. Rename is atomic on every OS -
// a reader either sees the whole old file or the whole new file, never a
// half-written one, and a crash mid-write leaves only a stray .tmp (swept at
// startup, see sweepStaleTemp).
//
// The output matches lib/config.py byte for byte: four-space indent, real UTF-8
// rather than \uXXXX escapes, and a trailing newline.
func atomicWriteJSON(path string, obj any, indent int) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// java: SetEscapeHTML(false) turns off Go's default < for < > and &.
	// Python's json.dump does not escape them, and these files are read by
	// people as well as by both servers.
	enc.SetEscapeHTML(false)
	enc.SetIndent("", strings.Repeat(" ", indent))
	if err := enc.Encode(obj); err != nil {
		return err
	}
	// Encoder already ends with "\n", which is what Python writes too.

	dir := filepath.Dir(path)
	tmp := filepath.Join(dir, fmt.Sprintf("%s.%d.%d.tmp",
		filepath.Base(path), os.Getpid(), tmpCounter.Add(1)))

	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// loadJSONFile fills `dst` from the JSON object at `path`. A missing,
// unreadable or malformed file - or valid JSON that is not an object - leaves
// `dst` untouched and reports false, exactly like users.load_json_dict: a
// hand-edited config.json must read as "no settings", never blow up a caller.
func loadJSONFile(path string, dst any) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return false
	}
	return true
}

// itoa is Integer.toString, used where importing strconv for one call would be
// noise.
func itoa(n int) string { return strconv.Itoa(n) }
