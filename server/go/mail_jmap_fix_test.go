package main

// =============================================================================
// eMail over JMAP: the fixes of docs/audit/email.md, each against the fake
// server (mail_jmap_fake_test.go) - the way out (#2), deleting only what is
// still there (#5), drafts that never lose their files (#10), paging by
// anchor (#17), whole-tray scans (#18), "using" (#19), pictures between
// texts (#25), exact Message-IDs (#32), moves that keep folders (#33, #70),
// refusals one by one and in words (#34, #37), no Sent box (#35), the
// server's limits (#36), the send check (#45), cut bodies (#71), identities
// (#68, #69), big files (#72), retries (#73), the upload's answer (#74), and
// the poller's marks.
// =============================================================================

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func fakeJMAPProv(fj *fakeJMAP) *jmapProvider {
	return newJMAPProvider(MailAccount{Email: "ana@fast.test", Pass: "tok-123", Kind: "jmap",
		JMAPURL: fj.srv.URL + "/jmap/session"})
}

// withGuard turns the network guard on for one test.
func withGuard(t *testing.T) {
	mailNetGuard = true
	t.Cleanup(func() { mailNetGuard = false })
}

func rejectText(err error) string {
	var re *mailRejectError
	if errors.As(err, &re) {
		return re.Text
	}
	return ""
}

func TestJMAPNetGuard(t *testing.T) {
	fj := newFakeJMAP(t)
	fj.add(plainMail(1), "mb-inbox", false)

	// a redirect (the .well-known) is followed while it stays in bounds
	p := newJMAPProvider(MailAccount{Email: "ana@fast.test", Pass: "tok-123", Kind: "jmap", JMAPURL: fj.srv.URL + "/.well-known/jmap"})
	if res, err := p.Poll(t.Context(), ""); err != nil || res.Unread != 1 {
		t.Fatalf("through a redirect: %+v %v", res, err)
	}

	withGuard(t)
	// never into this server's own network, whatever the session says
	if _, err := fakeJMAPProv(fj).Poll(t.Context(), ""); !errors.Is(err, errMailPrivateNet) {
		t.Fatalf("127.0.0.1 with the guard on: %v", err)
	}
	// the session's URLs: https only (another domain is fine: Fastmail)
	ok := &jmapSession{APIURL: "https://api.fastmail.com/jmap/api/", DownloadURL: "https://www.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}"}
	bad := &jmapSession{APIURL: "https://api.x.test/api", DownloadURL: "http://169.254.169.254/latest/{blobId}"}
	if ok.check() != nil || !errors.Is(bad.check(), errMailRejected) {
		t.Fatalf("session urls: %v / %v", ok.check(), bad.check())
	}
	req := func(u string) *http.Request { r, _ := http.NewRequest("GET", u, nil); return r }
	if jmapRedirect(req("http://mail.x.test/s"), nil) == nil || jmapRedirect(req("https://mail.x.test/s"), nil) != nil ||
		jmapRedirect(req("https://mail.x.test/s"), make([]*http.Request, 5)) == nil {
		t.Fatal("redirect rules")
	}
}

func TestJMAPExpungeLeavesMoved(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	sentElsewhere := fj.add(plainMail(1), "mb-sent", true) // a draft sent from Fastmail's own app
	inInbox := fj.add(plainMail(2), "mb-inbox", true)      // restored on another device
	draft := fj.add(plainMail(3), "mb-drafts", true)
	fj.emails[draft].keywords["$draft"] = true

	if err := p.Expunge(t.Context(), []MailRef{{Role: RoleDrafts, ID: sentElsewhere}}); !errors.Is(err, errMailGone) || fj.emails[sentElsewhere] == nil {
		t.Fatalf("a draft that became a sent mail: %v, still there %v", err, fj.emails[sentElsewhere] != nil)
	}
	if err := p.Expunge(t.Context(), []MailRef{{Role: RoleTrash, ID: inInbox}}); !errors.Is(err, errMailGone) || fj.emails[inInbox] == nil {
		t.Fatalf("a stale Trash ref: %v", err)
	}
	if err := p.Expunge(t.Context(), []MailRef{{Role: RoleDrafts, ID: draft}}); err != nil || fj.emails[draft] != nil {
		t.Fatalf("a real draft: %v", err)
	}
	// the writer autosaving over a draft that was sent meanwhile: a new draft, the sent mail kept
	ref, _, err := p.SaveDraft(t.Context(), []byte(strings.ReplaceAll(plainMail(4), "\n", "\r\n")), "m4@example.com",
		&MailRef{Role: RoleDrafts, ID: sentElsewhere})
	if err != nil || ref.ID == "" || fj.emails[sentElsewhere] == nil {
		t.Fatalf("autosave: %v %v", ref, err)
	}
}

func TestJMAPSaveDraftSafe(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	withFile := "From: ana@fast.test\r\nTo: bob@example.com\r\nSubject: D\r\nMessage-ID: <d@x>\r\nMIME-Version: 1.0\r\n" +
		"Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nhola\r\n" +
		"--B\r\nContent-Type: text/plain; name=n.txt\r\nContent-Disposition: attachment; filename=n.txt\r\n\r\nnota\r\n--B--\r\n"
	ref1, parts, err := p.SaveDraft(t.Context(), []byte(withFile), "d@x", nil)
	if err != nil || len(parts) != 1 || parts[0].Name != "n.txt" {
		t.Fatalf("first save: %v %+v %v", ref1, parts, err)
	}
	drafts := func() int {
		n := 0
		for _, e := range fj.emails {
			if e.boxes["mb-drafts"] {
				n++
			}
		}
		return n
	}
	// the parts cannot be read: the new one goes again, the old one stays
	fj.failGets = 2
	if _, _, err := p.SaveDraft(t.Context(), []byte(withFile), "d@x", &ref1); err == nil || fj.emails[ref1.ID] == nil || drafts() != 1 {
		t.Fatalf("parts unknown: %v, old there %v, drafts %d", err, fj.emails[ref1.ID] != nil, drafts())
	}
	// the old one refused: the new ref, with its parts, and errMailLeftover
	fj.refuseDestroy[ref1.ID] = "forbidden"
	ref2, parts, err := p.SaveDraft(t.Context(), []byte(withFile), "d@x", &ref1)
	if !errors.Is(err, errMailLeftover) || ref2.ID == "" || len(parts) != 1 || drafts() != 2 {
		t.Fatalf("leftover: %v %+v %v, drafts %d", ref2, parts, err, drafts())
	}
}

func TestJMAPListAnchor(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	for i := 1; i <= 60; i++ {
		fj.add(plainMail(i), "mb-inbox", true)
	}
	p1, err := p.List(t.Context(), RoleInbox, "", "")
	if err != nil || len(p1.Items) != 50 {
		t.Fatalf("page 1: %d %v", len(p1.Items), err)
	}
	// three of page 1 go to the Trash while page 2 has not come yet
	var refs []MailRef
	for _, it := range p1.Items[:3] {
		r, _ := parseMailRef(it.Ref)
		refs = append(refs, r)
	}
	if _, err := p.Set(t.Context(), refs, MailChange{Move: RoleTrash}); err != nil {
		t.Fatal(err)
	}
	p2, err := p.List(t.Context(), RoleInbox, "", p1.Next)
	if err != nil || len(p2.Items) != 10 || p2.Items[9].Subject != "Hello 1" || p2.Next != "" {
		t.Fatalf("page 2: %d %v (next %q)", len(p2.Items), err, p2.Next)
	}
	// the last one shown is gone: by position instead, no error
	last, _ := parseMailRef(p1.Items[49].Ref)
	delete(fj.emails, last.ID)
	if p2, err = p.List(t.Context(), RoleInbox, "", p1.Next); err != nil || len(p2.Items) == 0 {
		t.Fatalf("anchor gone: %d %v", len(p2.Items), err)
	}
	// a cursor of before (a bare position) still works
	if p2, err = p.List(t.Context(), RoleInbox, "", "50"); err != nil {
		t.Fatalf("old cursor: %v", err)
	}
}

func TestJMAPScanPages(t *testing.T) {
	fj := newFakeJMAP(t)
	fj.maxGet = 50
	p := fakeJMAPProv(fj)
	for i := 1; i <= 120; i++ {
		fj.add(plainMail(i), "mb-trash", true)
	}
	rows, err := p.Scan(t.Context(), RoleTrash)
	seen := map[string]bool{}
	for _, r := range rows {
		seen[r.Ref] = true
	}
	if err != nil || len(rows) != 120 || len(seen) != 120 {
		t.Fatalf("scan: %d rows, %d distinct, %v", len(rows), len(seen), err)
	}
}

func TestJMAPUsing(t *testing.T) {
	fj := newFakeJMAP(t)
	fj.add(plainMail(1), "mb-inbox", false)
	p := fakeJMAPProv(fj)
	if _, err := p.Poll(t.Context(), ""); err != nil {
		t.Fatal(err)
	}
	for _, u := range fj.usings {
		if contains(u, jmapSubmission) {
			t.Fatalf("reading asked for submission: %v", u)
		}
	}
	raw := []byte(strings.ReplaceAll(plainMail(9), "\n", "\r\n"))
	if err := p.Send(t.Context(), raw, raw, "ana@fast.test", []string{"bob@example.com"}); err != nil ||
		!contains(fj.usings[len(fj.usings)-1], jmapSubmission) {
		t.Fatalf("send: %v, using %v", err, fj.usings[len(fj.usings)-1])
	}

	// a server (or a token) without submission: reading works, sending is refused in words
	fj2 := newFakeJMAP(t)
	fj2.noSub = true
	fj2.add(plainMail(1), "mb-inbox", false)
	p2 := fakeJMAPProv(fj2)
	if res, err := p2.Poll(t.Context(), ""); err != nil || res.Unread != 1 {
		t.Fatalf("read without submission: %+v %v", res, err)
	}
	if err := p2.Send(t.Context(), raw, raw, "ana@fast.test", []string{"bob@example.com"}); !errors.Is(err, errMailRejected) {
		t.Fatalf("send without submission: %v", err)
	}
	if err := p2.CheckSend(t.Context()); !errors.Is(err, errMailRejected) {
		t.Fatalf("check without submission: %v", err)
	}
}

func TestJMAPInlineMedia(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	jpeg := []byte("JPEGDATA-not-really")
	id := fj.add("From: Ana <ana@fast.test>\nTo: bob@example.com\nSubject: Foto\nMessage-ID: <apple@x>\nMIME-Version: 1.0\n"+
		"Content-Type: multipart/mixed; boundary=\"B\"\n\n"+
		"--B\nContent-Type: text/plain; charset=utf-8\n\nBefore the photo.\n"+
		"--B\nContent-Type: image/jpeg; name=\"photo.jpg\"\nContent-Disposition: inline; filename=\"photo.jpg\"\n"+
		"Content-Transfer-Encoding: base64\n\n"+base64.StdEncoding.EncodeToString(jpeg)+"\n"+
		"--B\nContent-Type: text/plain; charset=utf-8\n\nAfter the photo.\n--B--\n", "mb-inbox", false)
	msg, err := p.Message(t.Context(), MailRef{Role: RoleInbox, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	var photo MailPart
	for _, pt := range msg.Parts {
		if pt.Name == "photo.jpg" {
			photo = pt
		}
	}
	if !strings.Contains(msg.Text, "Before the photo.\n") || !strings.Contains(msg.Text, "After the photo.") ||
		photo.ID == "" || !photo.Inline || !strings.Contains(msg.HTML, `<img src="cid:`+photo.CID+`">`) ||
		strings.Index(msg.HTML, "Before") > strings.Index(msg.HTML, "cid:") || strings.Index(msg.HTML, "cid:") > strings.Index(msg.HTML, "After") {
		t.Fatalf("text %q\nhtml %q\nparts %+v", msg.Text, msg.HTML, msg.Parts)
	}
	if _, data, err := p.Attachment(t.Context(), MailRef{Role: RoleInbox, ID: id}, photo.ID); err != nil || string(data) != string(jpeg) {
		t.Fatalf("the photo: %q %v", data, err)
	}
	// the rich mail's cid picture stays inline, its PDF a file
	rich := fj.add(richMail(), "mb-inbox", false)
	msg, _ = p.Message(t.Context(), MailRef{Role: RoleInbox, ID: rich})
	inline, files := 0, 0
	for _, pt := range msg.Parts {
		if pt.Inline {
			inline++
		} else {
			files++
		}
	}
	if inline != 1 || files != 1 {
		t.Fatalf("rich parts: %+v", msg.Parts)
	}
}

func TestJMAPFindExact(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	mail := func(mid string) string {
		return "From: bob@example.com\nTo: ana@fast.test\nSubject: " + mid + "\nMessage-ID: <" + mid + ">\n\nx\n"
	}
	want := fj.add(mail("12@x.com"), "mb-inbox", true)
	fj.add(mail("412@x.com"), "mb-inbox", true) // newer, and a text match too
	got, err := p.Find(t.Context(), "12@x.com", nil)
	if err != nil || got.Ref != "inbox.j."+want {
		t.Fatalf("find: %+v %v", got, err)
	}
	if _, err := p.Find(t.Context(), "2@x.com", nil); !errors.Is(err, errMailGone) {
		t.Fatalf("a partial id: %v", err)
	}
}

func TestJMAPMoveKeepsFolders(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	id := fj.add(plainMail(1), "mb-inbox", true)
	fj.emails[id].boxes["mb-work"] = true // a Fastmail folder/label too
	moved, err := p.Set(t.Context(), []MailRef{{Role: RoleInbox, ID: id}}, MailChange{Move: RoleTrash})
	b := fj.emails[id].boxes
	if err != nil || moved["inbox.j."+id] != (MailRef{Role: RoleTrash, ID: id}) || !b["mb-trash"] || !b["mb-work"] || b["mb-inbox"] || len(b) != 2 {
		t.Fatalf("to the Trash: %v %v, boxes %v", moved, err, b)
	}
	if _, err := p.Set(t.Context(), []MailRef{{Role: RoleTrash, ID: id}}, MailChange{Move: RoleInbox}); err != nil ||
		!b["mb-inbox"] || !b["mb-work"] || b["mb-trash"] {
		t.Fatalf("restored: %v, boxes %v", err, b)
	}
	// Spam trains the server: $junk in, $notjunk out
	if _, err := p.Set(t.Context(), []MailRef{{Role: RoleInbox, ID: id}}, MailChange{Move: RoleSpam}); err != nil ||
		!fj.emails[id].keywords["$junk"] || fj.emails[id].keywords["$notjunk"] {
		t.Fatalf("spam: %v %v", err, fj.emails[id].keywords)
	}
	if _, err := p.Set(t.Context(), []MailRef{{Role: RoleSpam, ID: id}}, MailChange{Move: RoleInbox}); err != nil ||
		fj.emails[id].keywords["$junk"] || !fj.emails[id].keywords["$notjunk"] || !fj.emails[id].boxes["mb-inbox"] {
		t.Fatalf("not spam: %v %v %v", err, fj.emails[id].keywords, fj.emails[id].boxes)
	}
}

func TestJMAPRefusedOneByOne(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	a := fj.add(plainMail(1), "mb-inbox", false)
	b := fj.add(plainMail(2), "mb-inbox", false)
	refs := []MailRef{{Role: RoleInbox, ID: a}, {Role: RoleInbox, ID: b}}
	fj.refuseUpdate[a] = "forbidden"
	_, err := p.Set(t.Context(), refs, MailChange{Seen: new(true)})
	if f := mailFailed(err); len(f) != 1 || !f["inbox.j."+a] || !fj.emails[b].keywords["$seen"] {
		t.Fatalf("one refused: %v", err)
	}
	fj.refuseUpdate[b] = "forbidden"
	if _, err := p.Set(t.Context(), refs, MailChange{Seen: new(true)}); !strings.Contains(rejectText(err), "does not allow") {
		t.Fatalf("all refused: %v", err)
	}
	moved, err := p.Set(t.Context(), refs, MailChange{Move: RoleTrash})
	if len(moved) != 0 || !errors.Is(err, errMailRejected) {
		t.Fatalf("moves refused: %v %v", moved, err)
	}
	// deleting for good: the refused one is named, the other goes
	fj.emails[a].boxes, fj.emails[b].boxes = map[string]bool{"mb-trash": true}, map[string]bool{"mb-trash": true}
	fj.refuseDestroy[a] = "forbidden"
	err = p.Expunge(t.Context(), []MailRef{{Role: RoleTrash, ID: a}, {Role: RoleTrash, ID: b}})
	if f := mailFailed(err); len(f) != 1 || !f["trash.j."+a] || fj.emails[b] != nil || fj.emails[a] == nil {
		t.Fatalf("expunge: %v", err)
	}
}

func TestJMAPSendNoSentBox(t *testing.T) {
	fj := newFakeJMAP(t)
	fj.boxes = []fakeBox{{"mb-inbox", "inbox"}, {"mb-drafts", "drafts"}, {"mb-trash", "trash"}}
	p := fakeJMAPProv(fj)
	raw := []byte(strings.ReplaceAll(plainMail(7), "\n", "\r\n"))
	if err := p.Send(t.Context(), raw, raw, "ana@fast.test", []string{"bob@example.com"}); !errors.Is(err, errMailNoCopy) {
		t.Fatalf("send with no Sent: %v", err)
	}
	if len(fj.subs) != 1 || len(fj.emails) != 0 {
		t.Fatalf("sent %d, left %d", len(fj.subs), len(fj.emails))
	}
}

func TestJMAPLimits(t *testing.T) {
	fj := newFakeJMAP(t)
	fj.maxGet, fj.maxSet, fj.maxCalls = 10, 10, 1
	p := fakeJMAPProv(fj)
	var refs []MailRef
	for i := 1; i <= 25; i++ {
		refs = append(refs, MailRef{Role: RoleInbox, ID: fj.add(plainMail(i), "mb-inbox", false)})
	}
	if res, err := p.Poll(t.Context(), "2026-09-01T00:05:00Z|x"); err != nil || res.Unread != 25 || res.Arrived != 20 {
		t.Fatalf("poll, one call at a time: %+v %v", res, err)
	}
	page, err := p.List(t.Context(), RoleInbox, "", "")
	if err != nil || len(page.Items) != 10 || page.Next == "" {
		t.Fatalf("list: %d %v", len(page.Items), err)
	}
	if rows, err := p.Summaries(t.Context(), refs); err != nil || len(rows) != 25 {
		t.Fatalf("summaries: %d %v", len(rows), err)
	}
	if _, err := p.Set(t.Context(), refs, MailChange{Seen: new(true)}); err != nil {
		t.Fatalf("set: %v", err)
	}
	if rows, err := p.Scan(t.Context(), RoleInbox); err != nil || len(rows) != 25 {
		t.Fatalf("scan: %d %v", len(rows), err)
	}
	if err := p.Expunge(t.Context(), refs); err != nil || len(fj.emails) != 0 {
		t.Fatalf("expunge: %v, left %d", err, len(fj.emails))
	}
}

func TestJMAPRefusalsInWords(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	raw := []byte(strings.ReplaceAll(plainMail(3), "\n", "\r\n"))
	fj.importErr = "overQuota"
	if _, _, err := p.SaveDraft(t.Context(), raw, "m3@example.com", nil); !strings.Contains(rejectText(err), "full") {
		t.Fatalf("over quota: %v", err)
	}
	fj.importErr = ""
	fj.subErr = "invalidRecipients"
	err := p.Send(t.Context(), raw, raw, "ana@fast.test", []string{"nobody@nowhere.test"})
	if txt := rejectText(err); !strings.Contains(txt, "recipient") || !strings.Contains(txt, "nobody@nowhere.test") {
		t.Fatalf("bad recipient: %v", err)
	}
	for _, e := range fj.emails {
		if e.boxes["mb-sent"] {
			t.Fatal("a copy stayed in Sent of a mail not sent")
		}
	}
	// a request over the server's limits (the session said none): words, not "down"
	if _, err := p.Poll(t.Context(), ""); err != nil {
		t.Fatal(err)
	}
	fj.maxCalls = 1
	if _, err := p.List(t.Context(), RoleInbox, "", ""); !strings.Contains(rejectText(err), "limit") {
		t.Fatalf("over the limit: %v", err)
	}
}

func TestJMAPCheckSendAndIdentity(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	if err := p.CheckSend(t.Context()); err != nil {
		t.Fatal(err)
	}
	raw := []byte(strings.ReplaceAll(plainMail(5), "\n", "\r\n"))
	if err := p.Send(t.Context(), raw, raw, "zoe@fast.test", []string{"bob@example.com"}); err != nil || fj.subs[0].identity != "id2" {
		t.Fatalf("the *@domain identity: %v %+v", err, fj.subs)
	}
	fj.identities = []map[string]any{{"id": "id9", "email": "bob@other.test"}}
	if err := p.CheckSend(t.Context()); !errors.Is(err, errMailRejected) {
		t.Fatalf("no identity: %v", err)
	}
	if err := p.Send(t.Context(), raw, raw, "ana@fast.test", []string{"bob@example.com"}); !errors.Is(err, errMailRejected) || len(fj.subs) != 1 {
		t.Fatalf("send with no identity: %v (%d sent)", err, len(fj.subs))
	}
}

func TestJMAPSubmissionAccount(t *testing.T) {
	fj := newFakeJMAP(t)
	fj.subAccount = "acc2"
	p := fakeJMAPProv(fj)
	raw := []byte(strings.ReplaceAll(plainMail(5), "\n", "\r\n"))
	if err := p.Send(t.Context(), raw, raw, "ana@fast.test", []string{"bob@example.com"}); err != nil {
		t.Fatal(err)
	}
	if fj.accounts["Identity/get"] != "acc2" || fj.accounts["EmailSubmission/set"] != "acc2" || fj.accounts["Email/import"] != "acc1" {
		t.Fatalf("accounts used: %v", fj.accounts)
	}
}

func TestJMAPCutAndBigFile(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	rich := fj.add(richMail(), "mb-inbox", false)
	fj.bodyCap = 10
	msg, err := p.Message(t.Context(), MailRef{Role: RoleInbox, ID: rich})
	if err != nil || !msg.Cut || len(msg.Text) > 16 {
		t.Fatalf("cut: %v %v %q", err, msg.Cut, msg.Text)
	}
	fj.bodyCap = 0
	var pdf MailPart
	for _, pt := range msg.Parts {
		if pt.Name == "f7.pdf" {
			pdf = pt
		}
	}
	old := jmapMaxFile
	jmapMaxFile = 10
	t.Cleanup(func() { jmapMaxFile = old })
	if _, _, err := p.Attachment(t.Context(), MailRef{Role: RoleInbox, ID: rich}, pdf.ID); !errors.Is(err, errMailTooBig) {
		t.Fatalf("a file over the limit: %v", err)
	}
}

func TestJMAPRetryAndSession(t *testing.T) {
	fj := newFakeJMAP(t)
	fj.add(plainMail(1), "mb-inbox", false)
	p := fakeJMAPProv(fj)
	fj.fail503 = 1
	if _, err := p.Poll(t.Context(), ""); err != nil {
		t.Fatalf("503 once: %v", err)
	}
	fj.fail429 = 2
	if _, err := p.Poll(t.Context(), ""); err == nil {
		t.Fatal("429 twice passed")
	}
	hits := fj.sessionHits
	if _, err := p.Poll(t.Context(), ""); err != nil || fj.sessionHits != hits {
		t.Fatalf("a 429 threw the session away: %v %d/%d", err, fj.sessionHits, hits)
	}
	fj.fail404 = 1
	if _, err := p.Poll(t.Context(), ""); err == nil {
		t.Fatal("404 passed")
	}
	if _, err := p.Poll(t.Context(), ""); err != nil || fj.sessionHits != hits+1 {
		t.Fatalf("after a 404 the session is read again: %v %d/%d", err, fj.sessionHits, hits)
	}
	if d := jmapRetryAfter("120"); d != jmapRetryMax {
		t.Fatalf("retry-after 120 = %v", d)
	}
}

func TestJMAPUploadAnswerCapped(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	fj.uploadAnswer = []byte(`{"blobId":"` + strings.Repeat("x", 2<<20) + `"}`)
	raw := []byte(strings.ReplaceAll(plainMail(3), "\n", "\r\n"))
	if _, _, err := p.SaveDraft(t.Context(), raw, "m3@example.com", nil); err == nil {
		t.Fatal("a 2 MB upload answer was read whole")
	}
}

func TestJMAPPollMarks(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	// an empty Inbox: what comes next is news
	first, err := p.Poll(t.Context(), "")
	if err != nil || first.Mark != jmapEmptyMark || first.Arrived != 0 {
		t.Fatalf("empty: %+v %v", first, err)
	}
	fj.add(plainMail(1), "mb-inbox", false)
	second, err := p.Poll(t.Context(), first.Mark)
	if err != nil || second.Arrived != 1 || second.Mark == first.Mark {
		t.Fatalf("one in: %+v %v", second, err)
	}
	// one read + two new: the count says +1, the mark says 2
	fj.mu.Lock()
	for _, e := range fj.emails {
		e.keywords["$seen"] = true
	}
	fj.mu.Unlock()
	fj.add(plainMail(2), "mb-inbox", false)
	fj.add(plainMail(3), "mb-inbox", false)
	third, err := p.Poll(t.Context(), second.Mark)
	if err != nil || third.Arrived != 2 || third.Unread != 2 {
		t.Fatalf("two in: %+v %v", third, err)
	}
	if again, err := p.Poll(t.Context(), third.Mark); err != nil || again.Arrived != 0 {
		t.Fatalf("nothing new: %+v %v", again, err)
	}
	// a restored old mail is no arrival
	old := fj.add(plainMail(4), "mb-trash", true)
	fj.emails[old].received = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	fj.emails[old].boxes = map[string]bool{"mb-inbox": true}
	if again, err := p.Poll(t.Context(), third.Mark); err != nil || again.Arrived != 0 {
		t.Fatalf("restored: %+v %v", again, err)
	}
}
