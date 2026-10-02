package main

// Data-safety seal (cleanup Phase 3, batch S8): a right password is never
// refused.
//
// A data-safety run once failed with "login test: 401" at its harness's
// first sign-in, on a loaded machine. Suspect: an account whose password is
// still stored as typed is re-stored hashed at its first good sign-in
// (Users.Authenticate), and two sign-ins at once - a phone and a browser -
// might read the file half way through that rewrite and refuse the right
// password: an account locked out by its own first sign-in.
//
// It is not so: the sign-ins of one name take turns (authThrottle holds the
// name across the check), the rewrite is a compare-and-set under cfgMu, and
// config.json is replaced by rename, never written in place - a reader sees
// the old file or the new one. The 401 came from the harness, whose server
// had lost its port to another one on the machine (tools/data-safety-test/
// lib.mjs: server() now knows its own). These tests keep it that way.

import (
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// TestDS_Login_ParallelFirstSignInsAllPass: many first sign-ins at once of
// an account and of the admin, both stored as typed, through the real route:
// every one answers 200, and the passwords end up hashed and still right.
func TestDS_Login_ParallelFirstSignInsAllPass(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	path := srv.users.cfgPath("ana")
	if stored := readUserConfig(path).Password; isHashedPassword(stored) {
		t.Fatalf("the fixture must start with a password stored as typed, got %q", stored)
	}

	const n = 8
	var wg sync.WaitGroup
	codes := make(chan string, 2*n)
	login := func(user, password string) {
		defer wg.Done()
		resp := do(t, noFollow(), "POST", ts.URL+"/api/login",
			strings.NewReader(`{"user":"`+user+`","password":"`+password+`"}`),
			map[string]string{"Content-Type": "application/json"})
		resp.Body.Close()
		codes <- user + " " + strconv.Itoa(resp.StatusCode)
	}
	for i := 0; i < n; i++ {
		wg.Add(2)
		go login("ana", "abc")
		go login("jefe", "secreto")
	}
	wg.Wait()
	close(codes)
	for c := range codes {
		if !strings.HasSuffix(c, " 200") {
			t.Errorf("a sign-in with the right password at the same time as others: %s", c)
		}
	}

	if stored := readUserConfig(path).Password; !isHashedPassword(stored) {
		t.Errorf("ana's password is still stored as typed: %q", stored)
	}
	var admin string
	srv.cfg.Read(func(c *ServerConfig) { admin = c.Admin.Password })
	if !isHashedPassword(admin) {
		t.Errorf("the admin's password is still stored as typed")
	}
	signIn(t, noFollow(), ts.URL, "ana", "abc")
	signIn(t, noFollow(), ts.URL, "jefe", "secreto")
	resp := do(t, noFollow(), "POST", ts.URL+"/api/login", strings.NewReader(`{"user":"ana","password":"abd"}`),
		map[string]string{"Content-Type": "application/json"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("a wrong password after the rehash = %d, want 401", resp.StatusCode)
	}
}

// TestDS_Login_CheckWhileTheFileIsRewritten: the password check itself, from
// many goroutines at once with no throttle in front (the locker's unlock and
// the sign-in share it), while other settings rewrite the same config.json
// and the first good check re-stores the password hashed: never a refusal.
func TestDS_Login_CheckWhileTheFileIsRewritten(t *testing.T) {
	users, _, _ := newTestUsers(t)

	const n = 16
	var wg sync.WaitGroup
	refused := make(chan int, n)
	stop := make(chan struct{})
	var writers sync.WaitGroup
	writers.Add(2)
	go func() { // the language and the bin days, changed over and over meanwhile
		defer writers.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			users.SetUserLang("user", "ana", []string{"es", "en"}[i%2])
		}
	}()
	go func() {
		defer writers.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			users.SetUserTrashDays("user", "ana", strconv.Itoa(10+i%20))
		}
	}()
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for k := 0; k < 2; k++ {
				if users.Authenticate("ana", "abc") != "user" {
					refused <- i
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(stop)
	writers.Wait()
	close(refused)
	for i := range refused {
		t.Errorf("check %d refused the right password while the file was rewritten", i)
	}
	if stored := readUserConfig(users.cfgPath("ana")).Password; !isHashedPassword(stored) {
		t.Errorf("the password is still stored as typed: %q", stored)
	}
	if lang := users.UserLang("user", "ana"); lang == nil {
		t.Errorf("the language written meanwhile is gone")
	}
	if _, err := os.Stat(users.cfgPath("ana")); err != nil {
		t.Fatalf("config.json: %v", err)
	}
}
