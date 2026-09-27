package main

// =============================================================================
// eMail over JMAP: the same API as IMAP, against the fake JMAP server
// (mail_jmap_fake_test.go) - account (Bearer, then Basic), trays, a list by
// anchor, search, one message (text, cleaned HTML, parts, read), its file,
// the actions and the Trash, labels, a draft (its parts as the server names
// them) and sending (Sent copy, the submission, the draft gone).
// =============================================================================

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestMailJMAP(t *testing.T) {
	fj := newFakeJMAP(t)
	for i := 1; i <= 60; i++ {
		fj.add(plainMail(i), "mb-inbox", i > 3)
	}
	rich := fj.add(richMail(), "mb-inbox", false)
	fj.add(plainMail(500), "mb-junk", false)

	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")
	f := &mailFixture{chatFixture: &chatFixture{srv: srv, base: ts.URL, owner: client}}
	session := fj.srv.URL + "/jmap/session"

	// the URL is checked; a wrong secret is refused; a token is taken as Bearer
	var out map[string]any
	f.call(t, f.owner, "POST", "/api/mail/accounts", `{"email":"ana@fast.test","pass":"x","provider":"jmap","jmapUrl":"http://example.com/j"}`, 400, &out)
	if out["code"] != "url" {
		t.Fatalf("plain http to another machine = %v", out)
	}
	f.call(t, f.owner, "POST", "/api/mail/accounts", `{"email":"ana@fast.test","pass":"wrong","provider":"jmap","jmapUrl":"`+session+`"}`, 502, &out)
	if out["code"] != "auth" {
		t.Fatalf("wrong token = %v", out)
	}
	var acct MailAccountView
	f.call(t, f.owner, "POST", "/api/mail/accounts", `{"email":"ana@fast.test","pass":"tok-123","provider":"jmap","jmapUrl":"`+session+`"}`, 200, &acct)
	if acct.Kind != "jmap" || acct.Unread != 4 || srv.mail.account("ana", "a1").Auth != "bearer" {
		t.Fatalf("added = %+v", acct)
	}
	// a password instead of a token: Basic
	var acct2 MailAccountView
	f.call(t, f.owner, "POST", "/api/mail/accounts", `{"email":"other@fast.test","user":"ana@fast.test","pass":"secreto","provider":"jmap","jmapUrl":"`+session+`"}`, 200, &acct2)
	if srv.mail.account("ana", acct2.ID).Auth != "basic" {
		t.Fatalf("basic = %+v", srv.mail.account("ana", acct2.ID).MailAccount)
	}
	f.call(t, f.owner, "DELETE", "/api/mail/accounts/"+acct2.ID, "", 200, nil)

	var trays struct{ Trays []MailTray }
	f.call(t, f.owner, "GET", "/api/mail/a1/trays", "", 200, &trays)
	if len(trays.Trays) != 5 || trays.Trays[0].Total != 61 || trays.Trays[0].Unread != 4 || trays.Trays[3].Unread != 1 {
		t.Fatalf("trays = %+v", trays.Trays)
	}

	// pages newest first; the cursor is the last one shown (an anchor)
	var p1, p2 mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox", "", 200, &p1)
	if len(p1.Items) != 50 || p1.Next != "50:"+strings.TrimPrefix(p1.Items[49].Ref, "inbox.j.") ||
		p1.Items[0].Subject != "Factura nº 7" || !strings.HasPrefix(p1.Items[0].Ref, "inbox.j.") {
		t.Fatalf("page 1: %d, next %q, first %+v", len(p1.Items), p1.Next, p1.Items[0])
	}
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox&cursor="+p1.Next, "", 200, &p2)
	if len(p2.Items) != 11 || p2.Next != "" || p2.Items[10].Subject != "Hello 1" {
		t.Fatalf("page 2: %d, next %q", len(p2.Items), p2.Next)
	}
	var hits mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox&q=factura", "", 200, &hits)
	if len(hits.Items) != 1 {
		t.Fatalf("search = %+v", hits.Items)
	}

	// one message: text, cleaned HTML with its picture, the PDF, now read
	ref := p1.Items[0].Ref
	var msg MailMessage
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+ref, "", 200, &msg)
	if !strings.HasPrefix(msg.Text, "Aquí está la factura.") || strings.Contains(msg.HTML, "<script") || !msg.Seen ||
		!strings.Contains(msg.HTML, "/api/mail/a1/att/"+ref+"/") {
		t.Fatalf("message = %+v", msg)
	}
	var pdf MailPart
	for _, p := range msg.Parts {
		if p.Name == "f7.pdf" {
			pdf = p
		}
	}
	resp := do(t, f.owner, "GET", f.base+"/api/mail/a1/att/"+ref+"/"+pdf.ID, nil, nil)
	if b := readBody(t, resp); string(b) != string(mailTestPDF) {
		t.Fatalf("pdf = %q", b)
	}
	f.call(t, f.owner, "GET", "/api/mail/a1/att/"+ref+"/someoneelses", "", 404, nil)

	// star, label, to the Trash (the label follows), restore by Message-ID
	post := func(path string, body any, want int) map[string]any {
		raw, _ := json.Marshal(body)
		var o map[string]any
		f.call(t, f.owner, "POST", "/api/mail/a1/"+path, string(raw), want, &o)
		return o
	}
	post("set", map[string]any{"refs": []string{ref}, "flagged": true, "seen": false}, 200)
	if e := fj.emails[rich]; !e.keywords["$flagged"] || e.keywords["$seen"] {
		t.Fatalf("keywords = %v", e.keywords)
	}
	var work MailLabel
	f.call(t, f.owner, "POST", "/api/mail/labels", `{"name":"Work"}`, 200, &work)
	post("labels", map[string]any{"refs": []string{ref}, "add": []string{work.ID}}, 200)
	o := post("set", map[string]any{"refs": []string{ref}, "tray": "trash"}, 200)
	moved := o["moved"].(map[string]any)
	if moved[ref] != "trash.j."+rich || !fj.emails[rich].boxes["mb-trash"] || fj.emails[rich].boxes["mb-inbox"] {
		t.Fatalf("moved = %v, boxes %v", moved, fj.emails[rich].boxes)
	}
	var rows struct{ Items []MailSummary }
	f.call(t, f.owner, "GET", "/api/mail/label/"+work.ID, "", 200, &rows)
	if len(rows.Items) != 1 || rows.Items[0].Ref != "trash.j."+rich {
		t.Fatalf("label rows = %+v", rows.Items)
	}
	o = post("restore", map[string]any{"mids": []string{"rich@example.com"}}, 200)
	if o["restored"] != float64(1) || !fj.emails[rich].boxes["mb-inbox"] {
		t.Fatalf("restore = %v, boxes %v", o, fj.emails[rich].boxes)
	}

	// the purge: in the Trash "3 days", trashDays 2 -> destroyed, label gone
	post("set", map[string]any{"refs": []string{"inbox.j." + rich}, "tray": "trash"}, 200)
	f.call(t, f.owner, "PUT", "/api/mail/settings", `{"trashDays":2}`, 200, nil)
	u := srv.mail.owners["ana"]
	srv.mail.mu.Lock()
	u.trash[mailKey("a1", "rich@example.com")] = mailTrashEntry{At: time.Now().Add(-72 * time.Hour), From: RoleInbox}
	srv.mail.mu.Unlock()
	if n, err := srv.mail.purgeAccount(t.Context(), "ana", srv.mail.account("ana", "a1"), false); err != nil || n != 1 || fj.emails[rich] != nil {
		t.Fatalf("purge = %d %v", n, err)
	}
	f.call(t, f.owner, "GET", "/api/mail/label/"+work.ID, "", 200, &rows)
	if len(rows.Items) != 0 {
		t.Fatalf("label rows after purge = %+v", rows.Items)
	}

	// a draft with a file: its parts come back as the server names them
	d := f.postForm(t, "/api/mail/a1/draft", MailOut{To: "bob@example.com", Subject: "Borrador", Text: "hola"},
		map[string]string{"n.txt": "nota"}, 200)
	dref := d["ref"].(string)
	parts := d["parts"].([]any)
	if !strings.HasPrefix(dref, "drafts.j.") || len(parts) != 1 || parts[0].(map[string]any)["name"] != "n.txt" {
		t.Fatalf("draft = %v", d)
	}
	pid := parts[0].(map[string]any)["id"].(string)

	// sent from the draft, keeping its file
	f.postForm(t, "/api/mail/a1/send", MailOut{To: "Bob <bob@example.com>", Bcc: "x@example.com", Subject: "Hecho", Text: "adiós",
		MID: d["mid"].(string), DraftRef: dref, Keep: []mailKeepRef{{Acct: "a1", Ref: dref, Part: pid}}}, nil, 200)
	if len(fj.subs) != 1 || fj.subs[0].identity != "id1" || strings.Join(fj.subs[0].rcpts, ",") != "bob@example.com,x@example.com" {
		t.Fatalf("submission = %+v", fj.subs)
	}
	sent := fj.rawOf(fj.subs[0].emailID)
	if !strings.Contains(sent, "n.txt") || strings.Contains(sent, "x@example.com") || !fj.emails[fj.subs[0].emailID].boxes["mb-sent"] {
		t.Fatalf("the sent copy:\n%s", sent)
	}
	var drafts mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=drafts", "", 200, &drafts)
	if len(drafts.Items) != 0 {
		t.Fatalf("draft left: %+v", drafts.Items)
	}

	// the badge's source and the push's
	n, err := srv.mail.account("ana", "a1").prov.Poll(t.Context(), "")
	m, ok, err2 := srv.mail.account("ana", "a1").prov.LatestUnseen(t.Context())
	if err != nil || err2 != nil || n.Unread != 3 || !ok || m.Subject != "Hello 3" {
		t.Fatalf("unread %+v %v / latest %+v %v %v", n, err, m, ok, err2)
	}
}

func TestCleanJMAPURL(t *testing.T) {
	for in, want := range map[string]string{
		"mail.x.org":                            "https://mail.x.org/.well-known/jmap",
		"https://api.fastmail.com/jmap/session": "https://api.fastmail.com/jmap/session",
		"http://127.0.0.1:8080":                 "http://127.0.0.1:8080/.well-known/jmap",
		"http://mail.x.org":                     "",
		"https://u:p@x.org":                     "",
		"":                                      "",
	} {
		got, err := cleanJMAPURL(in)
		if (want == "") != (err != nil) || got != want {
			t.Errorf("%q = %q %v, want %q", in, got, err, want)
		}
	}
}
