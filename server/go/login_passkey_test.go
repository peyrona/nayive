package main

// Sign in with a passkey (login_passkey.go), over HTTP, with the fake phone
// of ssh_test.go (fakeKey).

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// pkCall calls /api/passkey/<path> as a page of this server would.
func pkCall(t *testing.T, c *http.Client, base, method, path string, body, out any) int {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	}
	resp := do(t, c, method, base+"/api/passkey/"+path, rd,
		map[string]string{"Content-Type": "application/json", "Origin": base})
	defer resp.Body.Close()
	if out != nil {
		json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

// pkAdd adds `f` to the signed-in account of `c`.
func pkAdd(t *testing.T, c *http.Client, base, password string, f *fakeKey) int {
	t.Helper()
	var b struct {
		Challenge string
		UserID    string `json:"user_id"`
	}
	if code := pkCall(t, c, base, "POST", "add-begin", map[string]any{"password": password}, &b); code != 200 {
		return code
	}
	if b.UserID == "" {
		t.Fatal("add-begin gave no user id")
	}
	host := strings.Split(strings.TrimPrefix(base, "http://"), ":")[0]
	cd := clientDataJSON("webauthn.create", b.Challenge, base)
	return pkCall(t, c, base, "POST", "add", map[string]any{
		"name": "Phone", "id": b64u(f.id), "client_data": b64u(cd),
		"auth_data": b64u(f.authData(host, true)), "key": b64u(f.spki(t)), "alg": coseES256,
	}, nil)
}

// pkLogin signs a fresh browser in with `f`; tweak may spoil the answer.
func pkLogin(t *testing.T, base string, f *fakeKey, handle string,
	tweak func(nonce *string, cd, ad *[]byte)) (*http.Client, int, map[string]any) {
	t.Helper()
	c := noFollow()
	var b struct{ Nonce, Challenge string }
	if code := pkCall(t, c, base, "POST", "login-begin", map[string]any{}, &b); code != 200 {
		t.Fatalf("login-begin = %d", code)
	}
	host := strings.Split(strings.TrimPrefix(base, "http://"), ":")[0]
	cd := clientDataJSON("webauthn.get", b.Challenge, base)
	ad := f.authData(host, false)
	nonce := b.Nonce
	if tweak != nil {
		tweak(&nonce, &cd, &ad)
	}
	var out map[string]any
	code := pkCall(t, c, base, "POST", "login", map[string]any{
		"nonce": nonce, "id": b64u(f.id), "client_data": b64u(cd), "auth_data": b64u(ad),
		"signature": b64u(f.sign(t, ad, cd)), "user_handle": handle, "remember": true,
	}, &out)
	return c, code, out
}

func handleOf(t *testing.T, path string) string {
	t.Helper()
	lk, err := readLoginKeys(path)
	if err != nil || lk.Handle == "" {
		t.Fatalf("passkeys file %s: %v %+v", path, err, lk)
	}
	return lk.Handle
}

func TestPasskeyLoginUserAndAdmin(t *testing.T) {
	srv, ts, ana := newTestServer(t)
	signIn(t, ana, ts.URL, "ana", "abc")

	// No session, no add; a wrong password, no add.
	if code := pkCall(t, noFollow(), ts.URL, "POST", "add-begin", map[string]any{"password": "abc"}, nil); code != 401 {
		t.Errorf("add-begin with no session = %d, want 401", code)
	}
	f := newFakeKey(t)
	if code := pkAdd(t, ana, ts.URL, "wrong", f); code != 403 {
		t.Errorf("add with a wrong password = %d, want 403", code)
	}
	if code := pkAdd(t, ana, ts.URL, "abc", f); code != 200 {
		t.Fatalf("add = %d", code)
	}
	path := filepath.Join(srv.cfg.HomesDir, "ana", "data", "passkeys.json")
	if st, err := os.Stat(path); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("passkeys file: %v", err)
	}
	if code := pkAdd(t, ana, ts.URL, "abc", f); code != 400 {
		t.Errorf("same passkey twice = %d, want 400", code)
	}
	var keys struct{ Keys []factorInfo }
	pkCall(t, ana, ts.URL, "GET", "keys", nil, &keys)
	if len(keys.Keys) != 1 || keys.Keys[0].Name != "Phone" {
		t.Errorf("keys = %+v", keys)
	}

	// Sign in: no name typed, the passkey says who.
	c, code, out := pkLogin(t, ts.URL, f, handleOf(t, path), nil)
	if code != 200 || out["user"] != "ana" || out["role"] != "user" {
		t.Fatalf("login = %d %v", code, out)
	}
	var me map[string]any
	jsonCall(t, c, "GET", ts.URL+"/api/whoami", "", 200, &me)
	if me["user"] != "ana" {
		t.Errorf("whoami = %v", me)
	}

	// The admin's passkeys live in config/.
	jefe := noFollow()
	signIn(t, jefe, ts.URL, "jefe", "secreto")
	g := newFakeKey(t)
	if code := pkAdd(t, jefe, ts.URL, "secreto", g); code != 200 {
		t.Fatalf("admin add = %d", code)
	}
	apath := filepath.Join(srv.cfg.ConfigDir, "admin-passkeys.json")
	if _, code, out := pkLogin(t, ts.URL, g, handleOf(t, apath), nil); code != 200 || out["role"] != "admin" || out["user"] != "jefe" {
		t.Errorf("admin login = %d %v", code, out)
	}
}

func TestPasskeyLoginRefusals(t *testing.T) {
	srv, ts, ana := newTestServer(t)
	signIn(t, ana, ts.URL, "ana", "abc")
	f := newFakeKey(t)
	if code := pkAdd(t, ana, ts.URL, "abc", f); code != 200 {
		t.Fatalf("add = %d", code)
	}
	handle := handleOf(t, filepath.Join(srv.cfg.HomesDir, "ana", "data", "passkeys.json"))

	cases := []struct {
		name  string
		tweak func(nonce *string, cd, ad *[]byte)
		want  int
	}{
		{"old nonce", func(n *string, cd, ad *[]byte) { *n = "nope" }, 400},
		{"other page", func(n *string, cd, ad *[]byte) {
			var m map[string]any
			json.Unmarshal(*cd, &m)
			m["origin"] = "https://evil.test"
			*cd, _ = json.Marshal(m)
		}, 401},
		{"other site", func(n *string, cd, ad *[]byte) { *ad = f.authData("evil.test", false) }, 401},
		{"no fingerprint", func(n *string, cd, ad *[]byte) { (*ad)[32] = adUP }, 401},
	}
	for _, tc := range cases {
		if _, code, _ := pkLogin(t, ts.URL, f, handle, tc.tweak); code != tc.want {
			t.Errorf("%s = %d, want %d", tc.name, code, tc.want)
		}
	}
	if _, code, _ := pkLogin(t, ts.URL, f, "AAAA", nil); code != 401 {
		t.Errorf("wrong user handle = %d, want 401", code)
	}
	if _, code, _ := pkLogin(t, ts.URL, newFakeKey(t), "", nil); code != 401 {
		t.Errorf("unknown passkey = %d, want 401", code)
	}

	// A bad signature: another key signs for f's id.
	{
		c := noFollow()
		var b struct{ Nonce, Challenge string }
		pkCall(t, c, ts.URL, "POST", "login-begin", map[string]any{}, &b)
		cd := clientDataJSON("webauthn.get", b.Challenge, ts.URL)
		ad := f.authData("127.0.0.1", false)
		code := pkCall(t, c, ts.URL, "POST", "login", map[string]any{
			"nonce": b.Nonce, "id": b64u(f.id), "client_data": b64u(cd), "auth_data": b64u(ad),
			"signature": b64u(newFakeKey(t).sign(t, ad, cd)),
		}, nil)
		if code != 401 {
			t.Errorf("bad signature = %d, want 401", code)
		}
	}

	// A nonce is good once.
	{
		c := noFollow()
		var b struct{ Nonce, Challenge string }
		pkCall(t, c, ts.URL, "POST", "login-begin", map[string]any{}, &b)
		cd := clientDataJSON("webauthn.get", b.Challenge, ts.URL)
		ad := f.authData("127.0.0.1", false)
		body := map[string]any{"nonce": b.Nonce, "id": b64u(f.id), "client_data": b64u(cd),
			"auth_data": b64u(ad), "signature": b64u(f.sign(t, ad, cd))}
		if code := pkCall(t, c, ts.URL, "POST", "login", body, nil); code != 200 {
			t.Fatalf("first use = %d", code)
		}
		if code := pkCall(t, c, ts.URL, "POST", "login", body, nil); code != 400 {
			t.Errorf("second use = %d, want 400", code)
		}
	}

	// An old nonce runs out.
	srv.loginPK.now = func() time.Time { return time.Now().Add(-confirmChallengeTTL - time.Second) }
	c := noFollow()
	var b struct{ Nonce string }
	pkCall(t, c, ts.URL, "POST", "login-begin", map[string]any{}, &b)
	srv.loginPK.now = time.Now
	if _, code, _ := pkLogin(t, ts.URL, f, handle, func(n *string, cd, ad *[]byte) { *n = b.Nonce }); code != 400 {
		t.Errorf("expired nonce = %d, want 400", code)
	}

	// A counter that goes back: a copied key.
	f.count = 5
	if _, code, _ := pkLogin(t, ts.URL, f, handle, nil); code != 200 {
		t.Fatalf("counter 5 = %d", code)
	}
	if _, code, _ := pkLogin(t, ts.URL, f, handle, nil); code != 401 {
		t.Errorf("counter 5 again = %d, want 401", code)
	}

	// No Origin header from this page: refused.
	resp := do(t, noFollow(), "POST", ts.URL+"/api/passkey/login-begin", strings.NewReader("{}"),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("no origin = %d, want 403", resp.StatusCode)
	}
}

func TestPasskeyRemoveAndRename(t *testing.T) {
	srv, ts, ana := newTestServer(t)
	signIn(t, ana, ts.URL, "ana", "abc")
	f := newFakeKey(t)
	if code := pkAdd(t, ana, ts.URL, "abc", f); code != 200 {
		t.Fatalf("add = %d", code)
	}
	handle := handleOf(t, filepath.Join(srv.cfg.HomesDir, "ana", "data", "passkeys.json"))

	// A rename moves the passkeys with the home.
	if err := srv.users.RenameAccount("ana", "anita"); err != "renamed" {
		t.Fatalf("rename: %s", err)
	}
	if _, code, out := pkLogin(t, ts.URL, f, handle, nil); code != 200 || out["user"] != "anita" {
		t.Fatalf("login after rename = %d %v", code, out)
	}

	anita := noFollow()
	signIn(t, anita, ts.URL, "anita", "abc")
	if code := pkCall(t, anita, ts.URL, "POST", "remove", map[string]any{"password": "wrong", "id": b64u(f.id)}, nil); code != 403 {
		t.Errorf("remove with a wrong password = %d, want 403", code)
	}
	if code := pkCall(t, anita, ts.URL, "POST", "remove", map[string]any{"password": "abc", "id": b64u(f.id)}, nil); code != 200 {
		t.Fatalf("remove = %d", code)
	}
	if _, code, _ := pkLogin(t, ts.URL, f, handle, nil); code != 401 {
		t.Errorf("login with a removed passkey = %d, want 401", code)
	}
}
