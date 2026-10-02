package main

// Data-safety seal (cleanup Phase 3, batch S1, after review): a failed save of
// an account is never "usuario guardado" (F1), an item the bin could not take
// is never answered as binned (F2), a damaged chat.json never re-sends its
// scheduled texts (F5), a passing read error does not leave a chat or a
// mailbox read-only until a restart (F4, F5), and a filesystem that cannot
// sync a folder never fails a save (K1).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// dsRetryAtOnce makes a file that could not be read be tried again at the
// next access, for the length of the test.
func dsRetryAtOnce(t *testing.T) {
	was := damagedRetryEvery
	damagedRetryEvery = 0
	t.Cleanup(func() { damagedRetryEvery = was })
}

// TestDS_F1_AdminSaveWriteFailed: the panel's update of an account whose
// config.json cannot be written (disk full, a folder it may not write) is an
// error, never "usuario guardado".
func TestDS_F1_AdminSaveWriteFailed(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes into a 0500 folder")
	}
	srv, ts, admin := newTestServer(t)
	signIn(t, admin, ts.URL, "jefe", "secreto")
	data := filepath.Join(srv.cfg.HomesDir, "ana", "data")
	before, _ := os.ReadFile(filepath.Join(data, "config.json"))

	os.Chmod(data, 0o500)
	code, body := callJSON(t, admin, "POST", ts.URL+"/api/admin", `{"action":"update-user","name":"ana","quota":5}`)
	os.Chmod(data, 0o755)
	if code == http.StatusOK {
		t.Errorf("an update that could not be written = 200 %s", body)
	}
	if after, _ := os.ReadFile(filepath.Join(data, "config.json")); string(after) != string(before) {
		t.Errorf("config.json changed: %s", after)
	}
}

// TestDS_F2_BinFailureNotAnsweredBinned: an item the bin cannot take (here the
// bin's folder may not be written) is an error - never "trashed" with no id:
// an app replacing a file after that would write over one with no bin copy.
func TestDS_F2_BinFailureNotAnsweredBinned(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes into a 0500 folder")
	}
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	can := dsBin(t, srv, client, ts.URL, "a.txt")
	x := filepath.Join(srv.cfg.HomesDir, "ana", "files", "x.txt")
	os.WriteFile(x, []byte("the only copy"), 0o644)

	os.Chmod(can, 0o500)
	code, body := callJSON(t, client, "DELETE", ts.URL+"/api/files?paths=files/x.txt", "")
	os.Chmod(can, 0o755)
	if code == http.StatusOK {
		t.Errorf("a delete the bin could not take = 200 %s", body)
	}
	var out struct {
		Failed []string `json:"failed"`
	}
	json.Unmarshal(body, &out)
	if len(out.Failed) != 1 || out.Failed[0] != "files/x.txt" {
		t.Errorf("the answer does not name what stayed: %s", body)
	}
	if got, _ := os.ReadFile(x); string(got) != "the only copy" {
		t.Errorf("x.txt = %q", got)
	}
}

// TestDS_F5_DamagedChatJSONLaterNotResent: with chat.json damaged, a text
// scheduled in it is not sent - it could not be taken off the list on disk,
// and would go again after every restart.
func TestDS_F5_DamagedChatJSONLaterNotResent(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/later",
		`{"text":"PROGRAMADO","at":`+itoa64(time.Now().Add(time.Hour).UnixMilli())+`,"cid":"l-1"}`, 201, nil)
	// One field of the wrong type: the file does not load whole (its later
	// list does), so it is damaged.
	path := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "chat.json")
	var data map[string]any
	raw, _ := os.ReadFile(path)
	json.Unmarshal(raw, &data)
	data["me"] = 5
	raw, _ = json.Marshal(data)
	os.WriteFile(path, raw, 0o644)

	sent := 0
	for restart := 0; restart < 2; restart++ {
		f.srv.chat.DropUser("ana")
		f.call(t, f.owner, "GET", "/api/chat", "", 200, nil) // the owner is read again
		f.srv.chat.sendDue(time.Now().Add(2 * time.Hour))
	}
	for _, m := range zzMsgsDS(t, f, conv) {
		if m.Text == "PROGRAMADO" {
			sent++
		}
	}
	if sent != 0 {
		t.Errorf("a text scheduled in a damaged chat.json was sent %d time(s)", sent)
	}
	if after, _ := os.ReadFile(path); string(after) != string(raw) {
		t.Errorf("chat.json was rewritten:\n%s", after)
	}
}

func zzMsgsDS(t *testing.T, f *chatFixture, conv string) []chatMsgOut {
	t.Helper()
	var l msgList
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &l)
	return l.Msgs
}

// TestDS_F5_ReadErrorRetried: a month that could not be READ (EIO, EMFILE -
// here a 000 file) makes the conversation read-only only while it cannot be
// read: once it reads, the next message goes and the old ones are all there.
func TestDS_F5_ReadErrorRetried(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a 000 file")
	}
	dsRetryAtOnce(t)
	f := newChatFixture(t)
	conv, _, month := dsChatConv(t, f, 3)
	os.Chmod(month, 0o000)
	f.srv.chat.DropUser("ana") // as a restart
	code, _ := callJSON(t, f.owner, "POST", f.base+"/api/chat/conv/"+conv+"/messages", `{"kind":"text","text":"mientras"}`)
	os.Chmod(month, 0o644)
	if code == http.StatusCreated {
		t.Fatal("a message went into a month that could not be read")
	}
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"kind":"text","text":"después"}`, 201, nil)
	if n := len(zzMsgsDS(t, f, conv)); n != 4 {
		t.Errorf("after the month read again: %d messages, want 4", n)
	}
}

// TestDS_F5_ChatJSONReadErrorRetried: the same for chat.json - and the
// people's links work again once it reads.
func TestDS_F5_ChatJSONReadErrorRetried(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a 000 file")
	}
	dsRetryAtOnce(t)
	f := newChatFixture(t)
	path := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "chat.json")
	os.Chmod(path, 0o000)
	f.srv.chat.DropUser("ana")
	code, _ := callJSON(t, f.owner, "PUT", f.base+"/api/chat/me", `{"name":"Ana María"}`)
	os.Chmod(path, 0o644)
	if code == http.StatusOK {
		t.Fatal("chat.json was saved while it could not be read")
	}
	f.call(t, f.owner, "PUT", "/api/chat/me", `{"name":"Ana María"}`, 200, nil)
	if raw, _ := os.ReadFile(path); !strings.Contains(string(raw), "Carmen") || !strings.Contains(string(raw), "Ana María") {
		t.Errorf("chat.json after the retry:\n%s", raw)
	}
	f.call(t, anonymous(), "GET", "/api/c/"+f.carmen, "", 200, nil)
}

// TestDS_F4_ReadErrorRetried: a labels.json that could not be read refuses a
// new label only while it cannot be read; then every label is back.
func TestDS_F4_ReadErrorRetried(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a 000 file")
	}
	dsRetryAtOnce(t)
	f := newMailFixture(t)
	dir := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "mail")
	os.MkdirAll(dir, 0o700)
	path := filepath.Join(dir, "labels.json")
	os.WriteFile(path, []byte(`{"labels":[{"id":"l1","name":"Facturas","color":"#e53935"}],"tags":{}}`), 0o600)
	os.Chmod(path, 0o000)
	code, _ := callJSON(t, f.owner, "POST", f.base+"/api/mail/labels", `{"name":"Nueva"}`)
	os.Chmod(path, 0o600)
	if code == http.StatusOK {
		t.Fatal("a label was saved over a labels.json that could not be read")
	}
	f.call(t, f.owner, "POST", "/api/mail/labels", `{"name":"Nueva"}`, 200, nil)
	var labels struct{ Labels []MailLabel }
	f.call(t, f.owner, "GET", "/api/mail/labels", "", 200, &labels)
	names := []string{}
	for _, l := range labels.Labels {
		names = append(names, l.Name)
	}
	if fmt.Sprint(names) != "[Facturas Nueva]" {
		t.Errorf("labels after the retry = %v", names)
	}
}

// TestDS_K1_DirSyncRefusalIgnored: a filesystem that cannot sync a folder at
// all (EINVAL, ENOTSUP) never fails a save; a real I/O error still does.
func TestDS_K1_DirSyncRefusalIgnored(t *testing.T) {
	for _, e := range []syscall.Errno{syscall.EINVAL, syscall.ENOTSUP} {
		if err := dirSyncErr(&os.PathError{Op: "sync", Path: "/x", Err: e}); err != nil {
			t.Errorf("%v fails the save", e)
		}
	}
	if dirSyncErr(&os.PathError{Op: "sync", Path: "/x", Err: syscall.EIO}) == nil {
		t.Error("EIO from a folder sync is ignored")
	}
}
