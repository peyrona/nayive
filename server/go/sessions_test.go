package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func quietLog() Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// TestSessionsSurviveRestart: what one run signed in, the next one still knows
// - and the file alone could not sign anybody in.
func TestSessionsSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	a := NewSessionStore(time.Hour, dir, quietLog())
	tok := a.Create("ana", "user", 30*24*time.Hour, true)
	plain := a.Create("luis", "user", time.Hour, false)
	a.Get(tok)
	a.Flush()

	raw, err := os.ReadFile(filepath.Join(dir, "sessions.json"))
	if err != nil {
		t.Fatalf("sessions.json: %v", err)
	}
	if strings.Contains(string(raw), tok) || strings.Contains(string(raw), plain) {
		t.Errorf("a token reached the disk: %s", raw)
	}
	if info, _ := os.Stat(filepath.Join(dir, "sessions.json")); info.Mode().Perm() != 0o600 {
		t.Errorf("sessions.json mode = %v, want 0600", info.Mode().Perm())
	}

	b := NewSessionStore(time.Hour, dir, quietLog())
	if s, ok := b.Get(tok); !ok || s.User != "ana" || s.Role != "user" {
		t.Errorf("after a restart Get = %v, %v", s, ok)
	}
	if ttl, ok := b.Remembered(tok); !ok || ttl != 30*24*time.Hour {
		t.Errorf("Remembered = %v, %v; want 720h, true", ttl, ok)
	}
	if _, ok := b.Remembered(plain); ok {
		t.Error("a plain sign-in came back as remembered")
	}
	if _, ok := b.Get("not-a-token"); ok {
		t.Error("an unknown token was accepted")
	}
}

// TestSessionsExpiredStayOut: a session that ran out while the server was down
// is not brought back.
func TestSessionsExpiredStayOut(t *testing.T) {
	dir := t.TempDir()
	body := `{"sessions":[
		{"hash":"` + tokenHash("vivo") + `","user":"ana","role":"user","ttl":3600,"expires":` +
		jsonInt(time.Now().Add(time.Hour).Unix()) + `},
		{"hash":"` + tokenHash("muerto") + `","user":"ana","role":"user","ttl":3600,"expires":` +
		jsonInt(time.Now().Add(-time.Minute).Unix()) + `},
		{"hash":"` + tokenHash("raro") + `","user":"ana","role":"root","ttl":3600,"expires":` +
		jsonInt(time.Now().Add(time.Hour).Unix()) + `}]}`
	os.WriteFile(filepath.Join(dir, "sessions.json"), []byte(body), 0o600)

	s := NewSessionStore(time.Hour, dir, quietLog())
	if _, ok := s.Get("vivo"); !ok {
		t.Error("a live session was lost")
	}
	if _, ok := s.Get("muerto"); ok {
		t.Error("an expired session came back")
	}
	if _, ok := s.Get("raro"); ok {
		t.Error("a row with an unknown role was loaded")
	}
}

// TestSessionsSignOutReachesDisk: a sign-out, and a deleted account, are
// written at once - a restart must not undo them.
func TestSessionsSignOutReachesDisk(t *testing.T) {
	dir := t.TempDir()
	a := NewSessionStore(time.Hour, dir, quietLog())
	out := a.Create("ana", "user", time.Hour, false)
	gone1 := a.Create("luis", "user", time.Hour, false)
	gone2 := a.Create("luis", "user", time.Hour, true)
	kept := a.Create("eva", "user", time.Hour, false)
	a.Drop(out)
	a.DropUser("luis")

	b := NewSessionStore(time.Hour, dir, quietLog())
	for _, tok := range []string{out, gone1, gone2} {
		if _, ok := b.Get(tok); ok {
			t.Error("a dropped session came back after a restart")
		}
	}
	if _, ok := b.Get(kept); !ok {
		t.Error("an untouched session was lost")
	}
}

// TestSessionsSlideReachesDisk: the sliding expiry is written by the sweep once
// sessionSaveEvery has passed, not on every request.
func TestSessionsSlideReachesDisk(t *testing.T) {
	old := sessionSaveEvery
	sessionSaveEvery = time.Hour
	t.Cleanup(func() { sessionSaveEvery = old })

	dir := t.TempDir()
	path := filepath.Join(dir, "sessions.json")
	s := NewSessionStore(time.Hour, dir, quietLog())
	tok := s.Create("ana", "user", time.Hour, false)
	before, _ := os.ReadFile(path)

	time.Sleep(1100 * time.Millisecond) // the file keeps whole seconds
	s.Get(tok)
	s.Sweep()
	if now, _ := os.ReadFile(path); string(now) != string(before) {
		t.Error("the sweep wrote a slide before sessionSaveEvery")
	}

	sessionSaveEvery = 0
	s.Sweep()
	if now, _ := os.ReadFile(path); string(now) == string(before) {
		t.Error("the sweep did not write the slide")
	}
}

// TestSessionsBrokenFileSetAside: an unreadable file signs everyone out, and is
// moved aside rather than written over.
func TestSessionsBrokenFileSetAside(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sessions.json")
	os.WriteFile(path, []byte("{no es json"), 0o600)

	s := NewSessionStore(time.Hour, dir, quietLog())
	if s.Count() != 0 {
		t.Fatalf("Count = %d, want 0", s.Count())
	}
	s.Create("ana", "user", time.Hour, false)

	aside, _ := filepath.Glob(path + ".broken-*")
	if len(aside) != 1 {
		t.Fatalf("set aside: %v", aside)
	}
	if raw, _ := os.ReadFile(aside[0]); string(raw) != "{no es json" {
		t.Errorf("the broken file was changed: %q", raw)
	}
	var file sessionsFile
	if raw, _ := os.ReadFile(path); json.Unmarshal(raw, &file) != nil || len(file.Sessions) != 1 {
		t.Errorf("the new sessions.json is wrong: %s", raw)
	}
}

// TestWhoamiRenewsRememberedCookie: "Mantenme conectado" is counted again from
// every page load; a plain sign-in keeps its browser-session cookie.
func TestWhoamiRenewsRememberedCookie(t *testing.T) {
	_, ts, client := newTestServer(t)

	resp := do(t, client, "POST", ts.URL+"/api/login",
		strings.NewReader(`{"user":"ana","password":"abc","remember":true}`),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()

	resp = do(t, client, "GET", ts.URL+"/api/whoami", nil, nil)
	resp.Body.Close()
	raw := resp.Header.Get("Set-Cookie")
	if !strings.Contains(raw, CookieName+"=") || !strings.Contains(raw, "Max-Age=2592000") ||
		!strings.Contains(raw, "HttpOnly") {
		t.Errorf("whoami after a remembered sign-in: Set-Cookie %q", raw)
	}

	_, ts2, client2 := newTestServer(t)
	signIn(t, client2, ts2.URL, "ana", "abc")
	resp = do(t, client2, "GET", ts2.URL+"/api/whoami", nil, nil)
	resp.Body.Close()
	// Only the readable "nayive_who" (store_owner.go), never the session's.
	for _, raw := range resp.Header.Values("Set-Cookie") {
		if strings.HasPrefix(raw, CookieName+"=") {
			t.Errorf("whoami after a plain sign-in set the session cookie: %q", raw)
		}
	}
}

// TestPasswordChangeKeepsRemember: changing the password on a phone signed in
// with "Mantenme conectado" keeps it signed in for as long as before.
func TestPasswordChangeKeepsRemember(t *testing.T) {
	_, ts, client := newTestServer(t)
	resp := do(t, client, "POST", ts.URL+"/api/login",
		strings.NewReader(`{"user":"ana","password":"abc","remember":true}`),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()

	resp = do(t, client, "POST", ts.URL+"/api/password",
		strings.NewReader(`{"current":"abc","new":"nueva"}`),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("password change = %d", resp.StatusCode)
	}
	if raw := resp.Header.Get("Set-Cookie"); !strings.Contains(raw, "Max-Age=2592000") {
		t.Errorf("after the change: Set-Cookie %q, want the remembered Max-Age", raw)
	}
	resp = do(t, client, "GET", ts.URL+"/api/whoami", nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("whoami after the change = %d", resp.StatusCode)
	}
}

func jsonInt(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
