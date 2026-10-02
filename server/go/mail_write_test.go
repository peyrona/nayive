package main

// =============================================================================
// eMail phase 3: drafts (saved, saved again keeping their file, deleted),
// sending (Bcc out of the headers, a reply's thread, a forward's files, a
// Drive file, the copy in Sent, the draft gone), and the address book.
// =============================================================================

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/emersion/go-imap/v2"
)

type sentMail struct {
	from  string
	rcpts []string
	raw   string
}

func newWriteFixture(t *testing.T) (*mailFixture, *[]sentMail) {
	t.Helper()
	f := newMailFixture(t, imap.CapUIDPlus, imap.CapMove)
	var mu sync.Mutex
	sent := &[]sentMail{}
	f.srv.mail.newProvider = func(a MailAccount) MailProvider {
		p := newIMAPProvider(a)
		p.dial = dialMemIMAP(f.addr)
		p.smtpCheck = noSMTPCheck
		p.smtp = func(_ context.Context, _ MailAccount, from string, rcpts []string, raw []byte) error {
			mu.Lock()
			defer mu.Unlock()
			*sent = append(*sent, sentMail{from, rcpts, string(raw)})
			return nil
		}
		return p
	}
	// the tests' mailbox has a "Sent Items" folder but no Drafts: make one
	c, err := dialMemIMAP(f.addr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	if err != nil {
		t.Fatal(err)
	}
	c.Create("Drafts", nil).Wait()
	c.Close()
	return f, sent
}

// postForm sends one multipart request: the JSON and the uploads.
func (f *mailFixture) postForm(t *testing.T, path string, msg MailOut, uploads map[string]string, want int) map[string]any {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	raw, _ := json.Marshal(msg)
	mw.WriteField("json", string(raw))
	for name, content := range uploads {
		w, _ := mw.CreateFormFile("file", name)
		w.Write([]byte(content))
	}
	mw.Close()
	resp := do(t, f.owner, "POST", f.base+path, &body, map[string]string{"Content-Type": mw.FormDataContentType()})
	out := readBody(t, resp)
	if resp.StatusCode != want {
		t.Fatalf("POST %s = %d, want %d: %s", path, resp.StatusCode, want, out)
	}
	var m map[string]any
	json.Unmarshal(out, &m)
	return m
}

func TestMailWrite(t *testing.T) {
	f, sent := newWriteFixture(t)
	appendMail(t, f.addr, "INBOX", richMail(), false)
	f.addAccount(t, mailTestPass, 200)
	f.call(t, f.owner, "PUT", "/api/mail/settings", `{"trashDays":30}`, 200, nil)

	// a draft with a file
	d1 := f.postForm(t, "/api/mail/a1/draft", MailOut{To: "Bob <bob@example.com>", Bcc: "hidden@example.com",
		Subject: "Borrador", Text: "Hola"}, map[string]string{"notas.txt": "uno dos"}, 200)
	ref1, mid := d1["ref"].(string), d1["mid"].(string)
	parts := d1["parts"].([]any)
	if !strings.HasPrefix(ref1, "drafts.") || mid == "" || len(parts) != 1 || parts[0].(map[string]any)["id"] != "2" {
		t.Fatalf("draft 1 = %v", d1)
	}
	var drafts mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=drafts", "", 200, &drafts)
	if len(drafts.Items) != 1 || drafts.Items[0].Subject != "Borrador" {
		t.Fatalf("drafts = %+v", drafts.Items)
	}
	var dm MailMessage
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+ref1, "", 200, &dm)
	if len(dm.Bcc) != 1 || dm.Bcc[0].Addr != "hidden@example.com" || dm.Text != "Hola" || len(dm.Parts) != 1 || dm.Parts[0].ID != "2" {
		t.Fatalf("draft opened = %+v", dm)
	}

	// saved again, keeping its file (and its Message-ID): the old one goes
	d2 := f.postForm(t, "/api/mail/a1/draft", MailOut{To: "Bob <bob@example.com>", Bcc: "hidden@example.com",
		Subject: "Borrador 2", Text: "Hola otra vez", MID: mid, DraftRef: ref1,
		Keep: []mailKeepRef{{Acct: "a1", Ref: ref1, Part: "2"}}}, nil, 200)
	ref2 := d2["ref"].(string)
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=drafts", "", 200, &drafts)
	if len(drafts.Items) != 1 || drafts.Items[0].Ref != ref2 || d2["mid"] != mid {
		t.Fatalf("drafts after the second save = %+v (%v)", drafts.Items, d2)
	}
	resp := do(t, f.owner, "GET", f.base+"/api/mail/a1/att/"+ref2+"/2", nil, nil)
	if b := readBody(t, resp); string(b) != "uno dos" {
		t.Fatalf("the kept file = %q", b)
	}

	// a reply to the rich message, from the draft, with a Drive file and the original's PDF
	var inbox mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox", "", 200, &inbox)
	var orig MailMessage
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+inbox.Items[0].Ref, "", 200, &orig)
	home := filepath.Join(f.srv.cfg.HomesDir, "ana", "files")
	os.WriteFile(filepath.Join(home, "plano.txt"), []byte("un plano"), 0o644)
	var pdf string
	for _, p := range orig.Parts {
		if p.Name == "f7.pdf" {
			pdf = p.ID
		}
	}
	f.postForm(t, "/api/mail/a1/send", MailOut{To: "María <maria@example.com>", Cc: "c@example.com", Bcc: "hidden@example.com",
		Subject: "Re: " + orig.Subject, Text: "Gracias\n\n> Aquí está la factura.", InReplyTo: orig.MessageID,
		References: append(orig.References, orig.MessageID), MID: mid, DraftRef: ref2,
		Keep:  []mailKeepRef{{Acct: "a1", Ref: ref2, Part: "2"}, {Acct: "a1", Ref: orig.Ref, Part: pdf}},
		Drive: []string{"files/plano.txt"}}, nil, 200)
	if len(*sent) != 1 {
		t.Fatalf("sent %d", len(*sent))
	}
	m := (*sent)[0]
	if m.from != mailTestUser || strings.Join(m.rcpts, ",") != "maria@example.com,c@example.com,hidden@example.com" {
		t.Fatalf("envelope = %s %v", m.from, m.rcpts)
	}
	for _, want := range []string{"In-Reply-To: <rich@example.com>", "References: <rich@example.com>", "notas.txt", "f7.pdf", "plano.txt", "Subject: =?utf-8?q?Re:_Factura"} {
		if !strings.Contains(m.raw, want) {
			t.Fatalf("the message lacks %q:\n%s", want, m.raw)
		}
	}
	if strings.Contains(m.raw, "Bcc") || strings.Contains(m.raw, "hidden@") {
		t.Fatalf("Bcc leaked into the message:\n%s", m.raw)
	}
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=drafts", "", 200, &drafts)
	var sentTray mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=sent", "", 200, &sentTray)
	if len(drafts.Items) != 0 || len(sentTray.Items) != 1 || !sentTray.Items[0].Seen {
		t.Fatalf("after sending: %d drafts, sent %+v", len(drafts.Items), sentTray.Items)
	}

	// refusals
	if out := f.postForm(t, "/api/mail/a1/send", MailOut{Subject: "x", Text: "y"}, nil, 400); out["code"] != "norcpt" {
		t.Fatalf("no recipient = %v", out)
	}
	if out := f.postForm(t, "/api/mail/a1/send", MailOut{To: "not an address", Text: "y"}, nil, 400); out["code"] != "addr" {
		t.Fatalf("bad address = %v", out)
	}
	f.postForm(t, "/api/mail/a1/send", MailOut{To: "a@b.c", Drive: []string{"data/mail/accounts.json"}}, nil, http.StatusForbidden)

	// a draft deleted by hand
	d3 := f.postForm(t, "/api/mail/a1/draft", MailOut{Subject: "otro"}, nil, 200)
	f.call(t, f.owner, "POST", "/api/mail/a1/draft/delete", `{"ref":"`+d3["ref"].(string)+`"}`, 200, nil)
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=drafts", "", 200, &drafts)
	if len(drafts.Items) != 0 {
		t.Fatalf("draft not deleted: %+v", drafts.Items)
	}

	// the address book
	os.WriteFile(filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "contacts.vcf"), []byte(
		"BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bea Ruiz\r\nEMAIL;TYPE=HOME:bea@x.es\r\nitem1.EMAIL:bea@work.\r\n es\r\nEND:VCARD\r\n"+
			"BEGIN:VCARD\r\nFN:Ana\\, la vecina\r\nEMAIL:ana@v.es\r\nEND:VCARD\r\n"), 0o644)
	var book struct{ Contacts []MailContact }
	f.call(t, f.owner, "GET", "/api/mail/contacts", "", 200, &book)
	if len(book.Contacts) != 3 || book.Contacts[0].Name != "Ana, la vecina" || book.Contacts[2].Email != "bea@work.es" {
		t.Fatalf("contacts = %+v", book.Contacts)
	}
}

// The editor's formatting: a draft with HTML (and a file) keeps both
// versions and its file as part 2; sent, the message is
// multipart/alternative, plain first, and what the app wrote is cleaned.
func TestMailWriteHTML(t *testing.T) {
	f, sent := newWriteFixture(t)
	f.addAccount(t, mailTestPass, 200)

	d := f.postForm(t, "/api/mail/a1/draft", MailOut{To: "bob@example.com", Subject: "Con formato",
		Text: "Hola negrita", HTML: `<div>Hola <b>negrita</b></div>`}, map[string]string{"notas.txt": "uno"}, 200)
	ref := d["ref"].(string)
	if parts := d["parts"].([]any); len(parts) != 1 || parts[0].(map[string]any)["id"] != "2" {
		t.Fatalf("draft parts = %v", d["parts"])
	}
	var dm MailMessage
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+ref, "", 200, &dm)
	if dm.Text != "Hola negrita" || !strings.Contains(dm.HTML, "<b>negrita</b>") || len(dm.Parts) != 1 || dm.Parts[0].ID != "2" {
		t.Fatalf("draft opened = text %q html %q parts %+v", dm.Text, dm.HTML, dm.Parts)
	}

	f.postForm(t, "/api/mail/a1/send", MailOut{To: "bob@example.com", Subject: "Hecho", Text: "Hola",
		HTML: `<div>Hola <i>tú</i><script>alert(1)</script><a href="javascript:x()">y</a></div>`}, nil, 200)
	raw := (*sent)[0].raw
	plain, html := strings.Index(raw, "text/plain"), strings.Index(raw, "text/html")
	if !strings.Contains(raw, "multipart/alternative") || plain < 0 || html < plain {
		t.Fatalf("not plain + HTML:\n%s", raw)
	}
	if strings.Contains(raw, "<script") || strings.Contains(raw, "javascript:") {
		t.Fatalf("the HTML was not cleaned:\n%s", raw)
	}

	// no HTML: plain text only, as before
	f.postForm(t, "/api/mail/a1/send", MailOut{To: "bob@example.com", Subject: "Sin", Text: "Hola"}, nil, 200)
	if raw := (*sent)[1].raw; strings.Contains(raw, "multipart") || strings.Contains(raw, "text/html") {
		t.Fatalf("plain mail grew an HTML part:\n%s", raw)
	}
}
