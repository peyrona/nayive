package main

// Data-safety seal (cleanup Phase 3, batch S3b): the pieces of the eMail fixes
// that live below the HTTP API (they use the fix's own Go names, so unlike
// ds_mailwrite_test.go these do not build on the code before it).

import (
	"context"
	"errors"
	"fmt"
	netmail "net/mail"
	"strings"
	"testing"
	"time"
)

// TestDS_I1_TypedFieldsStaleAfterEditElsewhere: another mail program changed
// the draft's To since (our note stayed behind): the real header wins.
func TestDS_I1_TypedFieldsStaleAfterEditElsewhere(t *testing.T) {
	if got := typedAddrs("juan, bob@example.com", []MailAddr{{Addr: "carla@example.com"}}); got != "" {
		t.Errorf("stale note kept: %q", got)
	}
	if got := typedAddrs("juan, bob@example.com", []MailAddr{{Addr: "BOB@example.com"}}); got != "juan, bob@example.com" {
		t.Errorf("note dropped: %q", got)
	}
}

// TestDS_I1_JMAPDraftKeepsAddressAsTyped: the same on a JMAP server (the
// typed fields come back as "header:X-Nayive-To:asText").
func TestDS_I1_JMAPDraftKeepsAddressAsTyped(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	raw, _, err := buildMail(&netmail.Address{Address: "ana@fast.test"}, MailOut{To: "juan, bob@fast.test", Subject: "x", Text: "y"},
		nil, "d1@fast.test", true)
	if err != nil {
		t.Fatal(err)
	}
	ref, _, err := p.SaveDraft(t.Context(), raw, "d1@fast.test", nil)
	if err != nil {
		t.Fatal(err)
	}
	msg, err := p.Message(t.Context(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if msg.ToText != "juan, bob@fast.test" {
		t.Errorf("JMAP draft toText = %q", msg.ToText)
	}
}

// TestDS_I3_JMAPAnywhere: JMAP - an Email in a Mailbox that is no tray is
// "somewhere" (its labels stay); one with no Email at all is nowhere.
func TestDS_I3_JMAPAnywhere(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	fj.add(plainMail(1), "mb-work", true)
	if there, err := p.Anywhere(t.Context(), "m1@example.com"); err != nil || !there {
		t.Errorf("an Email in a folder = %v (%v), want there", there, err)
	}
	if there, err := p.Anywhere(t.Context(), "m9@example.com"); err != nil || there {
		t.Errorf("no such Email = %v (%v), want nowhere", there, err)
	}
	if _, err := p.Find(t.Context(), "m1@example.com", nil); !errors.Is(err, errMailGone) {
		t.Errorf("Find in the trays = %v, want gone (it is in no tray)", err)
	}
}

// TestDS_I6_JMAPUnclearSubmissionKeepsCopy: JMAP - the submission went, its
// answer did not come (a 500, a timeout): the Sent copy was destroyed "as
// not sent". Now: "unsure", and the copy stays in Sent.
func TestDS_I6_JMAPUnclearSubmissionKeepsCopy(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	fj.subLost = true
	raw := []byte(strings.ReplaceAll(plainMail(5), "\n", "\r\n"))
	err := p.Send(t.Context(), raw, raw, "ana@fast.test", []string{"bob@example.com"})
	if !errors.Is(err, errMailUnsure) {
		t.Errorf("send = %v, want unsure", err)
	}
	inSent := 0
	for _, e := range fj.emails {
		if e.boxes["mb-sent"] {
			inSent++
		}
	}
	if len(fj.subs) != 1 || inSent != 1 {
		t.Errorf("submitted %d, copies in Sent %d: want 1 and 1", len(fj.subs), inSent)
	}
	// a clear refusal still takes its copy away
	fj.subLost, fj.subErr = false, "forbiddenToSend"
	if err := p.Send(t.Context(), raw, raw, "ana@fast.test", []string{"bob@example.com"}); !errors.Is(err, errMailRejected) {
		t.Errorf("refused send = %v", err)
	}
	n := 0
	for _, e := range fj.emails {
		if e.boxes["mb-sent"] {
			n++
		}
	}
	if n != 1 {
		t.Errorf("copies in Sent after a refusal = %d, want 1", n)
	}
}

// TestDS_I6_UnsureSendKeepsDraftAndHolds: SMTP's answer to the end of the
// message never came: the app hears "unsure" (never "not sent"), the draft
// stays, and a Send again within minutes is refused.
func TestDS_I6_UnsureSendKeepsDraftAndHolds(t *testing.T) {
	f, _ := newWriteFixture(t)
	tries := 0
	f.srv.mail.newProvider = func(a MailAccount) MailProvider {
		p := newIMAPProvider(a)
		p.dial = dialMemIMAP(f.addr)
		p.smtpCheck = noSMTPCheck
		p.smtp = func(context.Context, MailAccount, string, []string, []byte) error {
			tries++
			return fmt.Errorf("%w: connection reset", errMailUnsure)
		}
		return p
	}
	f.addAccount(t, mailTestPass, 200)
	mid := "nayive.dsunsure@example.com"
	d := f.postMail(t, "/api/mail/a1/draft", map[string]any{"to": "bob@example.com", "subject": "Quizá", "text": "x", "mid": mid}, nil, 200)
	if out := f.postMail(t, "/api/mail/a1/send", map[string]any{"to": "bob@example.com", "subject": "Quizá", "text": "x",
		"mid": mid, "draftRef": d["ref"]}, nil, 502); out["code"] != "unsure" {
		t.Errorf("send = %v, want unsure", out)
	}
	var drafts mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=drafts", "", 200, &drafts)
	if len(drafts.Items) != 1 {
		t.Errorf("drafts = %d, want the draft kept", len(drafts.Items))
	}
	if out := f.postMail(t, "/api/mail/a1/send", map[string]any{"to": "bob@example.com", "subject": "Quizá", "text": "x",
		"mid": mid, "draftRef": d["ref"]}, nil, 409); out["code"] != "sent" || tries != 1 {
		t.Errorf("send again = %v (SMTP tried %d times)", out, tries)
	}
}

// TestDS_I7_PurgeKeepsToFirstTrash: a Trash that is only a guess by name:
// the purge deletes for good only from the folder it took the first time.
// A folder named "Bin" made later (listed first) is never purged.
func TestDS_I7_PurgeKeepsToFirstTrash(t *testing.T) {
	f := newMailFixture(t)
	f.addAccount(t, mailTestPass, 200)
	a := f.srv.mail.account("ana", "a1")
	if _, err := f.srv.mail.purgeAccount(t.Context(), "ana", a, false); err != nil { // first use: "Trash"
		t.Fatal(err)
	}
	c, err := dialMemIMAP(f.addr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	if err != nil {
		t.Fatal(err)
	}
	c.Create("Bin", nil).Wait()
	c.Close()
	appendMail(t, f.addr, "Bin", plainMail(3), true)
	a.prov.(*imapProvider).Close() // a new connection lists the folders again
	if folder, _, _ := a.prov.(*imapProvider).trashFolder(t.Context()); folder != "Bin" {
		t.Skipf("the server lists %q first; this test needs Bin first", folder)
	}
	f.srv.mail.mu.Lock()
	u := f.srv.mail.owners["ana"]
	f.srv.mail.mu.Unlock()
	if _, err := f.srv.mail.purgeAccount(t.Context(), "ana", a, false); !errors.Is(err, errMailTrashMoved) {
		t.Errorf("purge of another guessed Trash = %v, want refused", err)
	}
	f.srv.mail.mu.Lock()
	for k, e := range u.trash {
		e.At = e.At.Add(-31 * 24 * time.Hour)
		u.trash[k] = e
	}
	f.srv.mail.mu.Unlock()
	f.srv.mail.purgeAccount(t.Context(), "ana", a, false)
	c, _ = dialMemIMAP(f.addr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	defer c.Close()
	if d, err := c.Select("Bin", nil).Wait(); err != nil || d.NumMessages != 1 {
		t.Errorf("the user's Bin lost its mail (%v)", err)
	}
}

// TestDS_J8_PurgeRunsOnceClockSteady: after a jump, the purge runs again once
// the clock has kept step with the monotonic one for a whole round.
func TestDS_J8_PurgeRunsOnceClockSteady(t *testing.T) {
	f := newMailFixture(t)
	f.srv.mail.mu.Lock()
	u := f.srv.mail.userLocked("ana")
	u.state.PurgeAt = time.Now().Add(-40 * 24 * time.Hour)
	f.srv.mail.mu.Unlock()
	if err := f.srv.mail.purgeClockOK("ana"); !errors.Is(err, errMailClock) {
		t.Fatalf("first run after the jump = %v, want it to wait", err)
	}
	if err := f.srv.mail.purgeClockOK("ana"); !errors.Is(err, errMailClock) {
		t.Fatalf("a run moments later = %v, want it to wait", err)
	}
	f.srv.mail.mu.Lock()
	u.clockJump = time.Now().Add(-mailPurgeEvery) // a round ago, wall and monotonic alike
	f.srv.mail.mu.Unlock()
	if err := f.srv.mail.purgeClockOK("ana"); err != nil {
		t.Fatalf("after a steady round = %v, want it to run", err)
	}
	if time.Since(u.state.PurgeAt) > time.Minute {
		t.Errorf("last run not noted: %v", u.state.PurgeAt)
	}
}

// TestDS_I9_JMAPFindAll: JMAP - every copy in the tray, not only the newest.
func TestDS_I9_JMAPFindAll(t *testing.T) {
	fj := newFakeJMAP(t)
	p := fakeJMAPProv(fj)
	fj.add(plainMail(1), "mb-trash", true)
	fj.add(plainMail(1), "mb-trash", true)
	fj.add(plainMail(1), "mb-inbox", true)
	rows, err := p.FindAll(t.Context(), "m1@example.com", RoleTrash)
	if err != nil || len(rows) != 2 || rows[0].Ref == rows[1].Ref {
		t.Errorf("FindAll = %+v (%v), want the two in the Trash", rows, err)
	}
}
