package main

// Data-safety seal (cleanup Phase 3, batch S3b): what the eMail writer sends
// is kept as written - a draft is never refused for an address, a file kept
// from a draft another device replaced is found again, and the user's own
// words are never rewritten by the HTML cleaner (I1, I2).
//
// These speak only the HTTP API, with plain maps (no Go type of the fix): so
// each one also runs against the code before it, and fails there.

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
)

// postMail is postForm with the JSON as a plain map.
func (f *mailFixture) postMail(t *testing.T, path string, msg map[string]any, uploads map[string]string, want int) map[string]any {
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

// mailMsg is one message as the API answers it, as a plain map.
func (f *mailFixture) mailMsg(t *testing.T, ref string) map[string]any {
	t.Helper()
	var m map[string]any
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+ref, "", 200, &m)
	return m
}

// TestDS_I1_DraftKeepsAddressAsTyped: a To like "juan" (to look up later) is
// no reason to refuse a DRAFT - every autosave failed, and the whole mail
// lived only in the open page. The draft is saved and comes back with its
// fields as typed; only Send refuses the address.
func TestDS_I1_DraftKeepsAddressAsTyped(t *testing.T) {
	f, sent := newWriteFixture(t)
	f.addAccount(t, mailTestPass, 200)
	d := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "juan, Bob <bob@example.com>", "cc": "ana@", "bcc": "Pérez",
		"subject": "Presupuesto", "text": "Un texto largo que he escrito durante media hora"}, nil, 200)
	dm := f.mailMsg(t, d["ref"].(string))
	if dm["toRest"] != "juan" || dm["ccRest"] != "ana@" || dm["bccRest"] != "Pérez" {
		t.Errorf("draft fields = to %v cc %v bcc %v, want what is no address as typed", dm["toRest"], dm["ccRest"], dm["bccRest"])
	}
	if to, _ := json.Marshal(dm["to"]); !strings.Contains(string(to), "bob@example.com") {
		t.Errorf("the draft's real To = %s, want bob@example.com", to)
	}
	if text, _ := dm["text"].(string); !strings.Contains(text, "media hora") {
		t.Errorf("draft text = %q", text)
	}
	// a draft whose addresses all parse carries no note
	ok := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Bien", "text": "x"}, nil, 200)
	if om := f.mailMsg(t, ok["ref"].(string)); om["toRest"] != nil {
		t.Errorf("a plain draft has toRest %v", om["toRest"])
	}
	// Send still refuses it, and nothing goes
	if out := f.postMail(t, "/api/mail/a1/send", map[string]any{"to": "juan", "subject": "Presupuesto", "text": "y"}, nil, 400); out["code"] != "addr" {
		t.Errorf("send to \"juan\" = %v, want code addr", out)
	}
	if len(*sent) != 0 {
		t.Errorf("sent %d", len(*sent))
	}
}

// TestDS_I1_StaleDeviceKeepFound: one draft with a file, open on two devices.
// The phone saves it (D1 -> D2, D1 gone). The PC still keeps "part 2 of D1":
// its saves and its Send used to answer "gone" for good. The file is found
// again in the newest draft with that Message-ID - the same name and bytes.
func TestDS_I1_StaleDeviceKeepFound(t *testing.T) {
	f, sent := newWriteFixture(t)
	f.addAccount(t, mailTestPass, 200)
	d1 := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Informe", "text": "v1"},
		map[string]string{"informe.pdf": "PDFBYTES"}, 200)
	ref1, mid := d1["ref"].(string), d1["mid"].(string)
	keep := []map[string]any{{"acct": "a1", "ref": ref1, "part": "2", "name": "informe.pdf", "size": 8}}
	// the phone
	f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Informe", "text": "v2 from the phone",
		"mid": mid, "draftRef": ref1, "keep": keep}, nil, 200)
	// the PC, still on D1
	pc := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Informe", "text": "v2 from the PC, long text",
		"mid": mid, "draftRef": ref1, "keep": keep}, nil, 200)
	if parts, _ := pc["parts"].([]any); len(parts) != 1 {
		t.Fatalf("PC's draft parts = %v", pc["parts"])
	}
	if text, _ := f.mailMsg(t, pc["ref"].(string))["text"].(string); !strings.Contains(text, "from the PC") {
		t.Errorf("PC's draft text = %q", text)
	}
	resp := do(t, f.owner, "GET", f.base+"/api/mail/a1/att/"+pc["ref"].(string)+"/2", nil, nil)
	if got := readBody(t, resp); string(got) != "PDFBYTES" {
		t.Errorf("PC's draft file = %q", got)
	}
	// and Send from the PC (still keeping D1's part) goes, with the file
	f.postMail(t, "/api/mail/a1/send", map[string]any{"to": "bob@example.com", "subject": "Informe", "text": "sent from the PC",
		"mid": mid, "draftRef": ref1, "keep": keep}, nil, 200)
	if len(*sent) != 1 || !strings.Contains((*sent)[0].raw, "informe.pdf") {
		t.Errorf("sent %d", len(*sent))
	}
}

// TestDS_I1_StaleKeepNeverAnotherFile: the phone put ANOTHER file of the
// same name in the draft: the PC's save is still "gone" (the app then says
// which file to add again) - never the phone's file in the PC's mail.
func TestDS_I1_StaleKeepNeverAnotherFile(t *testing.T) {
	f, _ := newWriteFixture(t)
	f.addAccount(t, mailTestPass, 200)
	d1 := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Foto", "text": "v1"},
		map[string]string{"image.png": "IMAGEN-ORIGINAL-DEL-PC"}, 200)
	ref1, mid := d1["ref"].(string), d1["mid"].(string)
	f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Foto", "text": "v2 from the phone",
		"mid": mid, "draftRef": ref1}, map[string]string{"image.png": "OTRA-IMAGEN-DEL-MOVIL"}, 200)
	keep := []map[string]any{{"acct": "a1", "ref": ref1, "part": "2", "name": "image.png", "size": len("IMAGEN-ORIGINAL-DEL-PC")}}
	if out := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Foto", "text": "v2 from the PC",
		"mid": mid, "draftRef": ref1, "keep": keep}, nil, 404); out["code"] != "gone" {
		t.Errorf("PC save = %v, want gone", out)
	}
}

// TestDS_I2_SanitizerKeepsUserText: the user's own words - "behavior:",
// "expression (", "JavaScript:" typed as TEXT - stay as written in the draft
// and in the HTML sent; inside tags and <style> they are still blocked.
func TestDS_I2_SanitizerKeepsUserText(t *testing.T) {
	f, sent := newWriteFixture(t)
	f.addAccount(t, mailTestPass, 200)
	words := "Expected behavior: it saves. The expression (a+b) is fine. Read JavaScript: the good parts. See data:text/html and cid:x."
	html := "<div>" + words + "</div>"
	d := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Bug", "text": words, "html": html}, nil, 200)
	if got, _ := f.mailMsg(t, d["ref"].(string))["html"].(string); !strings.Contains(got, words) {
		t.Errorf("the draft's HTML changed the words: %s", got)
	}
	f.postMail(t, "/api/mail/a1/send", map[string]any{"to": "bob@example.com", "subject": "Bug", "text": words, "html": html}, nil, 200)
	if raw := strings.ReplaceAll((*sent)[0].raw, "=\r\n", ""); strings.Contains(raw, "blocked") {
		t.Errorf("the mail sent has 'blocked' in it: %s", raw)
	}

	// what runs is still blocked: in tags, in <style> (closed or not)
	out := sanitizeMailHTML(`<a href="javascript:go()">a</a><div style="width:expression(alert(1))">b</div>`+
		`<style>p{behavior:url(x.htc)} q{background:url(cid:logo)}</style><p>behavior: ok</p><style>r{-moz-binding:url(y)}`, nil)
	for _, bad := range []string{"javascript:", "expression(", "behavior:url", "-moz-binding", "cid:"} {
		if strings.Contains(out, bad) {
			t.Errorf("still has %q: %s", bad, out)
		}
	}
	if !strings.Contains(out, "<p>behavior: ok</p>") {
		t.Errorf("text between tags changed: %s", out)
	}
}

// TestDS_I3_ArchivedLabelKept: a labelled Inbox mail archived on the phone
// (moved to a folder that is none of the five trays, as Gmail's archive):
// opening its label row used to drop its labels for good. Now the answer is
// "elsewhere" and the labels stay; only a mail that is NOWHERE loses them.
func TestDS_I3_ArchivedLabelKept(t *testing.T) {
	f, _ := newWriteFixture(t)
	appendMail(t, f.addr, "INBOX", plainMail(1), false)
	c, err := dialMemIMAP(f.addr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Create("Archive", nil).Wait()
	f.addAccount(t, mailTestPass, 200)
	var lab map[string]any
	f.call(t, f.owner, "POST", "/api/mail/labels", `{"name":"Trabajo"}`, 200, &lab)
	var inbox mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox", "", 200, &inbox)
	row := inbox.Items[0]
	f.call(t, f.owner, "POST", "/api/mail/a1/labels", `{"refs":["`+row.Ref+`"],"add":["`+lab["id"].(string)+`"]}`, 200, nil)
	// the phone archives it
	if _, err := c.Select("INBOX", nil).Wait(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Move(imap.SeqSetNum(1), "Archive").Wait(); err != nil {
		t.Fatal(err)
	}
	labelRows := func() int {
		var rows struct{ Items []MailSummary }
		f.call(t, f.owner, "GET", "/api/mail/label/"+lab["id"].(string), "", 200, &rows)
		return len(rows.Items)
	}
	var out map[string]any
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+row.Ref+"?mid="+row.MessageID, "", 404, &out)
	if out["code"] != "elsewhere" {
		t.Errorf("opening the archived mail = %v, want code elsewhere", out)
	}
	raw, _ := os.ReadFile(filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "mail", "labels.json"))
	if labelRows() != 1 || !strings.Contains(string(raw), row.MessageID) {
		t.Errorf("the archived mail lost its label: rows %d, labels.json %s", labelRows(), raw)
	}
	// deleted for good on the phone: NOW its labels go
	if _, err := c.Select("Archive", nil).Wait(); err != nil {
		t.Fatal(err)
	}
	c.Store(imap.SeqSetNum(1), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close()
	c.Expunge().Close()
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+row.Ref+"?mid="+row.MessageID, "", 404, &out)
	if out["code"] != "gone" || labelRows() != 0 {
		t.Errorf("a mail gone for good = %v, label rows %d", out, labelRows())
	}
}

// TestDS_I5_SentCopyFailsDraftKept: SMTP took the mail but its copy in Sent
// failed (no Sent folder, a full mailbox): the draft is the only copy of what
// was written - it stays, and the answer says "no copy".
func TestDS_I5_SentCopyFailsDraftKept(t *testing.T) {
	f, sent := newWriteFixture(t)
	c, err := dialMemIMAP(f.addr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Delete("Sent Items").Wait(); err != nil {
		t.Fatal(err)
	}
	c.Close()
	f.addAccount(t, mailTestPass, 200)
	d1 := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Contrato", "text": "El texto del contrato"}, nil, 200)
	out := f.postMail(t, "/api/mail/a1/send", map[string]any{"to": "bob@example.com", "subject": "Contrato", "text": "El texto del contrato",
		"mid": d1["mid"], "draftRef": d1["ref"]}, nil, 200)
	if len(*sent) != 1 || out["ok"] != true || out["noCopy"] != true {
		t.Errorf("sent %d, answer %v: want ok + noCopy", len(*sent), out)
	}
	var drafts mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=drafts", "", 200, &drafts)
	if len(drafts.Items) != 1 || drafts.Items[0].Subject != "Contrato" {
		t.Errorf("drafts = %+v: the draft must stay", drafts.Items)
	}
}

// TestDS_I6_SendTwiceRefused: a send whose answer was lost (the writer came
// back "not sent") must not go twice: the same draft (its Message-ID) sent
// again within minutes is refused - after a restart too.
func TestDS_I6_SendTwiceRefused(t *testing.T) {
	f, sent := newWriteFixture(t)
	f.addAccount(t, mailTestPass, 200)
	mid := "nayive.dsonce@example.com"
	d1 := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Una vez", "text": "x", "mid": mid}, nil, 200)
	f.postMail(t, "/api/mail/a1/send", map[string]any{"to": "bob@example.com", "subject": "Una vez", "text": "x",
		"mid": mid, "draftRef": d1["ref"]}, nil, 200)
	// the answer never arrived: the app saves the draft again and sends again
	d2 := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Una vez", "text": "x",
		"mid": mid, "draftRef": d1["ref"]}, nil, 200)
	if out := f.postMail(t, "/api/mail/a1/send", map[string]any{"to": "bob@example.com", "subject": "Una vez", "text": "x",
		"mid": mid, "draftRef": d2["ref"]}, nil, 409); out["code"] != "sent" {
		t.Errorf("second send = %v, want 409 sent", out)
	}
	// a restart: the hub reads its files again
	f.srv.mail.mu.Lock()
	delete(f.srv.mail.owners, "ana")
	f.srv.mail.mu.Unlock()
	f.postMail(t, "/api/mail/a1/send", map[string]any{"to": "bob@example.com", "subject": "Una vez", "text": "x",
		"mid": mid, "draftRef": d2["ref"]}, nil, 409)
	if len(*sent) != 1 {
		t.Errorf("sent %d times, want once", len(*sent))
	}
	var drafts mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=drafts", "", 200, &drafts)
	if len(drafts.Items) != 1 {
		t.Errorf("drafts = %+v: the refused one's draft stays", drafts.Items)
	}
	// another draft goes as usual
	f.postMail(t, "/api/mail/a1/send", map[string]any{"to": "bob@example.com", "subject": "Otra", "text": "y", "mid": "nayive.dsother@example.com"}, nil, 200)
	if len(*sent) != 2 {
		t.Errorf("sent %d, want 2", len(*sent))
	}
}

// TestDS_I7_TrashNeverNestedGuess: a server without folder roles: a user's
// folder "Archive/Bin" listed before the real "Trash" was taken as THE Trash
// - Delete moved Inbox mail into it, and the purge deleted for good what the
// user keeps there.
func TestDS_I7_TrashNeverNestedGuess(t *testing.T) {
	got := mapIMAPFolders([]*imap.ListData{{Mailbox: "Archive", Delim: '/'}, {Mailbox: "Archive/Bin", Delim: '/'},
		{Mailbox: "INBOX", Delim: '/'}, {Mailbox: "Trash", Delim: '/'}})
	if got[RoleTrash] != "Trash" {
		t.Errorf("trash = %q, want Trash", got[RoleTrash])
	}
	if got := mapIMAPFolders([]*imap.ListData{{Mailbox: "INBOX", Delim: '.'}, {Mailbox: "INBOX.Clientes.Papelera", Delim: '.'}}); got[RoleTrash] != "" {
		t.Errorf("a nested Papelera became the Trash: %q", got[RoleTrash])
	}
	if got := mapIMAPFolders([]*imap.ListData{{Mailbox: "INBOX", Delim: '.'}, {Mailbox: "INBOX.Trash", Delim: '.'}}); got[RoleTrash] != "INBOX.Trash" {
		t.Errorf("Courier's INBOX.Trash not found: %q", got[RoleTrash])
	}
	// Spam too ("Empty Spam" deletes for good); Sent is still found where it is
	got = mapIMAPFolders([]*imap.ListData{{Mailbox: "INBOX", Delim: '/'}, {Mailbox: "Old/Junk", Delim: '/'}, {Mailbox: "Mail/Sent", Delim: '/'}})
	if got[RoleSpam] != "" || got[RoleSent] != "Mail/Sent" {
		t.Errorf("spam = %q, sent = %q: want none, Mail/Sent", got[RoleSpam], got[RoleSent])
	}

	f := newMailFixture(t)
	c, err := dialMemIMAP(f.addr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	if err != nil {
		t.Fatal(err)
	}
	c.Create("Archive", nil).Wait()
	c.Create("Archive/Bin", nil).Wait()
	c.Close()
	appendMail(t, f.addr, "Archive/Bin", plainMail(7), true) // the user's own kept mail
	f.addAccount(t, mailTestPass, 200)
	a := f.srv.mail.account("ana", "a1")
	if _, err := f.srv.mail.purgeAccount(t.Context(), "ana", a, false); err != nil {
		t.Fatal(err)
	}
	f.srv.mail.mu.Lock()
	for k, e := range f.srv.mail.owners["ana"].trash {
		e.At = e.At.Add(-31 * 24 * time.Hour)
		f.srv.mail.owners["ana"].trash[k] = e
	}
	f.srv.mail.mu.Unlock()
	f.srv.mail.purgeAccount(t.Context(), "ana", a, false)
	c, _ = dialMemIMAP(f.addr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	defer c.Close()
	if d, err := c.Select("Archive/Bin", nil).Wait(); err != nil || d.NumMessages != 1 {
		t.Errorf("the user's Archive/Bin lost its mail (%v)", err)
	}
}

// TestDS_I8_JMAPPurgeKeepsFolderCopy: JMAP - an Email in the Inbox AND a
// folder of its own: Delete keeps the folder (by design); the purge or
// Empty Trash took it out of Trash by DESTROYING it, so it left the folder
// the user still sees it in. Now it only leaves the Trash.
func TestDS_I8_JMAPPurgeKeepsFolderCopy(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	id := fj.add(plainMail(1), "mb-inbox", true)
	fj.emails[id].boxes["mb-work"] = true
	only := fj.add(plainMail(2), "mb-inbox", true) // in no folder of its own
	if _, err := p.Set(t.Context(), []MailRef{{Role: RoleInbox, ID: id}, {Role: RoleInbox, ID: only}}, MailChange{Move: RoleTrash}); err != nil {
		t.Fatal(err)
	}
	rows, _ := p.Scan(t.Context(), RoleTrash)
	var refs []MailRef
	for _, r := range rows {
		ref, _ := parseMailRef(r.Ref)
		refs = append(refs, ref)
	}
	if err := p.Expunge(t.Context(), refs); err != nil {
		t.Fatal(err)
	}
	if e := fj.emails[id]; e == nil || !e.boxes["mb-work"] || e.boxes["mb-trash"] {
		t.Errorf("the Email kept in a folder: %+v, want it in mb-work only", e)
	}
	if fj.emails[only] != nil {
		t.Error("an Email in the Trash alone was not deleted")
	}
}

// TestDS_I9_RestoreBothCopies: a mail to yourself sits in the Inbox AND in
// Sent with one Message-ID; both deleted, the Undo (by Message-ID) restored
// one and counted two - the other stayed in the Trash to be purged.
func TestDS_I9_RestoreBothCopies(t *testing.T) {
	f, _ := newWriteFixture(t)
	appendMail(t, f.addr, "INBOX", plainMail(1), true)
	appendMail(t, f.addr, "Sent Items", plainMail(1), true)
	f.addAccount(t, mailTestPass, 200)
	var inbox, sentTray mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox", "", 200, &inbox)
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=sent", "", 200, &sentTray)
	refs, _ := json.Marshal([]string{inbox.Items[0].Ref, sentTray.Items[0].Ref})
	f.call(t, f.owner, "POST", "/api/mail/a1/set", `{"refs":`+string(refs)+`,"tray":"trash"}`, 200, nil)
	mid := inbox.Items[0].MessageID
	var out map[string]any
	f.call(t, f.owner, "POST", "/api/mail/a1/restore", `{"mids":["`+mid+`","`+mid+`"]}`, 200, &out)
	var trash mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=trash", "", 200, &trash)
	if len(trash.Items) != 0 || out["restored"] != float64(2) {
		t.Errorf("restored %v, trash still has %d", out["restored"], len(trash.Items))
	}
}

// TestDS_I10_SettingsTwoDevicesAtOnce: the phone saves trashDays while the
// PC saves the signature: each request read the settings, let go, changed
// one field and wrote - the later one put back the other's old value.
func TestDS_I10_SettingsTwoDevicesAtOnce(t *testing.T) {
	f := newMailFixture(t)
	f.call(t, f.owner, "GET", "/api/mail/settings", "", 200, nil)
	put := func(body string, done chan<- int) {
		req, _ := http.NewRequest("PUT", f.base+"/api/mail/settings", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := f.owner.Do(req)
		if err != nil {
			done <- 0
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}
	// both requests waiting on the hub's lock (held here), so they then run
	// as close together as two devices can make them
	waiting := func() int {
		buf := make([]byte, 1<<20)
		n := runtime.Stack(buf, true)
		return strings.Count(string(buf[:n]), "(*Server).mailUserRoute")
	}
	for i := 1; i <= 20; i++ {
		f.srv.mail.mu.Lock()
		done := make(chan int, 2)
		go put(`{"trashDays":`+strconv.Itoa(i)+`}`, done)
		go put(`{"signature":"Firma `+strconv.Itoa(i)+`"}`, done)
		for end := time.Now().Add(5 * time.Second); waiting() < 2 && time.Now().Before(end); {
			runtime.Gosched()
		}
		f.srv.mail.mu.Unlock()
		if a, b := <-done, <-done; a != 200 || b != 200 {
			t.Fatalf("PUTs = %d %d", a, b)
		}
		var st map[string]any
		f.call(t, f.owner, "GET", "/api/mail/settings", "", 200, &st)
		if st["trashDays"] != float64(i) || st["signature"] != "Firma "+strconv.Itoa(i) {
			t.Fatalf("round %d: settings = %v, want both changes", i, st)
		}
	}
}

// TestDS_J8_PurgeWaitsOnClockJump: the clock is days ahead of the purge's
// last run (a wrong clock at boot): the automatic purge must not delete what
// the user still has days to get back - it waits.
func TestDS_J8_PurgeWaitsOnClockJump(t *testing.T) {
	f := newMailFixture(t)
	appendMail(t, f.addr, "Trash", plainMail(1), true)
	f.addAccount(t, mailTestPass, 200)
	a := f.srv.mail.account("ana", "a1")
	if _, err := f.srv.mail.purgeAccount(t.Context(), "ana", a, false); err != nil { // its first run
		t.Fatal(err)
	}
	// that run was 40 days ago, by the clock now
	dir := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "mail")
	old := time.Now().Add(-40 * 24 * time.Hour).UTC().Format(time.RFC3339)
	os.WriteFile(filepath.Join(dir, "state.json"), []byte(`{"sent":{},"trash":{},"purgeAt":"`+old+`"}`), 0o600)
	f.srv.mail.mu.Lock()
	delete(f.srv.mail.owners, "ana") // read the files again
	f.srv.mail.mu.Unlock()
	a = f.srv.mail.account("ana", "a1")
	f.srv.mail.mu.Lock()
	u := f.srv.mail.owners["ana"]
	for k, e := range u.trash { // in the Trash 31 days by the jumped clock
		e.At = time.Now().Add(-31 * 24 * time.Hour)
		u.trash[k] = e
	}
	f.srv.mail.mu.Unlock()
	n, _ := f.srv.mail.purgeAccount(t.Context(), "ana", a, false)
	var trash mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=trash", "", 200, &trash)
	if n != 0 || len(trash.Items) != 1 {
		t.Errorf("the purge deleted %d after a clock jump (trash now %d)", n, len(trash.Items))
	}
}

// TestDS_L1_PurgeStopsWhenAccountGone: a purge holding an account that is
// no longer the user's (removed meanwhile; or the user deleted and made
// again under the same name, whose "a1" is another mailbox) stops: it never
// deletes for good, nor notes clocks, for the wrong person.
func TestDS_L1_PurgeStopsWhenAccountGone(t *testing.T) {
	f := newMailFixture(t)
	appendMail(t, f.addr, "Trash", plainMail(1), true)
	f.addAccount(t, mailTestPass, 200)
	stale := f.srv.mail.account("ana", "a1")
	// the user made again: the hub reads her files afresh - other accounts
	f.srv.mail.mu.Lock()
	delete(f.srv.mail.owners, "ana")
	f.srv.mail.mu.Unlock()
	if n, _ := f.srv.mail.purgeAccount(t.Context(), "ana", stale, true); n != 0 {
		t.Errorf("a purge with the old account deleted %d", n)
	}
	// the account removed
	a := f.srv.mail.account("ana", "a1")
	f.call(t, f.owner, "DELETE", "/api/mail/accounts/a1", "", 200, nil)
	if n, _ := f.srv.mail.purgeAccount(t.Context(), "ana", a, true); n != 0 {
		t.Errorf("a purge with a removed account deleted %d", n)
	}
	c, err := dialMemIMAP(f.addr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if d, err := c.Select("Trash", nil).Wait(); err != nil || d.NumMessages != 1 {
		t.Errorf("the Trash lost its mail (%v)", err)
	}
}

// TestDS_I1_StaleKeepSizeFromOpenedDraft: the PC opened the draft (after a
// reload), so the size it holds for its file is the one the server LISTS -
// for IMAP an estimate from the encoded length, not the file's bytes. The
// phone re-saves the draft; the PC's next save still finds the file.
func TestDS_I1_StaleKeepSizeFromOpenedDraft(t *testing.T) {
	f, _ := newWriteFixture(t)
	f.addAccount(t, mailTestPass, 200)
	file := strings.Repeat("0123456789", 100) // 1000 bytes
	d1 := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Informe", "text": "v1"},
		map[string]string{"informe.pdf": file}, 200)
	ref1, mid := d1["ref"].(string), d1["mid"].(string)
	parts, _ := f.mailMsg(t, ref1)["parts"].([]any)
	if len(parts) != 1 {
		t.Fatalf("parts = %v", parts)
	}
	p := parts[0].(map[string]any)
	if p["size"] == float64(len(file)) {
		t.Logf("(the listed size is the real one here: %v)", p["size"])
	}
	keep := []map[string]any{{"acct": "a1", "ref": ref1, "part": p["id"], "name": "informe.pdf", "size": p["size"]}}
	f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Informe", "text": "v2 from the phone",
		"mid": mid, "draftRef": ref1, "keep": keep}, nil, 200)
	pc := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Informe", "text": "v2 from the PC",
		"mid": mid, "draftRef": ref1, "keep": keep}, nil, 200)
	resp := do(t, f.owner, "GET", f.base+"/api/mail/a1/att/"+pc["ref"].(string)+"/2", nil, nil)
	if got := readBody(t, resp); string(got) != file {
		t.Errorf("PC's draft file = %d bytes, want the 1000 of informe.pdf", len(got))
	}
}

// TestDS_I2_SanitizerQuotedTags: a ">" inside a quoted value (title=">")
// ended the tag for the cleaner, so what came after it in the tag - a
// javascript: link, an on* handler, a CSS expression, a cid: - was left as
// it was; a tag whose quote never closes is still cleaned; and a "<style>"
// inside an attribute's quotes is no <style>: the words after it stay.
func TestDS_I2_SanitizerQuotedTags(t *testing.T) {
	attacks := []string{
		`<a href="javascript:alert(1)">x</a>`,
		`<a href="&#106;avascript:alert(1)">x</a>`,
		`<a title=">" href="javascript:alert(1)">x</a>`,
		`<a title='>' href='javascript:alert(1)'>x</a>`,
		`<img title=">" src=x onerror="alert(1)">`,
		`<img src=x onerror=alert(1)>`,
		`<div style="background:url(javascript:alert(1))">x</div>`,
		`<div title=">" style="width:expression(alert(1))">x</div>`,
		`<style>body{behavior:url(x.htc)}</style>`,
		`<style>@import "javascript:alert(1)";</style>`,
		`<style title=">">body{background:url(javascript:alert(1))}</style>`,
		`<style>p{-moz-binding:url(y)}`,
		`<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`,
		`<a title=">" href="data:text/html,<script>alert(1)</script>">x</a>`,
		`<!--><a href="javascript:alert(1)">x</a>-->`,
		`<!-- <a title="--><a href='javascript:alert(1)'>x</a>">`,
		`<a href="vbscript:msgbox(1)">x</a>`,
		`<img alt=">" src="cid:logo">`,
		`<a href=javascript:alert(1)>x</a>`,
		`<a href="java&#x09;script:alert(1)">x</a>`,
		`<a href="javascript:alert(1)>x</a><b title="y">z</b>`, // its quote never closes
		`<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
	}
	for _, in := range attacks {
		out := strings.ToLower(sanitizeMailHTML(in, func(string) string { return "/att/x" }))
		for _, bad := range []string{"javascript:", "vbscript:", "expression(", "behavior:", "-moz-binding", "data:text/html", "onerror=", "cid:"} {
			if strings.Contains(out, bad) {
				t.Errorf("%s\n  -> %s\n  still has %q", in, out, bad)
			}
		}
	}
	for _, in := range []string{
		`<style>a{x:y}</style ><p>behavior: ok</p>`,
		`<p>Expected behavior: it saves. JavaScript: the good parts. expression (a+b)</p>`,
		`<div title="<style>">Expected behavior: ok</div>`,
	} {
		if out := sanitizeMailHTML(in, nil); out != in {
			t.Errorf("the words changed:\n  %s\n  -> %s", in, out)
		}
	}
}

// TestDS_I6_SendLetGoAfterPanic: a send that broke half way (a panic in the
// mail code) must not leave its draft held as "being sent" - every Send of
// it after would be refused until a restart.
func TestDS_I6_SendLetGoAfterPanic(t *testing.T) {
	f, _ := newWriteFixture(t)
	boom := true
	var sent []string
	f.srv.mail.newProvider = func(a MailAccount) MailProvider {
		p := newIMAPProvider(a)
		p.dial = dialMemIMAP(f.addr)
		p.smtpCheck = noSMTPCheck
		p.smtp = func(_ context.Context, _ MailAccount, _ string, _ []string, raw []byte) error {
			if boom {
				boom = false
				panic("broken half way")
			}
			sent = append(sent, string(raw))
			return nil
		}
		return p
	}
	f.addAccount(t, mailTestPass, 200)
	mid := "nayive.dspanic@example.com"
	msg := map[string]any{"to": "bob@example.com", "subject": "Otra vez", "text": "x", "mid": mid}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	raw, _ := json.Marshal(msg)
	mw.WriteField("json", string(raw))
	mw.Close()
	req, _ := http.NewRequest("POST", f.base+"/api/mail/a1/send", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if resp, err := f.owner.Do(req); err == nil {
		resp.Body.Close()
		if resp.StatusCode == 200 {
			t.Fatal("the broken send answered 200")
		}
	}
	f.postMail(t, "/api/mail/a1/send", msg, nil, 200)
	if len(sent) != 1 {
		t.Errorf("sent %d, want 1", len(sent))
	}
}

// TestDS_F4_DamagedLabelsSaid: a damaged labels.json (never written over,
// batch S1) is said as such - code "damaged" - not as "the server is down".
func TestDS_F4_DamagedLabelsSaid(t *testing.T) {
	f := newMailFixture(t)
	dir := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "mail")
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "labels.json"), []byte(`{"labels":[{"id":"l1"`), 0o600)
	var out map[string]any
	f.call(t, f.owner, "POST", "/api/mail/labels", `{"name":"Nueva"}`, 500, &out)
	if out["code"] != "damaged" {
		t.Errorf("a new label over a damaged labels.json = %v, want code damaged", out)
	}
}
