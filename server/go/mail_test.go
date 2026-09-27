package main

// =============================================================================
// eMail against go-imap's in-memory IMAP server: accounts, trays, pages,
// search, one message (cleaned, marked read), an attachment, the badge.
// =============================================================================

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
)

const mailTestUser, mailTestPass = "ana@example.com", "abcdefghijklmnop"

// startMemIMAP is an IMAP server on localhost with one mailbox user and the
// folders INBOX, "Sent Items", Junk, Trash (no Drafts). Its address is returned.
func startMemIMAP(t *testing.T, extra ...imap.Cap) string {
	t.Helper()
	caps := imap.CapSet{imap.CapIMAP4rev1: {}}
	for _, c := range extra {
		caps[c] = struct{}{}
	}
	mem := imapmemserver.New()
	u := imapmemserver.NewUser(mailTestUser, mailTestPass)
	for _, name := range []string{"INBOX", "Sent Items", "Junk", "Trash"} {
		if err := u.Create(name, nil); err != nil {
			t.Fatal(err)
		}
	}
	mem.AddUser(u)
	srv := imapserver.New(&imapserver.Options{
		NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return mem.NewSession(), nil, nil
		},
		Caps:         caps,
		InsecureAuth: true,
		Logger:       nopIMAPLog{},
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return ln.Addr().String()
}

type nopIMAPLog struct{}

func (nopIMAPLog) Printf(string, ...any) {}

func dialMemIMAP(addr string) func(MailAccount) (*imapclient.Client, error) {
	return func(a MailAccount) (*imapclient.Client, error) {
		c, err := imapclient.DialInsecure(addr, &imapclient.Options{WordDecoder: mailWordDecoder})
		if err != nil {
			return nil, err
		}
		if err := c.Login(a.User, a.Pass).Wait(); err != nil {
			c.Close()
			return nil, errMailAuth
		}
		return c, nil
	}
}

// appendMail puts one raw message in `folder`.
func appendMail(t *testing.T, addr, folder, raw string, seen bool) {
	t.Helper()
	c, err := imapclient.DialInsecure(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Login(mailTestUser, mailTestPass).Wait(); err != nil {
		t.Fatal(err)
	}
	raw = strings.ReplaceAll(raw, "\n", "\r\n")
	opts := &imap.AppendOptions{}
	if seen {
		opts.Flags = []imap.Flag{imap.FlagSeen}
	}
	cmd := c.Append(folder, int64(len(raw)), opts)
	cmd.Write([]byte(raw))
	cmd.Close()
	if _, err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
}

func plainMail(i int) string {
	return fmt.Sprintf("From: Bob <bob@example.com>\nTo: ana@example.com\nSubject: Hello %d\n"+
		"Date: Mon, 01 Sep 2026 10:%02d:00 +0000\nMessage-ID: <m%d@example.com>\n"+
		"Content-Type: text/plain; charset=utf-8\n\nLine one of %d.\n> quoted\n", i, i%60, i, i)
}

var mailTestPDF = []byte("%PDF-1.4 not really a pdf \x00\x01\x02")

func richMail() string {
	pdf := base64.StdEncoding.EncodeToString(mailTestPDF)
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG fake"))
	return "From: =?ISO-8859-1?Q?Mar=EDa?= <maria@example.com>\nTo: ana@example.com\n" +
		"Subject: =?ISO-8859-1?Q?Factura_n=BA_7?=\nDate: Tue, 02 Sep 2026 09:00:00 +0000\n" +
		"Message-ID: <rich@example.com>\nMIME-Version: 1.0\n" +
		"Content-Type: multipart/mixed; boundary=\"MIX\"\n\n" +
		"--MIX\nContent-Type: multipart/related; boundary=\"REL\"\n\n" +
		"--REL\nContent-Type: multipart/alternative; boundary=\"ALT\"\n\n" +
		"--ALT\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: quoted-printable\n\n" +
		"Aqu=ED est=E1 la factura.\n" +
		"--ALT\nContent-Type: text/html; charset=utf-8\n\n" +
		"<p onclick=\"steal()\">Hola <b>Ana</b></p><script>alert(1)</script>" +
		"<img src=\"cid:logo@x\"><a href=\"javascript:alert(2)\">x</a>\n" +
		"--ALT--\n" +
		"--REL\nContent-Type: image/png\nContent-ID: <logo@x>\nContent-Transfer-Encoding: base64\n\n" + png + "\n" +
		"--REL--\n" +
		"--MIX\nContent-Type: application/pdf; name=\"f7.pdf\"\nContent-Disposition: attachment; filename=\"f7.pdf\"\n" +
		"Content-Transfer-Encoding: base64\n\n" + pdf + "\n" +
		"--MIX--\n"
}

type mailFixture struct {
	*chatFixture
	addr string
}

func newMailFixture(t *testing.T, caps ...imap.Cap) *mailFixture {
	t.Helper()
	addr := startMemIMAP(t, caps...)
	srv, ts, client := newTestServer(t)
	srv.mail.newProvider = func(a MailAccount) MailProvider {
		p := newIMAPProvider(a)
		p.dial = dialMemIMAP(addr)
		p.smtpCheck = noSMTPCheck // no SMTP server in the tests
		return p
	}
	signIn(t, client, ts.URL, "ana", "abc")
	return &mailFixture{chatFixture: &chatFixture{srv: srv, base: ts.URL, owner: client}, addr: addr}
}

func (f *mailFixture) addAccount(t *testing.T, pass string, want int) map[string]any {
	t.Helper()
	host, port, _ := net.SplitHostPort(f.addr)
	var out map[string]any
	f.call(t, f.owner, "POST", "/api/mail/accounts",
		`{"email":"`+mailTestUser+`","pass":"`+pass+`","imapHost":"`+host+`","imapPort":`+port+`}`, want, &out)
	return out
}

type mailPageOut struct {
	Items []MailSummary `json:"items"`
	Next  string        `json:"next"`
}

func TestMailAccountsAndReading(t *testing.T) {
	f := newMailFixture(t)
	for i := 1; i <= 60; i++ {
		appendMail(t, f.addr, "INBOX", plainMail(i), i > 3) // 1..3 unread
	}
	appendMail(t, f.addr, "INBOX", richMail(), false) // unread: 4 in all

	// the badge with no account; a refused password; then the real one
	var n map[string]int
	f.call(t, f.owner, "GET", "/api/mail/unread", "", 200, &n)
	if n["n"] != 0 {
		t.Fatalf("unread with no account = %v", n)
	}
	if out := f.addAccount(t, "wrong", 502); out["code"] != "auth" {
		t.Fatalf("wrong password = %v", out)
	}
	acct := f.addAccount(t, mailTestPass, 200) // (Google's spaced form: TestMailHubCleanPass)
	if acct["id"] != "a1" || acct["unread"] != float64(4) {
		t.Fatalf("added = %v", acct)
	}
	f.addAccount(t, mailTestPass, 409)
	f.call(t, f.owner, "GET", "/api/mail/unread", "", 200, &n)
	if n["n"] != 4 {
		t.Fatalf("unread = %v", n)
	}

	// the file: sealed password, private modes
	path := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "mail", "accounts.json")
	raw, _ := os.ReadFile(path)
	if bytes.Contains(raw, []byte(mailTestPass)) || !bytes.Contains(raw, []byte(`"pass": "v1:`)) {
		t.Fatalf("accounts.json keeps the password in the clear:\n%s", raw)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Fatalf("accounts.json mode = %v", st.Mode().Perm())
	}
	// ... and a fresh hub (a restart) opens it again
	h2 := NewMailHub(f.srv.cfg, nil, nil, f.srv.log)
	if a := h2.userLocked("ana").accts; len(a) != 1 || a[0].Pass != mailTestPass || a[0].err != nil {
		t.Fatalf("reloaded = %+v", a)
	}

	// trays: found by name; no Drafts folder
	var trays struct{ Trays []MailTray }
	f.call(t, f.owner, "GET", "/api/mail/a1/trays", "", 200, &trays)
	if len(trays.Trays) != 5 || trays.Trays[0].Role != RoleInbox || trays.Trays[0].Total != 61 ||
		trays.Trays[0].Unread != 4 || !trays.Trays[1].Missing || trays.Trays[2].Missing ||
		trays.Trays[3].Missing || trays.Trays[4].Missing {
		t.Fatalf("trays = %+v", trays.Trays)
	}

	// page 1: the 50 newest, newest first
	var p1, p2 mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox", "", 200, &p1)
	if len(p1.Items) != 50 || p1.Next == "" || p1.Items[0].Subject != "Factura nº 7" ||
		p1.Items[1].Subject != "Hello 60" || p1.Items[49].Subject != "Hello 12" {
		t.Fatalf("page 1: %d items, next %q, first %q", len(p1.Items), p1.Next, p1.Items[0].Subject)
	}
	if s := p1.Items[1].Snippet; s != "Line one of 60." {
		t.Fatalf("snippet = %q", s)
	}
	if r := p1.Items[0]; !r.Attach || r.Seen || r.From[0].Name != "María" || r.Snippet != "Aquí está la factura." {
		t.Fatalf("rich row = %+v", r)
	}

	// new mail meanwhile does not shift page 2
	appendMail(t, f.addr, "INBOX", plainMail(99), true)
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox&cursor="+p1.Next, "", 200, &p2)
	if len(p2.Items) != 11 || p2.Next != "" || p2.Items[0].Subject != "Hello 11" || p2.Items[10].Subject != "Hello 1" {
		t.Fatalf("page 2: %d items, next %q", len(p2.Items), p2.Next)
	}

	// search
	var hits mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox&q=Factura", "", 200, &hits)
	if len(hits.Items) != 1 || hits.Items[0].MessageID != "rich@example.com" {
		t.Fatalf("search = %+v", hits.Items)
	}
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=trash", "", 200, &hits)
	if len(hits.Items) != 0 {
		t.Fatalf("trash = %+v", hits.Items)
	}

	// open the rich one: cleaned, text decoded, parts listed, marked read
	ref := p1.Items[0].Ref
	var msg MailMessage
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+ref, "", 200, &msg)
	if msg.Text != "Aquí está la factura.\r\n" && msg.Text != "Aquí está la factura." && !strings.HasPrefix(msg.Text, "Aquí está la factura.") {
		t.Fatalf("text = %q", msg.Text)
	}
	for _, bad := range []string{"<script", "onclick", "javascript:", "cid:"} {
		if strings.Contains(strings.ToLower(msg.HTML), bad) {
			t.Fatalf("html still has %q: %s", bad, msg.HTML)
		}
	}
	if !strings.Contains(msg.HTML, "/api/mail/a1/att/"+ref+"/") || !msg.Seen {
		t.Fatalf("html = %s (seen %v)", msg.HTML, msg.Seen)
	}
	var pdf MailPart
	for _, p := range msg.Parts {
		if p.Name == "f7.pdf" {
			pdf = p
		}
	}
	if pdf.ID == "" || pdf.Type != "application/pdf" || pdf.Inline || len(msg.Parts) != 2 {
		t.Fatalf("parts = %+v", msg.Parts)
	}

	// the attachment, decoded, as a download
	resp := do(t, f.owner, "GET", f.base+"/api/mail/a1/att/"+ref+"/"+pdf.ID, nil, nil)
	body := readBody(t, resp)
	if resp.StatusCode != 200 || !bytes.Equal(body, mailTestPDF) ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("attachment: %d %q %q", resp.StatusCode, resp.Header.Get("Content-Disposition"), body)
	}

	// the badge follows the read (the re-poll runs in the background)
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.call(t, f.owner, "GET", "/api/mail/unread", "", 200, &n)
		if n["n"] == 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if n["n"] != 3 {
		t.Fatalf("unread after reading = %v", n)
	}

	// a ref from another folder generation is gone, not another message
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/inbox.999.1", "", 404, nil)
	f.call(t, f.owner, "GET", "/api/mail/a2/trays", "", 404, nil)

	// remove
	f.call(t, f.owner, "DELETE", "/api/mail/accounts/a1", "", 200, nil)
	var list struct{ Accounts []MailAccountView }
	f.call(t, f.owner, "GET", "/api/mail/accounts", "", 200, &list)
	if len(list.Accounts) != 0 {
		t.Fatalf("after remove = %+v", list.Accounts)
	}
}

func TestMailAdminHasNone(t *testing.T) {
	srv, ts, client := newTestServer(t)
	_ = srv
	signIn(t, client, ts.URL, "jefe", "secreto")
	resp := do(t, client, "GET", ts.URL+"/api/mail/unread", nil, nil)
	readBody(t, resp)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("admin unread = %d", resp.StatusCode)
	}
}

func TestMailUnknownDomainNeedsHosts(t *testing.T) {
	f := newMailFixture(t)
	var out map[string]string
	f.call(t, f.owner, "POST", "/api/mail/accounts", `{"email":"x@nowhere.test","pass":"p"}`, 422, &out)
	if out["code"] != "hosts" {
		t.Fatalf("= %v", out)
	}
}

// TestMailFoldersBySpecialUse: the \Sent... marks win over names, and a
// folder that cannot be selected is never a tray.
func TestMailFoldersBySpecialUse(t *testing.T) {
	got := mapIMAPFolders([]*imap.ListData{
		{Mailbox: "INBOX", Delim: '/'},
		{Mailbox: "[Gmail]", Delim: '/', Attrs: []imap.MailboxAttr{imap.MailboxAttrNoSelect}},
		{Mailbox: "[Gmail]/Sent Mail", Delim: '/', Attrs: []imap.MailboxAttr{imap.MailboxAttrSent}},
		{Mailbox: "Sent", Delim: '/'},
		{Mailbox: "[Gmail]/Borradores", Delim: '/', Attrs: []imap.MailboxAttr{imap.MailboxAttrDrafts}},
		{Mailbox: "[Gmail]/Spam", Delim: '/', Attrs: []imap.MailboxAttr{imap.MailboxAttrJunk}},
		{Mailbox: "[Gmail]/Papelera", Delim: '/'},
		{Mailbox: "Work", Delim: '/'},
	})
	want := map[MailRole]string{RoleInbox: "INBOX", RoleSent: "[Gmail]/Sent Mail", RoleDrafts: "[Gmail]/Borradores",
		RoleSpam: "[Gmail]/Spam", RoleTrash: "[Gmail]/Papelera"}
	for r, w := range want {
		if got[r] != w {
			t.Errorf("%s = %q, want %q", r, got[r], w)
		}
	}
}

func TestMailSanitize(t *testing.T) {
	in := `<div OnMouseOver='x()' style="color:red">a</div><iframe src="//evil"></iframe>` +
		`<form action=x><input name=p></form><img src=cid:a1 onerror=alert(1)>` +
		`<a href="JavaScript:go()">l</a><base href="//evil/"><meta http-equiv=refresh content="0;url=//evil">`
	out := sanitizeMailHTML(in, func(cid string) string {
		if cid == "a1" {
			return "/att/1"
		}
		return ""
	})
	low := strings.ToLower(out)
	for _, bad := range []string{"onmouseover", "onerror", "<iframe", "<form", "<input", "javascript:", "<base", "<meta", "cid:"} {
		if strings.Contains(low, bad) {
			t.Errorf("still has %q: %s", bad, out)
		}
	}
	if !strings.Contains(out, "src=/att/1") || !strings.Contains(out, `style="color:red"`) {
		t.Errorf("lost the good parts: %s", out)
	}
}

// TestMailProviders: the list, a blocked provider, and a provider picked for
// an address it does not own (Google Workspace on one's own domain).
func TestMailProviders(t *testing.T) {
	f := newMailFixture(t)
	var list struct{ Providers []mailPreset }
	f.call(t, f.owner, "GET", "/api/mail/providers", "", 200, &list)
	if len(list.Providers) < 5 || list.Providers[0].ID != "gmail" || list.Providers[0].IMAPHost != "imap.gmail.com" {
		t.Fatalf("providers = %+v", list.Providers)
	}
	var out map[string]string
	f.call(t, f.owner, "POST", "/api/mail/accounts", `{"email":"x@hotmail.com","pass":"p"}`, 422, &out)
	if out["code"] != "blocked" {
		t.Fatalf("hotmail = %v", out)
	}
	f.call(t, f.owner, "POST", "/api/mail/accounts", `{"email":"x@anything.test","pass":"p","provider":"microsoft"}`, 422, &out)
	if out["code"] != "blocked" {
		t.Fatalf("picked microsoft = %v", out)
	}
	f.call(t, f.owner, "POST", "/api/mail/accounts", `{"email":"x@gmail.com","pass":"p","provider":"other"}`, 422, &out)
	if out["code"] != "hosts" {
		t.Fatalf("other without servers = %v", out)
	}

	var seen MailAccount
	f.srv.mail.newProvider = func(a MailAccount) MailProvider {
		seen = a
		p := newIMAPProvider(a)
		p.dial = dialMemIMAP(f.addr)
		p.smtpCheck = noSMTPCheck
		return p
	}
	var acct MailAccountView
	f.call(t, f.owner, "POST", "/api/mail/accounts",
		`{"email":"`+mailTestUser+`","pass":"`+mailTestPass+`","provider":"gmail"}`, 200, &acct)
	if seen.IMAPHost != "imap.gmail.com" || seen.SMTPPort != 465 || acct.Provider != "gmail" {
		t.Fatalf("picked gmail: dialled %+v, view %+v", seen, acct)
	}
}
