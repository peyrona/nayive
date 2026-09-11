package main

// =============================================================================
// The sandbox tests.
// =============================================================================
//
// The parity harness proves the two servers ANSWER the same. These tests prove
// the one thing a black-box comparison cannot: that a symlink planted inside a
// user's home cannot be followed out of it. Both servers would have to be wrong
// in the same way for the harness to miss that, and this is the single function
// (ResolvePath) where being wrong loses the whole box.

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestUsers builds a Users over a throwaway run-root with one account.
//
// java: t.TempDir() is a directory the toolchain DELETES when the test ends,
// pass or fail. t.Helper() makes a failure in here blame the caller's line.
func newTestUsers(t *testing.T) (*Users, *Config, string) {
	t.Helper()

	root := t.TempDir()
	configDir := filepath.Join(root, "config")
	os.MkdirAll(configDir, 0o755)
	os.MkdirAll(filepath.Join(root, "apps", "shared"), 0o755)
	os.WriteFile(filepath.Join(root, "apps", "index.html"), []byte("<h1>hola</h1>"), 0o644)

	cfgPath := filepath.Join(configDir, "server.json")
	os.WriteFile(cfgPath, []byte(`{"host":"127.0.0.1","port":0,"base_dir":".",
		"admin":{"name":"jefe","password":"secreto"}}`), 0o644)

	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	shares := NewShares(cfg.ConfigDir, cfg.HomesDir, log)
	users := NewUsers(cfg, shares, log)

	home := filepath.Join(cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "data"), 0o755)
	os.MkdirAll(filepath.Join(home, "files"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "config.json"),
		[]byte(`{"password":"abc"}`), 0o644)
	os.WriteFile(filepath.Join(home, "files", "mio.txt"), []byte("mío\n"), 0o644)

	// Somebody else's home, and a secret outside every home. Both are the
	// things a traversal is trying to reach.
	other := filepath.Join(cfg.HomesDir, "beto")
	os.MkdirAll(filepath.Join(other, "files"), 0o755)
	os.MkdirAll(filepath.Join(other, "data"), 0o755)
	os.WriteFile(filepath.Join(other, "data", "config.json"),
		[]byte(`{"password":"xyz"}`), 0o644)
	os.WriteFile(filepath.Join(other, "files", "suyo.txt"), []byte("de beto\n"), 0o644)

	return users, cfg, root
}

// TestResolvePathAllows covers the paths that must WORK - a sandbox that
// refuses everything is not a sandbox, it is an outage.
func TestResolvePathAllows(t *testing.T) {
	users, cfg, _ := newTestUsers(t)

	cases := []struct {
		path     string
		writable bool
	}{
		{"files/mio.txt", true},
		{"data/config.json", true},
		{"files", true},
		{"data", true},
		{"apps/index.html", false},         // shared, read-only
		{"files/nuevo.txt", true},          // does NOT exist yet: a PUT must resolve
		{"files/sub/otro/nuevo.txt", true}, // nor do its parents
		{"files/EE.UU..txt", true},         // dots in a name are not a traversal
		{"files//mio.txt", true},           // empty segments are dropped
		{"files/./mio.txt", true},          // so is "."
	}
	for _, tc := range cases {
		got, writable := users.ResolvePath("user", "ana", tc.path)
		if got == "" {
			t.Errorf("ResolvePath(%q) was refused", tc.path)
			continue
		}
		if !strings.HasPrefix(got, filepath.Join(cfg.HomesDir, "ana")) &&
			!strings.HasPrefix(got, cfg.AppsDir) {
			t.Errorf("ResolvePath(%q) = %q, outside the allowed roots", tc.path, got)
		}
		if writable != tc.writable {
			t.Errorf("ResolvePath(%q) writable = %v, want %v", tc.path, writable, tc.writable)
		}
	}
}

// TestResolvePathRefuses is the security test.
func TestResolvePathRefuses(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	home := filepath.Join(cfg.HomesDir, "ana")

	// THE cases a string check cannot defend against: real symlinks, planted
	// inside the user's own home, pointing at things they must never read.
	//
	// A user CAN create these - they own the folder - so this is not a
	// hypothetical.
	os.Symlink("/etc", filepath.Join(home, "files", "fuera"))
	os.Symlink(filepath.Join(cfg.HomesDir, "beto"), filepath.Join(home, "files", "beto"))
	os.Symlink(cfg.Path, filepath.Join(home, "files", "config"))
	// "../.." from inside files/ is homes/ itself - one level ABOVE the
	// sandbox root. ("../.." rather than "..", because ".." only reaches ana's
	// own home, which is inside the sandbox and legitimately allowed.)
	os.Symlink("../..", filepath.Join(home, "files", "arriba"))

	refused := []string{
		"../../etc/passwd",
		"..",
		"files/../../beto/files/suyo.txt",
		"/etc/passwd",
		"",
		"nada/x",                    // not one of the allowed roots
		"config/server.json",        // admin-only, and not a user root
		"homes/beto/files/suyo.txt", // ditto
		".trash/x",                  // the trash is only reached through trash.go
		"files/.trash/x",
		"shared",        // the virtual folder is not a real path
		"shared/nada/x", // no such grant
		// the symlinks
		"files/fuera/passwd",
		"files/beto/files/suyo.txt",
		"files/beto/data/config.json",
		"files/config",
		"files/arriba/beto/files/suyo.txt",
		// Note what is NOT here: "files/arriba/ana/data/config.json" resolves
		// back INSIDE ana's own home, so it is allowed - and so it should be.
		// The rule is "never leave the sandbox", not "never follow a link".
	}
	for _, path := range refused {
		if got, _ := users.ResolvePath("user", "ana", path); got != "" {
			t.Errorf("ResolvePath(%q) ESCAPED to %q", path, got)
		}
	}
}

// TestResolvePathPercentDecoding pins the double decode. The Python decodes
// once in parse_qs and once more in resolve_path, so a client that
// double-encodes really does address the plain path - and, more to the point,
// "%2e%2e" must be caught rather than treated as a filename.
func TestResolvePathPercentDecoding(t *testing.T) {
	users, _, _ := newTestUsers(t)

	if got, _ := users.ResolvePath("user", "ana", "files%2Fmio.txt"); got == "" {
		t.Error("a percent-encoded slash was refused; the Python accepts it")
	}
	for _, path := range []string{
		"%2e%2e/%2e%2e/etc/passwd",
		"files/%2e%2e/%2e%2e/beto/files/suyo.txt",
		"%252e%252e/%252e%252e/etc/passwd", // double-encoded: decoded twice too
	} {
		if got, _ := users.ResolvePath("user", "ana", path); got != "" {
			t.Errorf("ResolvePath(%q) ESCAPED to %q", path, got)
		}
	}
}

// TestResolvePathAdmin - the admin really may go anywhere under the base dir,
// and nowhere above it.
func TestResolvePathAdmin(t *testing.T) {
	users, cfg, _ := newTestUsers(t)

	for _, path := range []string{"", "config/server.json", "homes/beto/files/suyo.txt", "apps"} {
		if got, _ := users.ResolvePath("admin", "jefe", path); got == "" {
			t.Errorf("the admin was refused %q", path)
		}
	}
	for _, path := range []string{"../..", "../secreto"} {
		if got, _ := users.ResolvePath("admin", "jefe", path); got != "" {
			t.Errorf("the admin escaped the base dir with %q -> %q", path, got)
		}
	}
	if got, _ := users.ResolvePath("admin", "jefe", "homes"); !isInside(cfg.BaseDir, got) {
		t.Errorf("admin homes/ resolved outside the base dir: %q", got)
	}
}

// TestAuthenticate covers the three ways in and the ways that must not work.
func TestAuthenticate(t *testing.T) {
	users, _, _ := newTestUsers(t)

	cases := []struct {
		user, password, want string
	}{
		{"ana", "abc", "user"},
		{"ana", "ABC", ""},
		{"ana", "", ""},
		{"ana", "abcd", ""},
		{"jefe", "secreto", "admin"},
		{"jefe", "otra", ""},
		{"nadie", "abc", ""},
		{"", "", ""},
		{"../beto", "xyz", ""}, // the name rule is what keeps this inside homes/
		{"ana/../beto", "xyz", ""},
	}
	for _, tc := range cases {
		if got := users.Authenticate(tc.user, tc.password); got != tc.want {
			t.Errorf("Authenticate(%q, %q) = %q, want %q",
				tc.user, tc.password, got, tc.want)
		}
	}
}

// TestPasswordlessAccount - an account the admin just created has no password,
// and a blank one signs the person in exactly once, until they pick a real one.
func TestPasswordlessAccount(t *testing.T) {
	users, cfg, _ := newTestUsers(t)

	home := filepath.Join(cfg.HomesDir, "nuevo")
	os.MkdirAll(filepath.Join(home, "data"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "config.json"), []byte(`{"password":""}`), 0o644)

	if got := users.Authenticate("nuevo", ""); got != "user" {
		t.Errorf("a blank password on a password-less account = %q, want user", got)
	}
	if got := users.Authenticate("nuevo", "loquesea"); got != "" {
		t.Errorf("any password was accepted on a password-less account: %q", got)
	}
	if !users.NeedsPassword("user", "nuevo") {
		t.Error("NeedsPassword should be true until one is set")
	}
	if !users.SetPassword("user", "nuevo", "real") {
		t.Fatal("SetPassword failed")
	}
	if users.NeedsPassword("user", "nuevo") {
		t.Error("NeedsPassword should be false once one is set")
	}
	if got := users.Authenticate("nuevo", ""); got != "" {
		t.Error("a blank password still works after one was set")
	}
}

// TestNormaliseUsername is the whole point of the one dependency this server
// has: two spellings of the same name must become the same string.
func TestNormaliseUsername(t *testing.T) {
	cases := []struct{ label, in, want string }{
		{"Jose + combining acute -> José", "Jose\u0301", "José"},
		{"José already precomposed", "José", "José"},
		{"ANGSTROM SIGN -> A with ring", "Å", "Å"},
		{"OHM SIGN -> capital omega", "Ω", "Ω"},
		{"hangul jamo -> one syllable", "한", "한"},
		{"trims the whitespace", "  ana  ", "ana"},
		{"leaves an ordinary name alone", "Ángel", "Ángel"},
		{"leaves a non-Latin name alone", "用户", "用户"},
	}
	for _, tc := range cases {
		if got := NormaliseUsername(tc.in); got != tc.want {
			t.Errorf("%s: NormaliseUsername(%q) = %q, want %q", tc.label, tc.in, got, tc.want)
		}
	}
}

// TestValidUsername pins the name rule, on names that have already been
// normalised - which is the only way this function is ever called.
func TestValidUsername(t *testing.T) {
	good := []string{
		"ana", "Ana", "jose", "José", "j_o-s.e", "año", "用户", "a1", "x",
		"Ángel", "Muñoz", "Chloé", "Müller", "Ελένη", "Владимир", "עברית",
		"أحمد", "Việt", "Å", "Ω", "한",
	}
	bad := []string{
		"", ".", "..", ".oculto", "a/b", `a`, "a b", "a	b",
		"a\x00b", "a\u200bb", // a NUL and a zero-width space
		strings.Repeat("a", 65),
		"Jose\u0301", // decomposed: normalise it FIRST, do not hand it to this
		"हिन्दी",     // a virama survives normalisation - Python refuses it too
	}
	for _, name := range good {
		if !ValidUsername(NormaliseUsername(name)) {
			t.Errorf("ValidUsername(%q) = false, want true", name)
		}
	}
	for _, name := range bad {
		if ValidUsername(name) {
			t.Errorf("ValidUsername(%q) = true, want false", name)
		}
	}
}

// TestSignInWithEitherSpelling is the behaviour a person would actually notice:
// an account created one way is reachable typed the other way.
func TestSignInWithEitherSpelling(t *testing.T) {
	users, _, _ := newTestUsers(t)

	const precomposed = "José"
	const decomposed = "Jose\u0301"
	if precomposed == decomposed {
		t.Fatal("the two spellings are the same string - the test proves nothing")
	}

	// Create the account the way the admin panel does.
	if got := users.SaveAccount(NormaliseUsername(decomposed),
		SaveAccountOptions{Password: "clave"}); got != "created" {
		t.Fatalf("SaveAccount = %q", got)
	}

	// Both spellings must reach it, and must reach the SAME home folder.
	for _, typed := range []string{precomposed, decomposed, "  Jose\u0301  "} {
		name := NormaliseUsername(typed)
		if role := users.Authenticate(name, "clave"); role != "user" {
			t.Errorf("signing in as %q gave %q, want user", typed, role)
		}
		if name != precomposed {
			t.Errorf("%q normalised to %q, want the precomposed form", typed, name)
		}
	}
}

// TestAtomicWriteJSON checks the two properties the whole project leans on: the
// file is either wholly old or wholly new, and its shape matches what the
// Python writes (four spaces, real UTF-8, a trailing newline).
func TestAtomicWriteJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.json")

	if err := atomicWriteJSON(path, map[string]string{"saludo": "años ñ <&>"}, 4); err != nil {
		t.Fatalf("atomicWriteJSON: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	text := string(raw)

	if !strings.HasSuffix(text, "\n") {
		t.Error("no trailing newline")
	}
	if !strings.Contains(text, `    "saludo"`) {
		t.Errorf("not indented with four spaces:\n%s", text)
	}
	if !strings.Contains(text, "años ñ <&>") {
		t.Errorf("text was escaped instead of written as UTF-8:\n%s", text)
	}
	var back map[string]string
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}

	// No temp file may be left behind on the happy path.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("%d files left in the directory, want 1", len(entries))
	}
	// And the name it WOULD use must be one the sweep recognises, or a crashed
	// write would leave litter nothing ever cleans up.
	if !isTempName("x.json.1234.5.tmp") {
		t.Error("the temp-name pattern and the sweep's regex disagree")
	}
}

// TestIsTempName - the loose test (any ".tmp" suffix) used to hide a user's own
// "notes.tmp" from Drive and then delete it at the next restart.
func TestIsTempName(t *testing.T) {
	temps := []string{"config.json.123.456.tmp", ".upload-abc123_z", "x.1.2.tmp"}
	real := []string{
		"notes.tmp", "notes.TMP", ".upload-drafts", ".upload-abc",
		".upload-ABC12345", "x.tmp", "config.json", "",
	}
	for _, name := range temps {
		if !isTempName(name) {
			t.Errorf("isTempName(%q) = false, want true", name)
		}
	}
	for _, name := range real {
		if isTempName(name) {
			t.Errorf("isTempName(%q) = true - that is a user's own file", name)
		}
	}
}

// TestUploadTempNameShape - the two servers must clean up after each other, so
// the name this port writes has to match the regex both of them sweep by.
func TestUploadTempNameShape(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatalf("OpenRoot: %v", err)
	}
	defer root.Close()
	for i := 0; i < 20; i++ {
		f, path, err := createUploadTemp(root, ".")
		if err != nil {
			t.Fatalf("createUploadTemp: %v", err)
		}
		name := filepath.Base(path)
		f.Close()
		if !isTempName(name) {
			t.Fatalf("createUploadTemp made %q, which the sweep would not recognise", name)
		}
	}
}

// TestHandEditedConfigIsTolerated is the bug the parity harness could not see,
// because it never wrote a bad value into a config.json by hand.
//
// Python reads each field with its own try/except, so one mistyped value costs
// exactly that field. A single Unmarshal into the whole struct does not: a
// `"quota": "abc"` left a POINTER TO ZERO behind, which the quota check reads
// as "this account may store 0 bytes" - and every upload that user made
// answered 507, for one wrong character in a file they edited themselves.
func TestHandEditedConfigIsTolerated(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	path := filepath.Join(cfg.HomesDir, "ana", "data", "config.json")

	cases := []struct {
		name, body string
		// what must survive
		password string
		quota    bool // true when a quota must be reported
		tz       string
	}{
		{"a quota that is not a number",
			`{"password":"abc","quota":"nada","tz":"Europe/Madrid"}`,
			"abc", false, "Europe/Madrid"},
		{"a quota written as a string",
			`{"password":"abc","quota":"2","tz":"Europe/Madrid"}`,
			"abc", true, "Europe/Madrid"},
		{"a photo_max that is not a number",
			`{"password":"abc","photo_max":"grande","tz":"Europe/Madrid"}`,
			"abc", false, "Europe/Madrid"},
		{"a null quota",
			`{"password":"abc","quota":null,"tz":"Europe/Madrid"}`,
			"abc", false, "Europe/Madrid"},
		{"trash_days as a string",
			`{"password":"abc","trash_days":"7","tz":"Europe/Madrid"}`,
			"abc", false, "Europe/Madrid"},
		{"an unknown field",
			`{"password":"abc","tz":"Europe/Madrid","inventado":{"a":1}}`,
			"abc", false, "Europe/Madrid"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			os.WriteFile(path, []byte(tc.body), 0o644)

			if got := users.Authenticate("ana", tc.password); got != "user" {
				t.Errorf("the account stopped working: Authenticate = %q", got)
			}
			gotQuota := users.UserQuotaBytes("ana")
			if tc.quota && gotQuota == nil {
				t.Error("a usable quota was thrown away")
			}
			if !tc.quota && gotQuota != nil {
				t.Errorf("a bad quota became a REAL one of %d bytes - every upload "+
					"by this user would now answer 507", *gotQuota)
			}
			if tz := users.UserTZ("user", "ana"); tz == nil || *tz != tc.tz {
				t.Errorf("the timezone was lost: %v", tz)
			}
		})
	}
}

// TestRewriteKeepsUnknownFields - the server must never eat a field it does not
// understand. An app may have parked something in there.
func TestRewriteKeepsUnknownFields(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	path := filepath.Join(cfg.HomesDir, "ana", "data", "config.json")
	os.WriteFile(path, []byte(
		`{"password":"abc","quota":12.0,"colors":{"fondo":"azul"},"inventado":7}`), 0o644)

	if !users.SetPassword("user", "ana", "nueva") {
		t.Fatal("SetPassword failed")
	}

	raw, _ := os.ReadFile(path)
	var back map[string]any
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("the rewritten file is not JSON: %v", err)
	}
	if back["password"] != "nueva" {
		t.Errorf("password = %v", back["password"])
	}
	if back["inventado"] == nil || back["colors"] == nil {
		t.Errorf("an unknown field was eaten: %v", back)
	}
	// The stored 12.0 must come back as 12.0, not as 12 - the admin panel
	// echoes it and the two servers must not disagree about the spelling.
	if !strings.Contains(string(raw), "12.0") {
		t.Errorf("the stored quota was re-rendered:\n%s", raw)
	}
}
