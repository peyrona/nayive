package main

// =============================================================================
// The SSH tab: passkeys (confirm_passkey.go), the terminal (ssh_term.go), the
// routes (api_ssh.go). A fake authenticator signs like a phone would; a tiny
// SSH server in the test stands in for sshd.
// =============================================================================

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	tOrigin = "https://nayive.test"
	tRP     = "nayive.test"
	tTok    = "session-token-1"
)

// fakeKey is a passkey on a fake phone.
type fakeKey struct {
	priv  *ecdsa.PrivateKey
	id    []byte
	count uint32
	flags byte
}

func newFakeKey(t *testing.T) *fakeKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &fakeKey{priv: k, id: randomBytes(16), flags: adUP | adUV}
}

func (f *fakeKey) authData(rpID string, attested bool) []byte {
	h := sha256.Sum256([]byte(rpID))
	ad := append([]byte{}, h[:]...)
	flags := f.flags
	if attested {
		flags |= adAT
	}
	ad = append(ad, flags)
	ad = binary.BigEndian.AppendUint32(ad, f.count)
	if attested {
		ad = append(ad, make([]byte, 16)...) // aaguid
		ad = binary.BigEndian.AppendUint16(ad, uint16(len(f.id)))
		ad = append(ad, f.id...)
		ad = append(ad, 0xa5) // the COSE key would follow; never read
	}
	return ad
}

func clientDataJSON(typ, challenge, origin string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": origin, "crossOrigin": false})
	return b
}

func (f *fakeKey) spki(t *testing.T) []byte {
	der, err := x509.MarshalPKIXPublicKey(&f.priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func (f *fakeKey) sign(t *testing.T, ad, cd []byte) []byte {
	h := sha256.Sum256(cd)
	m := sha256.Sum256(append(append([]byte{}, ad...), h[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, f.priv, m[:])
	if err != nil {
		t.Fatal(err)
	}
	return sig
}

func newTestHub(t *testing.T) *SSHHub {
	return NewSSHHub(t.TempDir())
}

// setupCode makes a code and reads it back from its file, as he would over SSH.
func setupCode(t *testing.T, h *SSHHub) string {
	t.Helper()
	path, err := h.MakeSetupCode()
	if err != nil {
		t.Fatalf("setup code: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("setup file %v, mode %v; want 0600", err, st.Mode().Perm())
	}
	b, _ := os.ReadFile(path)
	return strings.TrimSpace(string(b))
}

// registerKey adds `f` with the setup code (first) or a ticket (later).
func registerKey(t *testing.T, h *SSHHub, f *fakeKey, code, ticket string) (string, error) {
	t.Helper()
	b, err := h.Begin(tTok, "create", tRP, "jefe", code, ticket)
	if err != nil {
		return "", err
	}
	cd := clientDataJSON("webauthn.create", b.Challenge, tOrigin)
	return h.Register(tTok, tOrigin, passkeyRegistration{
		Code: code, Ticket: ticket, Name: "Phone", ID: b64u(f.id),
		ClientData: b64u(cd), AuthData: b64u(f.authData(tRP, true)),
		Key: b64u(f.spki(t)), Alg: coseES256, Transports: []string{"hybrid"},
	})
}

// confirmKey answers a "get" challenge with `f`; `tweak` may spoil it.
func confirmKey(t *testing.T, h *SSHHub, f *fakeKey, tweak func(cd, ad *[]byte, origin *string)) (string, error) {
	t.Helper()
	b, err := h.Begin(tTok, "get", tRP, "jefe", "", "")
	if err != nil {
		return "", err
	}
	origin := tOrigin
	cd := clientDataJSON("webauthn.get", b.Challenge, origin)
	f.count++
	ad := f.authData(tRP, false)
	if tweak != nil {
		tweak(&cd, &ad, &origin)
	}
	return h.Confirm(tTok, origin, passkeyAssertion{
		ID: b64u(f.id), ClientData: b64u(cd), AuthData: b64u(ad), Signature: b64u(f.sign(t, ad, cd)),
	})
}

func TestSSHPasskeyFirstNeedsSetupCode(t *testing.T) {
	h := newTestHub(t)
	f := newFakeKey(t)

	if b, err := h.Begin(tTok, "get", tRP, "jefe", "", ""); err != nil || !b.None {
		t.Fatalf("no passkey yet: want none, got %+v %v", b, err)
	}
	if _, err := registerKey(t, h, f, "", ""); err == nil {
		t.Fatal("registered with no setup code")
	}
	if _, err := registerKey(t, h, f, "AAAA-BBBB-CCCC", ""); err == nil {
		t.Fatal("registered with a wrong setup code")
	}
	code := setupCode(t, h)
	ticket, err := registerKey(t, h, f, strings.ToLower(code), "")
	if err != nil || ticket == "" {
		t.Fatalf("register with the code: %v", err)
	}
	if _, err := os.Stat(h.setupPath()); !os.IsNotExist(err) {
		t.Error("the setup file outlived its use")
	}
	if st, _ := os.Stat(h.keysPath()); st == nil || st.Mode().Perm() != 0o600 {
		t.Error("ssh-passkeys.json must be 0600")
	}
	// The code is spent, and with a passkey in place no new code is made.
	if _, err := h.MakeSetupCode(); err == nil {
		t.Error("a setup code was made while a passkey exists")
	}
	g := newFakeKey(t)
	if _, err := registerKey(t, h, g, code, ""); err == nil {
		t.Error("a second passkey went in on the old setup code")
	}
	// A second one goes in with a ticket from the first.
	tk, err := confirmKey(t, h, f, nil)
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if _, err := registerKey(t, h, g, "", tk); err != nil {
		t.Fatalf("second passkey with a ticket: %v", err)
	}
	if keys, _ := h.ListKeys(); len(keys) != 2 {
		t.Fatalf("keys = %d, want 2", len(keys))
	}
}

func TestSSHPasskeyConfirmRefusals(t *testing.T) {
	h := newTestHub(t)
	f := newFakeKey(t)
	if _, err := registerKey(t, h, f, setupCode(t, h), ""); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(cd, ad *[]byte, origin *string){
		"wrong origin in client data": func(cd, _ *[]byte, _ *string) {
			*cd = []byte(strings.Replace(string(*cd), tOrigin, "https://evil.test", 1))
		},
		"page on another host": func(_, _ *[]byte, o *string) { *o = "https://evil.test" },
		"create, not get": func(cd, _ *[]byte, _ *string) {
			*cd = []byte(strings.Replace(string(*cd), "webauthn.get", "webauthn.create", 1))
		},
		"made for another site": func(_, ad *[]byte, _ *string) {
			o := sha256.Sum256([]byte("evil.test"))
			copy(*ad, o[:])
		},
		"no fingerprint (UV off)": func(_, ad *[]byte, _ *string) { (*ad)[32] &^= adUV },
	}
	for name, tweak := range cases {
		if _, err := confirmKey(t, h, f, tweak); err == nil {
			t.Errorf("%s: accepted", name)
		}
		h.fails = nil // each case on its own
	}
	// A bad signature.
	b, _ := h.Begin(tTok, "get", tRP, "jefe", "", "")
	cd := clientDataJSON("webauthn.get", b.Challenge, tOrigin)
	f.count++
	ad := f.authData(tRP, false)
	sig := f.sign(t, ad, cd)
	sig[len(sig)-1] ^= 1
	if _, err := h.Confirm(tTok, tOrigin, passkeyAssertion{ID: b64u(f.id), ClientData: b64u(cd), AuthData: b64u(ad), Signature: b64u(sig)}); err == nil {
		t.Error("bad signature accepted")
	}
	// A replayed answer: the challenge is single use.
	b, _ = h.Begin(tTok, "get", tRP, "jefe", "", "")
	cd = clientDataJSON("webauthn.get", b.Challenge, tOrigin)
	f.count++
	ad = f.authData(tRP, false)
	a := passkeyAssertion{ID: b64u(f.id), ClientData: b64u(cd), AuthData: b64u(ad), Signature: b64u(f.sign(t, ad, cd))}
	if _, err := h.Confirm(tTok, tOrigin, a); err != nil {
		t.Fatalf("good answer refused: %v", err)
	}
	if _, err := h.Confirm(tTok, tOrigin, a); err == nil {
		t.Error("replayed answer accepted")
	}
	// Another session cannot use this session's challenge.
	b, _ = h.Begin(tTok, "get", tRP, "jefe", "", "")
	cd = clientDataJSON("webauthn.get", b.Challenge, tOrigin)
	f.count++
	ad = f.authData(tRP, false)
	if _, err := h.Confirm("other-session", tOrigin, passkeyAssertion{ID: b64u(f.id), ClientData: b64u(cd), AuthData: b64u(ad), Signature: b64u(f.sign(t, ad, cd))}); err == nil {
		t.Error("another session used the challenge")
	}
	// A counter that goes back.
	h.fails = nil
	f.count -= 5
	if _, err := confirmKey(t, h, f, nil); err == nil {
		t.Error("a counter going back was accepted")
	}
}

func TestSSHTicketSingleUseAndBound(t *testing.T) {
	h := newTestHub(t)
	f := newFakeKey(t)
	tk, err := registerKey(t, h, f, setupCode(t, h), "")
	if err != nil {
		t.Fatal(err)
	}
	if h.SpendTicket("other-session", tk) {
		t.Error("ticket worked for another session")
	}
	tk, _ = confirmKey(t, h, f, nil)
	if !h.SpendTicket(tTok, tk) {
		t.Fatal("good ticket refused")
	}
	if h.SpendTicket(tTok, tk) {
		t.Error("ticket worked twice")
	}
	tk, _ = confirmKey(t, h, f, nil)
	h.now = func() time.Time { return time.Now().Add(confirmTicketTTL + time.Second) }
	if h.SpendTicket(tTok, tk) {
		t.Error("old ticket accepted")
	}
}

func TestSSHTooManyFailsLocks(t *testing.T) {
	h := newTestHub(t)
	setupCode(t, h)
	for i := 0; i < confirmFailMax; i++ {
		h.Begin(tTok, "create", tRP, "jefe", "WRONG", "")
	}
	if _, err := h.Begin(tTok, "get", tRP, "jefe", "", ""); err != errTooManyTries {
		t.Errorf("after %d wrong codes: %v, want the lock", confirmFailMax, err)
	}
	if _, err := os.Stat(h.setupPath()); !os.IsNotExist(err) {
		t.Error("the setup code survived the wrong tries")
	}
}

func TestSSHRemoveNeedsTicket(t *testing.T) {
	h := newTestHub(t)
	f := newFakeKey(t)
	registerKey(t, h, f, setupCode(t, h), "")
	if err := h.RemoveKey(tTok, "nope", b64u(f.id)); err == nil {
		t.Error("removed without a ticket")
	}
	tk, _ := confirmKey(t, h, f, nil)
	if err := h.RemoveKey(tTok, tk, b64u(f.id)); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if keys, _ := h.ListKeys(); len(keys) != 0 {
		t.Error("still there")
	}
}

// -- the terminal ---------------------------------------------------------------

// fakeSSHD is a tiny SSH server: password "pw" for "ana", a pty, a shell that
// echoes what it gets and closes on "exit\r".
func fakeSSHD(t *testing.T, password bool) (addr string, hostKey ssh.PublicKey) {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{}
	if password {
		cfg.PasswordCallback = func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
			if c.User() == "ana" && string(p) == "pw" {
				return nil, nil
			}
			return nil, io.EOF
		}
	} else {
		cfg.PublicKeyCallback = func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) { return nil, io.EOF }
	}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go serveFakeSSH(c, cfg)
		}
	}()
	return ln.Addr().String(), signer.PublicKey()
}

func serveFakeSSH(c net.Conn, cfg *ssh.ServerConfig) {
	conn, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		ch, in, err := nc.Accept()
		if err != nil {
			return
		}
		go func() {
			for r := range in {
				r.Reply(r.Type == "pty-req" || r.Type == "shell" || r.Type == "window-change", nil)
			}
		}()
		ch.Write([]byte("$ "))
		buf := make([]byte, 256)
		var line string
		for {
			n, err := ch.Read(buf)
			if err != nil {
				return
			}
			ch.Write(buf[:n])
			line += string(buf[:n])
			if strings.HasSuffix(line, "exit\r") {
				ch.SendRequest("exit-status", false, []byte{0, 0, 0, 0})
				ch.Close()
				return
			}
		}
	}
}

func hubWithSSHD(t *testing.T, password bool) *SSHHub {
	h := newTestHub(t)
	addr, key := fakeSSHD(t, password)
	h.dialAddr = func() string { return addr }
	h.hostKeys = func() ([]sshHostKey, error) { return []sshHostKey{key}, nil }
	h.accounts = func() sshAccounts { return sshAccounts{Accounts: []string{"ana"}} }
	return h
}

// readUntil long-polls until the output holds `want`.
func readUntil(t *testing.T, term *sshTerm, from *int64, want string) string {
	t.Helper()
	var got string
	for i := 0; i < 20; i++ {
		r := term.read(*from, nil)
		*from = r.Next
		got += string(r.Data)
		if strings.Contains(got, want) || r.Ended != "" {
			return got
		}
	}
	return got
}

func TestSSHTermOpenTypeExit(t *testing.T) {
	h := hubWithSSHD(t, true)
	term, err := h.Open(tTok, "ana", "pw", 80, 24)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	var from int64
	if got := readUntil(t, term, &from, "$ "); !strings.Contains(got, "$ ") {
		t.Fatalf("no prompt: %q", got)
	}
	if h.find("other-session", term.id) != nil {
		t.Error("another Nayive session found the terminal")
	}
	if err := h.find(tTok, term.id).send("hello"); err != nil {
		t.Fatal(err)
	}
	if got := readUntil(t, term, &from, "hello"); !strings.Contains(got, "hello") {
		t.Fatalf("no echo: %q", got)
	}
	term.send("exit\r")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if r := term.read(from, nil); r.Ended != "" {
			return
		}
	}
	t.Error("the session did not end on exit")
}

func TestSSHTermRefusals(t *testing.T) {
	h := hubWithSSHD(t, true)
	if _, err := h.Open(tTok, "ana", "bad", 80, 24); err != errSSHLogin {
		t.Errorf("wrong password: %v", err)
	}
	if len(h.fails) != 1 {
		t.Errorf("a wrong SSH password must count: fails = %d", len(h.fails))
	}
	// A name with no account here says so, not "wrong password".
	if _, err := h.Open(tTok, "nadie-nayive-test", "pw", 80, 24); err == nil || !strings.Contains(err.Error(), "no account") {
		t.Errorf("unknown account: %v", err)
	}
	// Another host key in sshd's place: no password goes out.
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	ok, _ := ssh.NewSignerFromKey(other)
	h.hostKeys = func() ([]sshHostKey, error) { return []sshHostKey{ok.PublicKey()}, nil }
	if _, err := h.Open(tTok, "ana", "pw", 80, 24); err == nil || !strings.Contains(err.Error(), "key") {
		t.Errorf("unknown host key: %v", err)
	}
	// An sshd that takes keys only says so.
	h2 := hubWithSSHD(t, false)
	if _, err := h2.Open(tTok, "ana", "pw", 80, 24); err != errSSHNoPass {
		t.Errorf("key-only sshd: %v, want errSSHNoPass", err)
	}
	if _, err := h.Open(tTok, "ana bad", "pw", 80, 24); err == nil {
		t.Error("a username with a space went through")
	}
}

func TestSSHTermOneAtATimeAndLimits(t *testing.T) {
	h := hubWithSSHD(t, true)
	a, err := h.Open(tTok, "ana", "pw", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	b, err := h.Open(tTok, "ana", "pw", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if r := a.read(0, nil); r.Ended == "" {
		t.Error("the first session lives on beside the second")
	}
	if h.checkLimits(b, time.Now()) {
		t.Fatal("a fresh session was ended")
	}
	if !h.checkLimits(b, time.Now().Add(sshIdle+time.Second)) {
		t.Error("15 minutes idle did not end it")
	}
	c, _ := h.Open(tTok, "ana", "pw", 80, 24)
	c.lastIn = time.Now().Add(sshMaxLife) // typing all along
	if !h.checkLimits(c, time.Now().Add(sshMaxLife+time.Second)) {
		t.Error("2 hours did not end it")
	}
	d, _ := h.Open(tTok, "ana", "pw", 80, 24)
	h.alive = func(string) bool { return false }
	if !h.checkLimits(d, time.Now()) {
		t.Error("signing out did not end it")
	}
}

func TestSSHTermOutputCap(t *testing.T) {
	tm := &sshTerm{wake: make(chan struct{})}
	chunk := strings.Repeat("x", 100<<10)
	for i := 0; i < 8; i++ {
		tm.Write([]byte(chunk))
	}
	if len(tm.out) > sshKeepOut {
		t.Errorf("kept %d bytes, cap %d", len(tm.out), sshKeepOut)
	}
	r := tm.read(0, nil) // fell behind: starts at the oldest kept byte
	if r.Next != 800<<10 || len(r.Data) != sshKeepOut {
		t.Errorf("next %d, data %d", r.Next, len(r.Data))
	}
}

func TestSSHDPortFromConfig(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sshd_config")
	os.WriteFile(p, []byte("# x\nPermitRootLogin no\nPort 2222\nMatch User x\n  Port 1\n"), 0o644)
	if got := sshdPort(p); got != "2222" {
		t.Errorf("port = %q", got)
	}
	os.WriteFile(p, []byte("Match Address 127.0.0.1\n  Port 5\n"), 0o644)
	if got := sshdPort(p); got != "" {
		t.Errorf("a Match block's port was taken: %q", got)
	}
}

// -- the routes -----------------------------------------------------------------

func TestSSHRoutesAdminAndOrigin(t *testing.T) {
	post := func(client *http.Client, base, path, origin string) int {
		h := map[string]string{"Content-Type": "application/json"}
		if origin != "" {
			h["Origin"] = origin
		}
		resp := do(t, client, "POST", base+path, strings.NewReader(`{}`), h)
		resp.Body.Close()
		return resp.StatusCode
	}
	_, ts, user := newTestServer(t)
	if c := post(user, ts.URL, "/api/ssh/setup", ts.URL); c != http.StatusUnauthorized {
		t.Errorf("no session: %d", c)
	}
	signIn(t, user, ts.URL, "ana", "abc")
	if c := post(user, ts.URL, "/api/ssh/setup", ts.URL); c != http.StatusForbidden {
		t.Errorf("a plain user: %d, want 403", c)
	}

	_, ts, admin := newTestServer(t)
	signIn(t, admin, ts.URL, "jefe", "secreto")
	if c := post(admin, ts.URL, "/api/ssh/setup", ""); c != http.StatusForbidden {
		t.Errorf("no Origin: %d, want 403", c)
	}
	if c := post(admin, ts.URL, "/api/ssh/setup", "https://evil.test"); c != http.StatusForbidden {
		t.Errorf("another Origin: %d, want 403", c)
	}
	if c := post(admin, ts.URL, "/api/ssh/setup", ts.URL); c != http.StatusOK {
		t.Errorf("admin, own Origin: %d, want 200", c)
	}
	if c := post(admin, ts.URL, "/api/ssh/open", ts.URL); c != http.StatusBadRequest {
		t.Errorf("open with no ticket: %d, want 400", c)
	}
}

// TestSSHOverHTTP: the whole path through the real routes - passkey setup and
// confirm, open, type, read the echo, resize, close; another login sees nothing.
func TestSSHOverHTTP(t *testing.T) {
	srv, ts, admin := newTestServer(t)
	addr, key := fakeSSHD(t, true)
	srv.ssh.dialAddr = func() string { return addr }
	srv.ssh.hostKeys = func() ([]sshHostKey, error) { return []sshHostKey{key}, nil }
	signIn(t, admin, ts.URL, "jefe", "secreto")

	origin := ts.URL
	rp := strings.TrimPrefix(origin, "http://")
	rp, _, _ = net.SplitHostPort(rp)
	call := func(c *http.Client, method, path string, body any, out any) int {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = strings.NewReader(string(b))
		}
		resp := do(t, c, method, ts.URL+"/api/ssh/"+path, rd,
			map[string]string{"Content-Type": "application/json", "Origin": origin})
		defer resp.Body.Close()
		if out != nil {
			json.NewDecoder(resp.Body).Decode(out)
		}
		return resp.StatusCode
	}

	// The first passkey, with the setup code read from its file.
	var setup struct{ File string }
	if c := call(admin, "POST", "setup", map[string]any{}, &setup); c != 200 {
		t.Fatalf("setup = %d", c)
	}
	raw, _ := os.ReadFile(setup.File)
	code := strings.TrimSpace(string(raw))
	f := newFakeKey(t)
	var b passkeyBegin
	if c := call(admin, "POST", "begin", map[string]any{"mode": "create", "code": code}, &b); c != 200 {
		t.Fatalf("begin create = %d", c)
	}
	cd := clientDataJSON("webauthn.create", b.Challenge, origin)
	var tk struct{ Ticket, Error string }
	call(admin, "POST", "register", map[string]any{
		"code": code, "id": b64u(f.id), "client_data": b64u(cd),
		"auth_data": b64u(f.authData(rp, true)), "key": b64u(f.spki(t)), "alg": coseES256,
	}, &tk)
	if tk.Ticket == "" {
		t.Fatalf("register: %s", tk.Error)
	}

	// Confirm, open.
	if c := call(admin, "POST", "begin", map[string]any{"mode": "get"}, &b); c != 200 {
		t.Fatalf("begin get = %d", c)
	}
	cd = clientDataJSON("webauthn.get", b.Challenge, origin)
	f.count++
	ad := f.authData(rp, false)
	tk.Ticket = ""
	call(admin, "POST", "confirm", map[string]any{
		"id": b64u(f.id), "client_data": b64u(cd), "auth_data": b64u(ad), "signature": b64u(f.sign(t, ad, cd)),
	}, &tk)
	if tk.Ticket == "" {
		t.Fatalf("confirm: %s", tk.Error)
	}
	var opened struct{ ID, Error string }
	call(admin, "POST", "open", map[string]any{"ticket": tk.Ticket, "user": "ana", "password": "pw", "cols": 100, "rows": 30}, &opened)
	if opened.ID == "" {
		t.Fatalf("open: %s", opened.Error)
	}
	// The ticket is spent.
	if c := call(admin, "POST", "open", map[string]any{"ticket": tk.Ticket, "user": "ana", "password": "pw"}, nil); c != 400 {
		t.Errorf("second open on one ticket = %d, want 400", c)
	}

	// Type, read the echo.
	if c := call(admin, "POST", "write", map[string]any{"id": opened.ID, "data": "héllo"}, nil); c != 200 {
		t.Fatalf("write = %d", c)
	}
	var got string
	var from int64
	for i := 0; i < 10 && !strings.Contains(got, "héllo"); i++ {
		var r sshRead
		call(admin, "GET", "read?id="+opened.ID+"&from="+strconv.FormatInt(from, 10), nil, &r)
		got += string(r.Data)
		from = r.Next
	}
	if !strings.Contains(got, "$ ") || !strings.Contains(got, "héllo") {
		t.Fatalf("read = %q", got)
	}
	if c := call(admin, "POST", "resize", map[string]any{"id": opened.ID, "cols": 120, "rows": 40}, nil); c != 200 {
		t.Errorf("resize = %d", c)
	}

	// Another admin login cannot reach it.
	other := noFollow()
	signIn(t, other, ts.URL, "jefe", "secreto")
	if c := call(other, "POST", "write", map[string]any{"id": opened.ID, "data": "x"}, nil); c != http.StatusGone {
		t.Errorf("write from another login = %d, want 410", c)
	}
	var r sshRead
	call(other, "GET", "read?id="+opened.ID, nil, &r)
	if r.Ended == "" || len(r.Data) != 0 {
		t.Errorf("read from another login = %+v", r)
	}

	// Close.
	if c := call(admin, "POST", "close", map[string]any{"id": opened.ID}, nil); c != 200 {
		t.Errorf("close = %d", c)
	}
	if c := call(admin, "POST", "write", map[string]any{"id": opened.ID, "data": "x"}, nil); c != http.StatusGone {
		t.Errorf("write after close = %d, want 410", c)
	}
}

func TestSSHLocalAccounts(t *testing.T) {
	old := sshPasswdFile
	defer func() { sshPasswdFile = old }()
	sshPasswdFile = filepath.Join(t.TempDir(), "passwd")
	me, _ := user.Current()
	os.WriteFile(sshPasswdFile, []byte(strings.Join([]string{
		"root:x:0:0:root:/root:/bin/bash",
		"daemon:x:1:1::/usr/sbin:/usr/sbin/nologin",
		"ana:x:1001:1001:Ana:/home/ana:/bin/bash",
		"svc:x:1002:1002::/srv:/usr/sbin/nologin",
		"nobody:x:65534:65534::/nonexistent:/bin/sh",
		me.Username + ":x:1000:1000::/home/me:/bin/zsh",
		"broken line",
	}, "\n")), 0o644)
	got := sshLocalAccounts()
	if got.RunsAs != me.Username || strings.Join(got.Accounts, ",") != me.Username+",ana" {
		t.Errorf("accounts = %+v", got)
	}
}
