package main

// Data-safety seal (cleanup Phase 3, batch S3): an admin rename or delete
// never leaks or strands anyone's data (L1 L2 L3).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// heldMailAccounts is how many eMail accounts the hub holds under `name`.
func heldMailAccounts(h *MailHub, name string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	if u := h.owners[name]; u != nil {
		return len(u.accts)
	}
	return 0
}

// firstMailAccount is the account a poll or purge under way holds.
func firstMailAccount(t *testing.T, h *MailHub, name string) *mailAcct {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.owners[name]
	if u == nil || len(u.accts) == 0 {
		t.Fatalf("the hub holds no account of %s", name)
	}
	return u.accts[0]
}

// adminCall is one POST /api/admin as the admin, expecting `want`.
func adminCall(t *testing.T, base, body string, want int) {
	t.Helper()
	admin := noFollow()
	signIn(t, admin, base, "jefe", "secreto")
	jsonCall(t, admin, "POST", base+"/api/admin", body, want, nil)
}

// mailAccountsOf signs `user` in and answers how many eMail accounts they see.
func mailAccountsOf(t *testing.T, base, user, password string) int {
	t.Helper()
	c := noFollow()
	signIn(t, c, base, user, password)
	var out struct {
		Accounts []map[string]any `json:"accounts"`
	}
	jsonCall(t, c, "GET", base+"/api/mail/accounts", "", http.StatusOK, &out)
	return len(out.Accounts)
}

// TestDS_L1_DeleteUserStopsMail: the admin deletes ana. The hub holds none of
// her accounts any more; a purge that was already under way for her neither
// re-creates homes/ana/ nor runs; and a NEW person called ana sees no
// mailboxes - never the old person's.
func TestDS_L1_DeleteUserStopsMail(t *testing.T) {
	f := newMailFixture(t)
	f.addAccount(t, mailTestPass, http.StatusOK)
	acct := firstMailAccount(t, f.srv.mail, "ana") // a purge under way holds it

	adminCall(t, f.base, `{"action":"delete-user","name":"ana"}`, http.StatusOK)
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	if n := heldMailAccounts(f.srv.mail, "ana"); n != 0 {
		t.Errorf("after delete-user the hub still holds %d account(s) of ana: the poller and purge go on", n)
	}

	_, err := f.srv.mail.purgeAccount(context.Background(), "ana", acct, false)
	if _, serr := os.Stat(home); serr == nil {
		t.Fatalf("a purge for the deleted ana re-created her home (err=%v)", err)
	}
	if err == nil {
		t.Errorf("a purge for the deleted ana ran")
	}

	adminCall(t, f.base, `{"action":"create-user","name":"ana","password":"nueva"}`, http.StatusOK)
	if n := mailAccountsOf(t, f.base, "ana", "nueva"); n != 0 {
		t.Fatalf("the NEW ana sees %d eMail account(s): the deleted person's mailboxes", n)
	}
}

// TestDS_L1_RenameUserMovesMail: the admin renames ana to ana2. Her accounts
// answer under ana2; a purge under way for "ana" writes no ghost homes/ana/;
// and a new person later called ana sees no mailboxes.
func TestDS_L1_RenameUserMovesMail(t *testing.T) {
	f := newMailFixture(t)
	f.addAccount(t, mailTestPass, http.StatusOK)
	acct := firstMailAccount(t, f.srv.mail, "ana")

	adminCall(t, f.base, `{"action":"rename-user","name":"ana","new_name":"ana2"}`, http.StatusOK)
	if n := heldMailAccounts(f.srv.mail, "ana"); n != 0 {
		t.Errorf("after the rename the hub still holds %d account(s) under the old name", n)
	}

	f.srv.mail.purgeAccount(context.Background(), "ana", acct, false)
	if _, err := os.Stat(filepath.Join(f.srv.cfg.HomesDir, "ana")); err == nil {
		t.Fatalf("a purge for the old name re-created homes/ana/ (a ghost home)")
	}

	if n := mailAccountsOf(t, f.base, "ana2", "abc"); n != 1 {
		t.Fatalf("ana2 sees %d eMail account(s), want her 1", n)
	}
	if heldMailAccounts(f.srv.mail, "ana2") != 1 || firstMailAccount(t, f.srv.mail, "ana2") != acct {
		t.Errorf("ana2's account is not the one the hub held (connection lost)")
	}

	adminCall(t, f.base, `{"action":"create-user","name":"ana","password":"nueva"}`, http.StatusOK)
	if n := mailAccountsOf(t, f.base, "ana", "nueva"); n != 0 {
		t.Fatalf("the NEW ana sees %d eMail account(s): the renamed person's mailboxes", n)
	}
	if n := mailAccountsOf(t, f.base, "ana2", "abc"); n != 1 {
		t.Fatalf("after a new ana came, ana2 sees %d eMail account(s), want 1", n)
	}
}

// TestDS_L1_FailedRenameKeepsMail: a rename that does not happen leaves the
// hub exactly as it was.
func TestDS_L1_FailedRenameKeepsMail(t *testing.T) {
	f := newMailFixture(t)
	f.addAccount(t, mailTestPass, http.StatusOK)
	acct := firstMailAccount(t, f.srv.mail, "ana")

	f.srv.mail.BeginRename("ana")("")
	if heldMailAccounts(f.srv.mail, "ana") != 1 || firstMailAccount(t, f.srv.mail, "ana") != acct {
		t.Fatalf("a rename that failed lost ana's mail")
	}
	if n := mailAccountsOf(t, f.base, "ana", "abc"); n != 1 {
		t.Fatalf("ana sees %d eMail account(s), want 1", n)
	}
}

// TestDS_L2_WriteAfterRenameNoGhostHome: a save let in just before the admin
// renamed the account (TestSW4). Its write must not re-create homes/ana/ -
// it fails, and the browser keeps the save.
func TestDS_L2_WriteAfterRenameNoGhostHome(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	target, ok := users.Resolve("user", "ana", "files/nota.txt")
	if !ok {
		t.Fatal("resolve")
	}
	if got := users.RenameAccount("ana", "ana2"); got != "renamed" {
		t.Fatalf("rename: %s", got)
	}
	if root, err := target.openCreating(); err == nil {
		root.Close()
		t.Errorf("a write resolved before the rename opened a root")
	}
	if err := target.MkdirParent(); err == nil {
		t.Errorf("a mkdir resolved before the rename succeeded")
	}
	if _, err := os.Stat(filepath.Join(cfg.HomesDir, "ana")); err == nil {
		t.Fatalf("homes/ana/ came back after the rename (a ghost home); ListUserNames = %v", users.ListUserNames())
	}
}

// TestDS_L2_DeleteThenNewUserNoLeak: a request let in before the admin
// deleted ana, and a new person called ana since. It must neither write into
// nor read from the new person's home.
func TestDS_L2_DeleteThenNewUserNoLeak(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	target, ok := users.Resolve("user", "ana", "files/mio.txt")
	if !ok {
		t.Fatal("resolve")
	}
	os.RemoveAll(filepath.Join(cfg.HomesDir, "ana")) // delete-user
	create := false
	if got := users.SaveAccount("ana", SaveAccountOptions{Password: "nueva", MustExist: &create}); got != "created" {
		t.Fatalf("create: %s", got)
	}
	os.WriteFile(filepath.Join(cfg.HomesDir, "ana", "files", "mio.txt"), []byte("de la nueva\n"), 0o644)

	if root, err := target.openCreating(); err == nil {
		root.Close()
		t.Errorf("the old person's write opened the new person's home")
	}
	if f, err := target.Open(); err == nil {
		f.Close()
		t.Errorf("the old person's read opened the new person's file")
	}
}

// TestDS_L2_OpenBeforeRenameLandsInRenamedHome: a write that had its folder
// open when the admin renamed the account finishes in the renamed home.
func TestDS_L2_OpenBeforeRenameLandsInRenamedHome(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	target, _ := users.Resolve("user", "ana", "files/nota.txt")
	root, err := target.openCreating()
	if err != nil {
		t.Fatalf("openCreating: %v", err)
	}
	defer root.Close()
	if got := users.RenameAccount("ana", "ana2"); got != "renamed" {
		t.Fatalf("rename: %s", got)
	}
	if err := root.WriteFile(target.Rel, []byte("la edición\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cfg.HomesDir, "ana2", "files", "nota.txt")); err != nil {
		t.Fatalf("the write is not in the renamed home: %v", err)
	}
}

// TestDS_L2_SignInNeverMakesHome: a sign-in whose password check ran just
// before a rename or delete must not bring the home back.
func TestDS_L2_SignInNeverMakesHome(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.ensureHome("ana0") // renamed or deleted a moment ago
	if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana0")); err == nil {
		t.Fatalf("a sign-in re-created a home that is gone")
	}
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	os.RemoveAll(files)
	srv.ensureHome("ana")
	if _, err := os.Stat(files); err != nil {
		t.Fatalf("a sign-in no longer makes files/ in a home that is there: %v", err)
	}
}

// whoamiOf signs `user` in and answers whoami's "renamed" (nil when absent)
// and the nayive_was cookie the sign-in and whoami set ("-" = none set,
// "" = cleared).
func whoamiOf(t *testing.T, c *http.Client, base, user, password string) (map[string]any, string, string) {
	t.Helper()
	was := func(resp *http.Response) string {
		for _, line := range resp.Header.Values("Set-Cookie") {
			if v, ok := strings.CutPrefix(line, WasCookieName+"="); ok {
				return strings.SplitN(v, ";", 2)[0]
			}
		}
		return "-"
	}
	resp := do(t, c, "POST", base+"/api/login",
		strings.NewReader(`{"user":"`+user+`","password":"`+password+`"}`),
		map[string]string{"Content-Type": "application/json"})
	readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sign-in as %s: %d", user, resp.StatusCode)
	}
	atLogin := was(resp)
	resp = do(t, c, "GET", base+"/api/whoami", nil, nil)
	raw := readBody(t, resp)
	var me struct {
		Renamed map[string]any `json:"renamed"`
	}
	if err := json.Unmarshal([]byte(raw), &me); err != nil {
		t.Fatalf("whoami: %v: %s", err, raw)
	}
	return me.Renamed, atLogin, was(resp)
}

// TestDS_L3_WhoamiTellsOldNames: after ana -> ana2 -> ana3 the account's
// pages learn both old names (whoami and the nayive_was cookie, at sign-in
// too), escaped as nayive_who is; the table outlives a restart.
func TestDS_L3_WhoamiTellsOldNames(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	adminCall(t, ts.URL, `{"action":"rename-user","name":"ana","new_name":"ana2"}`, http.StatusOK)

	renamed, atLogin, atWhoami := whoamiOf(t, noFollow(), ts.URL, "ana2", "abc")
	want := map[string]any{"who": "user:ana2", "from": []any{"user:ana"}}
	if !reflect.DeepEqual(renamed, want) {
		t.Fatalf("whoami renamed = %v, want %v", renamed, want)
	}
	if atLogin != "user:ana2/user:ana" || atWhoami != "user:ana2/user:ana" {
		t.Fatalf("nayive_was at sign-in %q, at whoami %q", atLogin, atWhoami)
	}

	adminCall(t, ts.URL, `{"action":"rename-user","name":"ana2","new_name":"José"}`, http.StatusOK)
	renamed, _, atWhoami = whoamiOf(t, noFollow(), ts.URL, "José", "abc")
	want = map[string]any{"who": "user:Jos%C3%A9", "from": []any{"user:ana", "user:ana2"}}
	if !reflect.DeepEqual(renamed, want) || atWhoami != "user:Jos%C3%A9/user:ana/user:ana2" {
		t.Fatalf("after a second rename: renamed = %v, nayive_was %q", renamed, atWhoami)
	}
	if renamed["who"] != whoValue("user", "José") {
		t.Fatalf("who %v is not the nayive_who value %q", renamed["who"], whoValue("user", "José"))
	}

	again := NewUsers(srv.cfg, srv.shares, quietLog()) // a restart
	if got := again.RenamedFrom("José"); !reflect.DeepEqual(got, []string{"ana", "ana2"}) {
		t.Fatalf("after a restart the old names are %v", got)
	}

	// beto was never renamed: nothing to say, and no cookie.
	renamed, atLogin, atWhoami = whoamiOf(t, noFollow(), ts.URL, "beto", "xyz")
	if renamed != nil || atLogin != "-" || atWhoami != "-" {
		t.Fatalf("beto: renamed = %v, nayive_was %q / %q", renamed, atLogin, atWhoami)
	}
}

// ownerCheck runs the save-owner check for a PUT tagged `tag` from the
// session of `user`, and answers whether it was taken.
func ownerCheck(srv *Server, tag, user string) (bool, int) {
	r, _ := http.NewRequest("PUT", "/api/files?file=data/tasks.json", nil)
	r.Header.Set(whoHeader, tag)
	w := httptest.NewRecorder()
	ok := srv.saveOwnerOK(w, r, "user", user)
	return ok, w.Code
}

// TestDS_L3_OldTagSaveTaken: a save queued under the old name, sent from the
// new name's session (a page loaded before the rename), is the account's own:
// taken, not 423 for ever. Another account's tag still gets 423.
func TestDS_L3_OldTagSaveTaken(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	adminCall(t, ts.URL, `{"action":"rename-user","name":"ana","new_name":"ana2"}`, http.StatusOK)

	if ok, code := ownerCheck(srv, "user:ana", "ana2"); !ok {
		t.Fatalf("a save tagged with the old name was refused (%d)", code)
	}
	if ok, _ := ownerCheck(srv, "user:ana2", "ana2"); !ok {
		t.Fatalf("a save tagged with the new name was refused")
	}
	if ok, code := ownerCheck(srv, "user:beto", "ana2"); ok || code != http.StatusLocked {
		t.Fatalf("another account's save: taken=%v code=%d, want 423", ok, code)
	}
	if ok, _ := ownerCheck(srv, "user:ana2", "beto"); ok {
		t.Fatalf("beto's session took a save of ana2's")
	}
}

// TestDS_L3_ReusedNameForgetsOldNames: once a NEW person has the old name,
// saves held under it are never the renamed account's (nor the other way
// round) - created by the panel, or by hand.
func TestDS_L3_ReusedNameForgetsOldNames(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	adminCall(t, ts.URL, `{"action":"rename-user","name":"ana","new_name":"ana2"}`, http.StatusOK)
	c := noFollow()
	if renamed, _, _ := whoamiOf(t, c, ts.URL, "ana2", "abc"); renamed == nil {
		t.Fatal("setup: no old name after the rename")
	}

	adminCall(t, ts.URL, `{"action":"create-user","name":"ana","password":"nueva"}`, http.StatusOK)
	// ana2's page loads again: its whoami says nothing and clears the cookie.
	resp := do(t, c, "GET", ts.URL+"/api/whoami", nil, nil)
	if raw := readBody(t, resp); strings.Contains(string(raw), "renamed") {
		t.Fatalf("ana2 still told of user:ana (a new person's name): %s", raw)
	}
	if v := strings.Join(resp.Header.Values("Set-Cookie"), " | "); !strings.Contains(v, WasCookieName+"=; ") {
		t.Fatalf("whoami did not clear the %s cookie ana2's browser holds: %s", WasCookieName, v)
	}
	if renamed, atLogin, _ := whoamiOf(t, noFollow(), ts.URL, "ana2", "abc"); renamed != nil || atLogin != "-" {
		t.Fatalf("a new sign-in of ana2 is told of old names: %v, nayive_was %q", renamed, atLogin)
	}
	if ok, _ := ownerCheck(srv, "user:ana", "ana2"); ok {
		t.Fatalf("ana2's session took a save of the NEW ana's")
	}
	if renamed, _, _ := whoamiOf(t, noFollow(), ts.URL, "ana", "nueva"); renamed != nil {
		t.Fatalf("the new ana is told of old names: %v", renamed)
	}
	if b, _ := os.ReadFile(filepath.Join(srv.cfg.ConfigDir, "renames.json")); strings.Contains(string(b), `"ana"`) {
		t.Errorf("renames.json still names ana: %s", b)
	}

	// By hand: beto -> beto2, then a homes/beto/ made over SSH.
	adminCall(t, ts.URL, `{"action":"rename-user","name":"beto","new_name":"beto2"}`, http.StatusOK)
	os.MkdirAll(filepath.Join(srv.cfg.HomesDir, "beto", "data"), 0o755)
	os.WriteFile(filepath.Join(srv.cfg.HomesDir, "beto", "data", "config.json"), []byte(`{"password":"p"}`), 0o644)
	if got := srv.users.RenamedFrom("beto2"); len(got) != 0 {
		t.Fatalf("beto2 still has old names %v after a new beto was made by hand", got)
	}
	if ok, _ := ownerCheck(srv, "user:beto", "beto2"); ok {
		t.Fatalf("beto2's session took a save of the hand-made beto's")
	}
}

// TestDS_L3_DeleteForgetsOldNames: ana -> ana2, ana2 deleted, a new person
// called ana2: they inherit no old names.
func TestDS_L3_DeleteForgetsOldNames(t *testing.T) {
	srv, ts, _ := newTestServer(t)
	adminCall(t, ts.URL, `{"action":"rename-user","name":"ana","new_name":"ana2"}`, http.StatusOK)
	adminCall(t, ts.URL, `{"action":"delete-user","name":"ana2"}`, http.StatusOK)
	if b, _ := os.ReadFile(filepath.Join(srv.cfg.ConfigDir, "renames.json")); strings.Contains(string(b), `"ana2"`) {
		t.Fatalf("renames.json still names the deleted ana2 (a home made by hand would inherit it): %s", b)
	}
	adminCall(t, ts.URL, `{"action":"create-user","name":"ana2","password":"nueva"}`, http.StatusOK)
	if renamed, _, _ := whoamiOf(t, noFollow(), ts.URL, "ana2", "nueva"); renamed != nil {
		t.Fatalf("a new ana2 inherited the deleted one's old names: %v", renamed)
	}
	if ok, _ := ownerCheck(srv, "user:ana", "ana2"); ok {
		t.Fatalf("the new ana2's session took a save of the deleted account's")
	}
}

// TestDS_L3_SignOutClearsWasCookie: sign-out clears nayive_was with the rest.
func TestDS_L3_SignOutClearsWasCookie(t *testing.T) {
	_, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	resp := do(t, client, "POST", ts.URL+"/api/logout", nil, nil)
	readBody(t, resp)
	for _, line := range resp.Header.Values("Set-Cookie") {
		if strings.HasPrefix(line, WasCookieName+"=;") && strings.Contains(line, "Max-Age=0") {
			return
		}
	}
	t.Fatalf("sign-out did not clear %s: %v", WasCookieName, resp.Header.Values("Set-Cookie"))
}
