package main

// =============================================================================
// eMail review fixes (docs/audit/email.md) on the hub, the labels and the
// API: passwords kept sealed, a new password, ids never reused, "new mail"
// by arrival, labels per tray, ghost rows, stale rows, Message-IDs, the Bcc
// copy, settings, and the small helpers.
// =============================================================================

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/emersion/go-imap/v2"
)

func TestMailHubCleanPass(t *testing.T) {
	for _, c := range []struct{ pass, prov, want string }{
		{"abcd efgh ijkl mnop", "gmail", "abcdefghijklmnop"}, // Google's spaced form
		{" abcd efgh ", "yahoo", "abcdefgh"},
		{"my pass word", "", "my pass word"}, // a typed server: as typed
		{"my pass", "gmx", "my pass"},
	} {
		if got := cleanPass(c.pass, c.prov); got != c.want {
			t.Errorf("cleanPass(%q, %q) = %q, want %q", c.pass, c.prov, got, c.want)
		}
	}
}

func TestMailHubSmallHelpers(t *testing.T) {
	if got := clipRunes("ññññ", 3); got != "ñ" {
		t.Errorf("clipRunes cut a letter: %q", got)
	}
	if got := clipRunes("abc", 5); got != "abc" {
		t.Errorf("clipRunes = %q", got)
	}
	for id, ok := range map[string]bool{
		"a1@example.com": true, "h:0123abcd": false, "": false, "noat": false,
		"a b@x": false, "a@x\r\nBcc: z@y": false, "<a@x>": false,
	} {
		if mailIDOK(id) != ok {
			t.Errorf("mailIDOK(%q) = %v", id, !ok)
		}
	}
}

// a second address on the one mailbox the in-memory server has
func (f *mailFixture) addOther(t *testing.T, email string, want int) map[string]any {
	t.Helper()
	host, port, _ := strings.Cut(f.addr, ":")
	var out map[string]any
	f.call(t, f.owner, "POST", "/api/mail/accounts",
		`{"email":"`+email+`","user":"`+mailTestUser+`","pass":"`+mailTestPass+`","imapHost":"`+host+`","imapPort":`+port+`}`, want, &out)
	return out
}

func TestMailHubIDsNeverReused(t *testing.T) {
	f := newMailFixture(t)
	if a := f.addOther(t, "one@example.com", 200); a["id"] != "a1" {
		t.Fatalf("first = %v", a)
	}
	if a := f.addOther(t, "two@example.com", 200); a["id"] != "a2" {
		t.Fatalf("second = %v", a)
	}
	f.call(t, f.owner, "DELETE", "/api/mail/accounts/a2", "", 200, nil)
	if a := f.addOther(t, "three@example.com", 200); a["id"] != "a3" {
		t.Fatalf("after removing a2, the new one = %v (an old ?a=a2 would open it)", a)
	}
	// and after a restart (the file)
	h := NewMailHub(f.srv.cfg, f.srv.users, nil, f.srv.log)
	h.newProvider = f.srv.mail.newProvider
	host, port, _ := strings.Cut(f.addr, ":")
	var p int
	json.Unmarshal([]byte(port), &p)
	v, err := h.Add(t.Context(), "ana", MailAccount{Email: "four@example.com", User: mailTestUser, Pass: mailTestPass, IMAPHost: host, IMAPPort: p})
	if err != nil || v.ID != "a4" {
		t.Fatalf("after a restart: %+v %v", v, err)
	}
}

func TestMailHubSendCheck(t *testing.T) {
	f := newMailFixture(t)
	f.srv.mail.newProvider = func(a MailAccount) MailProvider {
		p := newIMAPProvider(a)
		p.dial = dialMemIMAP(f.addr)
		p.smtpCheck = func(context.Context, MailAccount) error {
			return &mailRejectError{Text: "535 5.7.8 Username and Password not accepted"}
		}
		return p
	}
	out := f.addAccount(t, mailTestPass, 502)
	if out["code"] != "smtp" || !strings.Contains(out["text"].(string), "535") {
		t.Fatalf("an account that cannot send = %v", out)
	}
	var list map[string][]MailAccountView
	f.call(t, f.owner, "GET", "/api/mail/accounts", "", 200, &list)
	if len(list["accounts"]) != 0 {
		t.Fatalf("kept anyway: %+v", list)
	}
	// a refused SMTP login is "cannot send", not "wrong password" (the IMAP
	// one was just taken)
	f.srv.mail.newProvider = func(a MailAccount) MailProvider {
		p := newIMAPProvider(a)
		p.dial = dialMemIMAP(f.addr)
		p.smtpCheck = func(context.Context, MailAccount) error { return errMailAuth }
		return p
	}
	if out := f.addAccount(t, mailTestPass, 502); out["code"] != "smtp" {
		t.Fatalf("an SMTP login refused = %v", out)
	}
}

// A password sealed with another mail.key is kept as it was (never
// re-sealed as ""), the account is not polled, and a new password (or the
// right key back) brings it back - labels and all.
func TestMailHubSealedKeptAndNewPassword(t *testing.T) {
	f := newMailFixture(t)
	appendMail(t, f.addr, "INBOX", plainMail(1), false)
	f.addAccount(t, mailTestPass, 200)
	var page mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox", "", 200, &page)
	var work MailLabel
	f.call(t, f.owner, "POST", "/api/mail/labels", `{"name":"Work"}`, 200, &work)
	f.call(t, f.owner, "POST", "/api/mail/a1/labels", `{"refs":["`+page.Items[0].Ref+`"],"add":["`+work.ID+`"]}`, 200, nil)

	acctPath := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "mail", "accounts.json")
	keyPath := filepath.Join(f.srv.cfg.ConfigDir, "mail.key")
	sealedOf := func() string {
		var file mailAccountsFile
		raw, _ := os.ReadFile(acctPath)
		json.Unmarshal(raw, &file)
		for _, a := range file.Accounts {
			if a.ID == "a1" {
				return a.Pass
			}
		}
		return ""
	}
	sealed := sealedOf()
	oldKey, _ := os.ReadFile(keyPath)

	// another key: a fresh hub cannot open it
	os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(make([]byte, 32))+"\n"), 0o600)
	h := NewMailHub(f.srv.cfg, f.srv.users, nil, f.srv.log)
	h.newProvider = f.srv.mail.newProvider
	f.srv.mail = h
	var accts map[string][]MailAccountView
	f.call(t, f.owner, "GET", "/api/mail/accounts", "", 200, &accts)
	if len(accts["accounts"]) != 1 || accts["accounts"][0].Error != "key" {
		t.Fatalf("with another key = %+v", accts)
	}
	// saving the file for another reason keeps the sealed text as it was
	f.addOther(t, "two@example.com", 200)
	if got := sealedOf(); got != sealed {
		t.Fatalf("the unopened password was re-sealed: %q -> %q", sealed, got)
	}
	// the right key back (and a restart): it opens again
	os.WriteFile(keyPath, oldKey, 0o600)
	h2 := NewMailHub(f.srv.cfg, f.srv.users, nil, f.srv.log)
	h2.newProvider = f.srv.mail.newProvider
	if v := h2.Accounts("ana"); v[0].Error != "" {
		t.Fatalf("with the right key back = %+v", v)
	}

	// a new password: a wrong one changes nothing, the right one mends it
	var bad map[string]any
	f.call(t, f.owner, "PATCH", "/api/mail/accounts/a1", `{"pass":"wrong"}`, 502, &bad)
	if bad["code"] != "auth" {
		t.Fatalf("wrong new password = %v", bad)
	}
	var fixed MailAccountView
	f.call(t, f.owner, "PATCH", "/api/mail/accounts/a1", `{"pass":"`+mailTestPass+`"}`, 200, &fixed)
	if fixed.ID != "a1" || fixed.Error != "" || fixed.Unread != 1 {
		t.Fatalf("after a new password = %+v", fixed)
	}
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox", "", 200, &page)
	if len(page.Items[0].Labels) != 1 {
		t.Fatalf("labels lost with the new password: %+v", page.Items[0])
	}
	f.call(t, f.owner, "PATCH", "/api/mail/accounts/a9", `{"pass":"x"}`, 404, nil)
}

// pollFake is a provider that only polls.
type pollFake struct {
	MailProvider
	mu   sync.Mutex
	next MailPoll
}

func (p *pollFake) Poll(_ context.Context, mark string) (MailPoll, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.next, nil
}
func (p *pollFake) Close() {}

func TestMailHubNewMailByArrival(t *testing.T) {
	f := newMailFixture(t)
	fake := &pollFake{next: MailPoll{Unread: 3, Mark: "1.10"}}
	a := &mailAcct{MailAccount: MailAccount{ID: "a1"}, prov: fake}
	var got []int
	f.srv.mail.onArrived = func(_, _ string, n int) { got = append(got, n) }
	f.srv.mail.pollOne(t.Context(), "ana", a) // the first poll only learns
	// one read, one new: the count stays at 3, the arrival still tells
	fake.next = MailPoll{Unread: 3, Mark: "1.11", Arrived: 1}
	f.srv.mail.pollOne(t.Context(), "ana", a)
	if len(got) != 1 || got[0] != 1 || a.mark != "1.11" {
		t.Fatalf("pushes %v, mark %q", got, a.mark)
	}
	// nothing new
	fake.next = MailPoll{Unread: 2, Mark: "1.11"}
	f.srv.mail.pollOne(t.Context(), "ana", a)
	if len(got) != 1 {
		t.Fatalf("a push with nothing new: %v", got)
	}
}

func TestMailHubLabelsPerTray(t *testing.T) {
	f, _ := newWriteFixture(t)
	self := "From: Ana <ana@example.com>\nTo: ana@example.com\nSubject: To myself\n" +
		"Date: Mon, 01 Sep 2026 10:00:00 +0000\nMessage-ID: <self@example.com>\nContent-Type: text/plain\n\nhi\n"
	appendMail(t, f.addr, "INBOX", self, false)
	appendMail(t, f.addr, "Sent Items", self, true)
	f.addAccount(t, mailTestPass, 200)
	list := func(tray string) MailSummary {
		var p mailPageOut
		f.call(t, f.owner, "GET", "/api/mail/a1/list?tray="+tray, "", 200, &p)
		if len(p.Items) != 1 {
			t.Fatalf("%s = %+v", tray, p.Items)
		}
		return p.Items[0]
	}
	var work MailLabel
	f.call(t, f.owner, "POST", "/api/mail/labels", `{"name":"Work"}`, 200, &work)
	in := list("inbox")
	f.call(t, f.owner, "POST", "/api/mail/a1/labels", `{"refs":["`+in.Ref+`"],"add":["`+work.ID+`"]}`, 200, nil)
	sent := list("sent")
	if len(sent.Labels) != 1 {
		t.Fatalf("the Sent copy shares the Message-ID: %+v", sent)
	}
	// viewing the two trays in turn no longer rewrites labels.json each time
	path := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "mail", "labels.json")
	before, _ := os.ReadFile(path)
	list("inbox")
	list("sent")
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatalf("labels.json flipped:\n%s\n->\n%s", before, after)
	}
	// the Sent copy deleted for good: the Inbox copy keeps its label
	var moved map[string]any
	f.call(t, f.owner, "POST", "/api/mail/a1/set", `{"refs":["`+sent.Ref+`"],"tray":"trash"}`, 200, &moved)
	trash := list("trash")
	f.call(t, f.owner, "POST", "/api/mail/a1/forget", `{"refs":["`+trash.Ref+`"]}`, 200, nil)
	if in = list("inbox"); len(in.Labels) != 1 {
		t.Fatalf("the Inbox copy lost its label: %+v", in)
	}
	var rows map[string][]MailSummary
	f.call(t, f.owner, "GET", "/api/mail/label/"+work.ID, "", 200, &rows)
	if len(rows["items"]) != 1 || rows["items"][0].Ref != in.Ref {
		t.Fatalf("the label's list = %+v", rows)
	}
}

// A label's list: unread shows, a message gone everywhere drops its row, a
// stale row (moved on the phone) still takes a label change.
func TestMailHubLabelRows(t *testing.T) {
	f := newMailFixture(t, imap.CapMove, imap.CapUIDPlus)
	appendMail(t, f.addr, "INBOX", plainMail(1), false)
	appendMail(t, f.addr, "INBOX", plainMail(2), false)
	f.addAccount(t, mailTestPass, 200)
	var page mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox", "", 200, &page)
	var work MailLabel
	f.call(t, f.owner, "POST", "/api/mail/labels", `{"name":"Work"}`, 200, &work)
	refs := `["` + page.Items[0].Ref + `","` + page.Items[1].Ref + `"]`
	f.call(t, f.owner, "POST", "/api/mail/a1/labels", `{"refs":`+refs+`,"add":["`+work.ID+`"]}`, 200, nil)
	rows := func() []MailSummary {
		var out map[string][]MailSummary
		f.call(t, f.owner, "GET", "/api/mail/label/"+work.ID, "", 200, &out)
		return out["items"]
	}
	r := rows()
	if len(r) != 2 || r[0].Seen || r[1].Seen {
		t.Fatalf("unread rows show as read: %+v", r)
	}

	// behind Nayive's back: Hello 2 is expunged, Hello 1 moved to Junk
	c, err := dialMemIMAP(f.addr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	if err != nil {
		t.Fatal(err)
	}
	c.Select("INBOX", nil).Wait()
	var h1, h2 MailSummary
	for _, m := range r {
		if m.Subject == "Hello 1" {
			h1 = m
		} else {
			h2 = m
		}
	}
	r1, _ := parseMailRef(h1.Ref)
	r2, _ := parseMailRef(h2.Ref)
	c.Store(imap.UIDSetNum(imap.UID(r2.UID)), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close()
	c.Expunge().Close()
	c.Move(imap.UIDSetNum(imap.UID(r1.UID)), "Junk").Wait()
	c.Close()

	// the gone one: 404, and its row goes
	var gone map[string]any
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+h2.Ref+"?mid="+h2.MessageID, "", 404, &gone)
	if gone["code"] != "gone" || len(rows()) != 1 {
		t.Fatalf("the ghost row stays: %v %+v", gone, rows())
	}
	// the moved one, still at its old ref: taking the label off works by its tag
	var out struct {
		Known map[string][]string `json:"known"`
	}
	f.call(t, f.owner, "POST", "/api/mail/a1/labels", `{"refs":["`+h1.Ref+`"],"mids":["`+h1.MessageID+`"],"remove":["`+work.ID+`"]}`, 200, &out)
	if l, ok := out.Known[h1.MessageID]; !ok || len(l) != 0 || len(rows()) != 0 {
		t.Fatalf("stale row: known %v, rows %+v", out.Known, rows())
	}
}

// Message-IDs on the way out, and the Bcc kept in Sent only.
func TestMailHubSendIDsAndBcc(t *testing.T) {
	f, sent := newWriteFixture(t)
	f.addAccount(t, mailTestPass, 200)
	draft := f.postForm(t, "/api/mail/a1/draft", MailOut{To: "bob@example.com", Subject: "D", Text: "x", MID: "h:0123456789abcdef"}, nil, 200)
	mid := draft["mid"].(string)
	if strings.HasPrefix(mid, "h:") || !strings.Contains(mid, "@") {
		t.Fatalf("a draft kept a made-up id: %q", mid)
	}
	again := f.postForm(t, "/api/mail/a1/draft", MailOut{To: "bob@example.com", Subject: "D", Text: "xy", MID: mid, DraftRef: draft["ref"].(string)}, nil, 200)
	if again["mid"] != mid {
		t.Fatalf("a draft changed its Message-ID: %v -> %v", mid, again["mid"])
	}
	out := f.postForm(t, "/api/mail/a1/send", MailOut{To: "bob@example.com", Bcc: "carol@example.com", Subject: "Hi", Text: "hello",
		MID: mid, InReplyTo: "h:abcdef0123", References: []string{"h:1", "root@x.org"}, DraftRef: again["ref"].(string)}, nil, 200)
	if out["mid"] == mid {
		t.Fatal("the mail sent kept the draft's Message-ID")
	}
	if len(*sent) != 1 {
		t.Fatalf("sent = %d", len(*sent))
	}
	raw := (*sent)[0].raw
	if strings.Contains(raw, "h:") || strings.Contains(strings.ToLower(raw), "\nin-reply-to:") ||
		!strings.Contains(raw, "<root@x.org>") || strings.Contains(strings.ToLower(raw), "\nbcc:") {
		t.Fatalf("the mail sent:\n%s", raw)
	}
	if !contains((*sent)[0].rcpts, "carol@example.com") {
		t.Fatalf("Bcc not a recipient: %v", (*sent)[0].rcpts)
	}
	// the copy in Sent keeps the Bcc
	var page mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=sent", "", 200, &page)
	if len(page.Items) != 1 {
		t.Fatalf("Sent = %+v", page.Items)
	}
	var msg MailMessage
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+page.Items[0].Ref, "", 200, &msg)
	if len(msg.Bcc) != 1 || msg.Bcc[0].Addr != "carol@example.com" {
		t.Fatalf("the Sent copy's Bcc = %+v", msg.Bcc)
	}
	// and the draft is gone
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=drafts", "", 200, &page)
	if len(page.Items) != 0 {
		t.Fatalf("draft left: %+v", page.Items)
	}
}

func TestMailHubSettingsMerge(t *testing.T) {
	f := newMailFixture(t)
	var st MailSettings
	f.call(t, f.owner, "PUT", "/api/mail/settings", `{"trashDays":5}`, 200, &st)
	f.call(t, f.owner, "PUT", "/api/mail/settings", `{"showImages":true}`, 200, &st)
	if st.TrashDays != 5 || !st.ShowImages {
		t.Fatalf("after two PUTs = %+v", st)
	}
	f.call(t, f.owner, "PUT", "/api/mail/settings", `{"trashDays":9}`, 200, &st)
	if st.TrashDays != 9 || !st.ShowImages {
		t.Fatalf("trashDays alone lost showImages: %+v", st)
	}
}

func TestMailHubDeleteLabelRollback(t *testing.T) {
	f := newMailFixture(t)
	var work MailLabel
	f.call(t, f.owner, "POST", "/api/mail/labels", `{"name":"Work"}`, 200, &work)
	dir := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "mail")
	os.Chmod(dir, 0o500)
	defer os.Chmod(dir, 0o700)
	if _, err := f.srv.mail.DeleteLabel("ana", work.ID); err == nil {
		t.Skip("the folder is writable anyway (root?)")
	}
	if l := f.srv.mail.Labels("ana"); len(l) != 1 || l[0].ID != work.ID {
		t.Fatalf("a failed delete changed memory: %+v", l)
	}
}

// Partly done: forget drops what Nayive keeps only for what went.
func TestMailHubPartial(t *testing.T) {
	rows := []MailSummary{{Ref: "trash.1.1", MessageID: "a@x"}, {Ref: "trash.1.2", MessageID: "b@x"}}
	err := error(&mailPartialError{Failed: map[string]bool{"trash.1.2": true}})
	done := mailDone(rows, mailFailed(err))
	if len(done) != 1 || done[0].MessageID != "a@x" {
		t.Fatalf("done = %+v", done)
	}
	if mailFailed(errors.New("x")) != nil || len(mailDone(rows, nil)) != 2 {
		t.Fatal("an all-or-nothing error is not partial")
	}
}
