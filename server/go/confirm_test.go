package main

// =============================================================================
// "Confirm it is you": the authenticator app (confirm_totp.go) and the gates
// it shares with the passkeys (confirm_passkey.go). The fake passkey and the
// helpers are in ssh_test.go.
// =============================================================================

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// RFC 4226 appendix D (HOTP, 6 digits) and RFC 6238 appendix B (TOTP SHA1,
// 8 digits), secret "12345678901234567890".
func TestTOTPRFCVectors(t *testing.T) {
	key := []byte("12345678901234567890")
	hotpWant := []string{"755224", "287082", "359152", "969429", "338314",
		"254676", "287922", "162583", "399871", "520489"}
	for i, want := range hotpWant {
		if got := hotp(key, uint64(i), 6); got != want {
			t.Errorf("HOTP(%d) = %s, want %s", i, got, want)
		}
	}
	totpWant := map[int64]string{
		59: "94287082", 1111111109: "07081804", 1111111111: "14050471",
		1234567890: "89005924", 2000000000: "69279037", 20000000000: "65353130",
	}
	for unix, want := range totpWant {
		step := uint64(unix / totpStep)
		if got := hotp(key, step, 8); got != want {
			t.Errorf("TOTP(%d) = %s, want %s", unix, got, want)
		}
		// 6 digits are the last 6 of the 8; totpMatch takes them at that time.
		if got := hotp(key, step, 6); got != want[2:] {
			t.Errorf("TOTP6(%d) = %s, want %s", unix, got, want[2:])
		}
		if s, _, ok := totpMatch(key, want[2:], time.Unix(unix, 0), -1); !ok || s != int64(step) {
			t.Errorf("totpMatch at %d: step %d ok %v", unix, s, ok)
		}
	}
}

// clockHub is a hub whose time he moves by hand.
func clockHub(t *testing.T) (*SSHHub, *time.Time) {
	h := newTestHub(t)
	now := time.Unix(1_800_000_000, 0)
	h.now = func() time.Time { return now }
	return h, &now
}

// addApp adds the app through both steps and answers its secret and the ticket.
func addApp(t *testing.T, h *SSHHub, code, ticket string) ([]byte, string) {
	t.Helper()
	offer, err := h.TOTPBegin(tTok, "jefe", tRP, code, ticket)
	if err != nil {
		t.Fatalf("totp begin: %v", err)
	}
	key, err := totpB32.DecodeString(offer.Secret)
	if err != nil || len(key) != 20 {
		t.Fatalf("secret %q: %v", offer.Secret, err)
	}
	if !strings.HasPrefix(offer.URI, "otpauth://totp/Nayive%20SSH:jefe%40nayive.test?secret="+offer.Secret+"&issuer=Nayive%20SSH") {
		t.Errorf("uri = %s", offer.URI)
	}
	tk, err := h.TOTPAdd(tTok, code, appCode(h, key, 0), "My phone")
	if err != nil {
		t.Fatalf("totp add: %v", err)
	}
	return key, tk
}

// appCode is what the app shows `d` steps from the hub's now.
func appCode(h *SSHHub, key []byte, d int64) string {
	return hotp(key, uint64(h.now().Unix()/totpStep+d), totpDigits)
}

func TestTOTPFirstNeedsSetupCode(t *testing.T) {
	h, _ := clockHub(t)
	if _, err := h.TOTPBegin(tTok, "jefe", tRP, "", ""); err == nil {
		t.Fatal("totp begin with no setup code")
	}
	code := setupCode(t, h)
	offer, err := h.TOTPBegin(tTok, "jefe", tRP, code, "")
	if err != nil {
		t.Fatal(err)
	}
	key, _ := totpB32.DecodeString(offer.Secret)

	// A wrong first code: nothing saved, the setup code still good.
	if _, err := h.TOTPAdd(tTok, code, "000000", ""); err == nil {
		t.Fatal("a wrong first code was taken")
	}
	if _, err := os.Stat(h.totpPath()); !os.IsNotExist(err) {
		t.Fatal("the app was saved before a right code")
	}
	if _, err := os.Stat(h.setupPath()); err != nil {
		t.Fatal("a wrong app code burnt the setup code")
	}
	// Another session cannot finish this session's app.
	if _, err := h.TOTPAdd("other-session", code, appCode(h, key, 0), ""); err == nil {
		t.Error("another session finished the app")
	}
	tk, err := h.TOTPAdd(tTok, code, appCode(h, key, 0), "")
	if err != nil || tk == "" {
		t.Fatalf("totp add: %v", err)
	}
	if st, err := os.Stat(h.totpPath()); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("ssh-totp.json: %v, want 0600", err)
	}
	if _, err := os.Stat(h.setupPath()); !os.IsNotExist(err) {
		t.Error("the setup file outlived its use")
	}
	if !h.SpendTicket(tTok, tk) {
		t.Error("the add's ticket does not open")
	}

	// The list shows it with no secret; the status says so.
	list, _ := h.ListKeys()
	raw, _ := json.Marshal(list)
	if len(list) != 1 || list[0].Kind != "app" || list[0].Name != "Authenticator app" || strings.Contains(string(raw), offer.Secret) {
		t.Errorf("list = %s", raw)
	}
	if st, _ := h.Status(tRP); st.None || !st.App || st.Passkeys != 0 {
		t.Errorf("status = %+v", st)
	}
}

// With an app and no passkey: no setup code, "get" is not None, and the next
// way in needs a ticket.
func TestTOTPNoSetupCodeOnceAppExists(t *testing.T) {
	h, now := clockHub(t)
	code := setupCode(t, h)
	key, _ := addApp(t, h, code, "")

	if _, err := h.MakeSetupCode(); err == nil {
		t.Error("a setup code was made while an app exists")
	}
	if b, err := h.Begin(tTok, "get", tRP, "jefe", "", ""); err == nil || b.None {
		t.Errorf("begin get with only an app: %+v %v (want no None)", b, err)
	}
	f := newFakeKey(t)
	if _, err := registerKey(t, h, f, code, ""); err == nil {
		t.Error("a passkey went in on the setup code while an app exists")
	}
	if _, err := h.TOTPBegin(tTok, "jefe", tRP, "", ""); err != errTOTPExists {
		t.Errorf("a second app: %v, want errTOTPExists", err)
	}
	// A passkey goes in with the app's ticket.
	*now = now.Add(totpStep * time.Second)
	tk, err := h.TOTPConfirm(tTok, appCode(h, key, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registerKey(t, h, f, "", tk); err != nil {
		t.Fatalf("passkey with the app's ticket: %v", err)
	}
	if list, _ := h.ListKeys(); len(list) != 2 {
		t.Errorf("list = %+v", list)
	}
	// At another address the passkey cannot be used: the status says so,
	// and offers the app.
	if st, _ := h.Status("other.test"); st.Passkeys != 0 || st.Others != 1 || !st.App || st.None {
		t.Errorf("status at another address = %+v", st)
	}
	if st, _ := h.Status(tRP); st.Passkeys != 1 || st.Others != 0 {
		t.Errorf("status here = %+v", st)
	}
}

// With a passkey only: the app needs a ticket, and spends it.
func TestTOTPLaterNeedsTicket(t *testing.T) {
	h, _ := clockHub(t)
	f := newFakeKey(t)
	code := setupCode(t, h)
	if _, err := registerKey(t, h, f, code, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := h.TOTPBegin(tTok, "jefe", tRP, code, ""); err != errConfirmFirst {
		t.Errorf("app with the old setup code: %v, want errConfirmFirst", err)
	}
	tk, err := confirmKey(t, h, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	offer, err := h.TOTPBegin(tTok, "jefe", tRP, "", tk)
	if err != nil {
		t.Fatal(err)
	}
	if h.SpendTicket(tTok, tk) {
		t.Error("the ticket outlived the app's first step")
	}
	// A wrong code, then the right one: no new ticket needed in between.
	key, _ := totpB32.DecodeString(offer.Secret)
	if _, err := h.TOTPAdd(tTok, "", "000000", ""); err == nil {
		t.Fatal("wrong first code taken")
	}
	if _, err := h.TOTPAdd(tTok, "", appCode(h, key, 0), ""); err != nil {
		t.Fatalf("right code after a wrong one: %v", err)
	}

	// Remove the app (with a ticket); the passkey stays.
	if err := h.RemoveKey(tTok, "nope", totpListID); err == nil {
		t.Error("removed the app with no ticket")
	}
	tk, _ = confirmKey(t, h, f, nil)
	if err := h.RemoveKey(tTok, tk, totpListID); err != nil {
		t.Fatal(err)
	}
	if st, _ := h.Status(tRP); st.App || st.Passkeys != 1 || st.None {
		t.Errorf("status = %+v", st)
	}
}

// An app begun on the setup code is void once a passkey went in meanwhile.
func TestTOTPSetupBeginVoidedByPasskey(t *testing.T) {
	h, _ := clockHub(t)
	code := setupCode(t, h)
	offer, err := h.TOTPBegin(tTok, "jefe", tRP, code, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registerKey(t, h, newFakeKey(t), code, ""); err != nil {
		t.Fatal(err)
	}
	key, _ := totpB32.DecodeString(offer.Secret)
	if _, err := h.TOTPAdd(tTok, code, appCode(h, key, 0), ""); err != errConfirmFirst {
		t.Errorf("app after a passkey on the same code: %v, want errConfirmFirst", err)
	}
}

func TestTOTPWindowAndReplay(t *testing.T) {
	h, now := clockHub(t)
	key, _ := addApp(t, h, setupCode(t, h), "")

	// The adding used this step: the same code again is a replay.
	if _, err := h.TOTPConfirm(tTok, appCode(h, key, 0)); err == nil || !strings.Contains(err.Error(), "next code") {
		t.Errorf("the adding's code again: %v", err)
	}
	h.fails = nil

	// Ten steps on: one step either side works, two do not.
	*now = now.Add(10 * totpStep * time.Second)
	for _, d := range []int64{-2, 2} {
		if _, err := h.TOTPConfirm(tTok, appCode(h, key, d)); err == nil {
			t.Errorf("a code %d steps away was taken", d)
		}
	}
	h.fails = nil
	if _, err := h.TOTPConfirm(tTok, appCode(h, key, -1)); err != nil {
		t.Errorf("one step behind: %v", err)
	}
	// A late-clock code (+1) works; after it, now's code (an older step) does not.
	tk, err := h.TOTPConfirm(tTok, appCode(h, key, 1))
	if err != nil || !h.SpendTicket(tTok, tk) {
		t.Fatalf("one step ahead: %v", err)
	}
	if _, err := h.TOTPConfirm(tTok, appCode(h, key, 0)); err == nil {
		t.Error("an older step was taken after a newer one")
	}
	if _, err := h.TOTPConfirm(tTok, appCode(h, key, 1)); err == nil {
		t.Error("the same code twice")
	}
	// The last step is on disk, not only in memory.
	app, _ := h.loadTOTP()
	if app == nil || app.Last != now.Unix()/totpStep+1 {
		t.Errorf("stored step = %+v", app)
	}
}

func TestTOTPWrongCodesLock(t *testing.T) {
	h, now := clockHub(t)
	key, _ := addApp(t, h, setupCode(t, h), "")
	*now = now.Add(5 * totpStep * time.Second)
	for i := 0; i < confirmFailMax; i++ {
		h.TOTPConfirm(tTok, "123456")
	}
	if _, err := h.TOTPConfirm(tTok, appCode(h, key, 0)); err != errTooManyTries {
		t.Errorf("after %d wrong codes: %v, want the lock", confirmFailMax, err)
	}
	if st, _ := h.Status(tRP); !st.Locked {
		t.Error("status does not say locked")
	}
	if _, err := h.Begin(tTok, "get", tRP, "jefe", "", ""); err != errTooManyTries {
		t.Errorf("passkeys too: %v", err)
	}
	// The window passes.
	*now = now.Add(confirmFailWindow + time.Second)
	if _, err := h.TOTPConfirm(tTok, appCode(h, key, 0)); err != nil {
		t.Errorf("after the window: %v", err)
	}
}

// Slow guessing, under 5 per 15 minutes, still stops at 10 a day.
func TestTOTPWrongCodesDayLock(t *testing.T) {
	h, now := clockHub(t)
	key, _ := addApp(t, h, setupCode(t, h), "")
	for round := 0; round < 3; round++ {
		*now = now.Add(confirmFailWindow + time.Minute)
		for i := 0; i < 4 && len(h.fails) < confirmFailDayMax; i++ {
			if _, err := h.TOTPConfirm(tTok, "123456"); err == errTooManyTries || err == errTooManyToday {
				t.Fatalf("locked early, after %d: %v", len(h.fails), err)
			}
		}
	}
	*now = now.Add(confirmFailWindow + time.Minute) // the 15-minute lock is not the reason
	if _, err := h.TOTPConfirm(tTok, appCode(h, key, 0)); err != errTooManyToday {
		t.Errorf("after %d wrong codes in a day: %v, want the day lock", confirmFailDayMax, err)
	}
	if st, _ := h.Status(tRP); !st.Locked || st.Lock != errTooManyToday.Error() {
		t.Errorf("status = %+v", st)
	}
	*now = now.Add(confirmFailDay)
	if _, err := h.TOTPConfirm(tTok, appCode(h, key, 0)); err != nil {
		t.Errorf("a day later: %v", err)
	}
}

// TestSSHTOTPOverHTTP: the setup code, the app, a confirm, open - through the
// real routes.
func TestSSHTOTPOverHTTP(t *testing.T) {
	srv, ts, admin := newTestServer(t)
	addr, hk := fakeSSHD(t, true)
	srv.ssh.dialAddr = func() string { return addr }
	srv.ssh.hostKeys = func() ([]sshHostKey, error) { return []sshHostKey{hk}, nil }
	signIn(t, admin, ts.URL, "jefe", "secreto")
	call := func(method, path string, body any, out any) int {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = strings.NewReader(string(b))
		}
		resp := do(t, admin, method, ts.URL+"/api/ssh/"+path, rd,
			map[string]string{"Content-Type": "application/json", "Origin": ts.URL})
		defer resp.Body.Close()
		if out != nil {
			json.NewDecoder(resp.Body).Decode(out)
		}
		return resp.StatusCode
	}

	var st confirmStatus
	if c := call("GET", "status", nil, &st); c != 200 || !st.None {
		t.Fatalf("status = %d %+v", c, st)
	}
	var setup struct{ File string }
	call("POST", "setup", map[string]any{}, &setup)
	raw, _ := os.ReadFile(setup.File)
	code := strings.TrimSpace(string(raw))

	var offer totpOffer
	if c := call("POST", "totp-begin", map[string]any{"code": code}, &offer); c != 200 || offer.Secret == "" {
		t.Fatalf("totp-begin = %d", c)
	}
	rp, _, _ := net.SplitHostPort(strings.TrimPrefix(ts.URL, "http://"))
	if !strings.Contains(offer.URI, "jefe%40"+rp) {
		t.Errorf("uri = %s", offer.URI)
	}
	key, _ := totpB32.DecodeString(offer.Secret)
	now := time.Now()
	otp := hotp(key, uint64(now.Unix()/totpStep), totpDigits)
	var tk struct{ Ticket, Error string }
	call("POST", "totp-add", map[string]any{"code": code, "otp": otp, "name": "Phone"}, &tk)
	if tk.Ticket == "" {
		t.Fatalf("totp-add: %s", tk.Error)
	}
	if c := call("GET", "status", nil, &st); c != 200 || st.None || !st.App {
		t.Errorf("status after = %+v", st)
	}
	var keys struct{ Keys []factorInfo }
	call("GET", "keys", nil, &keys)
	if len(keys.Keys) != 1 || keys.Keys[0].ID != totpListID {
		t.Errorf("keys = %+v", keys)
	}

	// The add's ticket opens the terminal; then the same code again is refused.
	var opened struct{ ID, Error string }
	call("POST", "open", map[string]any{"ticket": tk.Ticket, "user": "ana", "password": "pw", "cols": 80, "rows": 24}, &opened)
	if opened.ID == "" {
		t.Fatalf("open: %s", opened.Error)
	}
	call("POST", "close", map[string]any{"id": opened.ID}, nil)
	if c := call("POST", "totp", map[string]any{"otp": otp}, nil); c != http.StatusBadRequest {
		t.Errorf("replayed code = %d, want 400", c)
	}
}
