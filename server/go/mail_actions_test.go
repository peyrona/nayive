package main

// =============================================================================
// eMail phase 2: read/unread, star, moves, the Trash (restore, its clock, the
// purge, emptying it), labels and a label's list, finding a moved message.
// Run twice: a bare IMAP4rev1 server (moves by COPY + EXPUNGE, no new refs)
// and one with MOVE + UIDPLUS, like Gmail.
// =============================================================================

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
)

func TestMailActionsPlain(t *testing.T) { mailActions(t) }
func TestMailActionsMove(t *testing.T)  { mailActions(t, imap.CapMove, imap.CapUIDPlus) }

func mailActions(t *testing.T, caps ...imap.Cap) {
	f := newMailFixture(t, caps...)
	appendMail(t, f.addr, "INBOX", plainMail(1), false)
	appendMail(t, f.addr, "INBOX", plainMail(2), false)
	appendMail(t, f.addr, "INBOX", "From: X <x@y.z>\nTo: ana@example.com\nSubject: No id\n"+
		"Date: Mon, 01 Sep 2026 11:00:00 +0000\nContent-Type: text/plain\n\nhola\n", false)
	f.addAccount(t, mailTestPass, 200)

	list := func(tray string) []MailSummary {
		var p mailPageOut
		f.call(t, f.owner, "GET", "/api/mail/a1/list?tray="+tray, "", 200, &p)
		return p.Items
	}
	find := func(items []MailSummary, subject string) MailSummary {
		for _, m := range items {
			if m.Subject == subject {
				return m
			}
		}
		t.Fatalf("%q not in %+v", subject, items)
		return MailSummary{}
	}
	post := func(path string, body any, want int) map[string]any {
		raw, _ := json.Marshal(body)
		var out map[string]any
		f.call(t, f.owner, "POST", "/api/mail/a1/"+path, string(raw), want, &out)
		return out
	}

	inbox := list("inbox")
	if len(inbox) != 3 {
		t.Fatalf("inbox = %d", len(inbox))
	}
	noID := find(inbox, "No id")
	if !strings.HasPrefix(noID.MessageID, "h:") {
		t.Fatalf("a message with no Message-ID is named %q", noID.MessageID)
	}

	// read, star
	h1 := find(inbox, "Hello 1")
	post("set", map[string]any{"refs": []string{h1.Ref}, "seen": true, "flagged": true}, 200)
	if m := find(list("inbox"), "Hello 1"); !m.Seen || !m.Flagged {
		t.Fatalf("after set = %+v", m)
	}
	post("set", map[string]any{"refs": []string{h1.Ref}, "seen": false}, 200)
	if m := find(list("inbox"), "Hello 1"); m.Seen || !m.Flagged {
		t.Fatalf("after unread = %+v", m)
	}

	// labels
	var work MailLabel
	f.call(t, f.owner, "POST", "/api/mail/labels", `{"name":"Work"}`, 200, &work)
	f.call(t, f.owner, "POST", "/api/mail/labels", `{"name":"work"}`, 409, nil)
	post("labels", map[string]any{"refs": []string{h1.Ref, noID.Ref}, "add": []string{work.ID}}, 200)
	if m := find(list("inbox"), "Hello 1"); len(m.Labels) != 1 || m.Labels[0] != work.ID {
		t.Fatalf("labels on the row = %v", m.Labels)
	}
	var rows struct{ Items []MailSummary }
	f.call(t, f.owner, "GET", "/api/mail/label/"+work.ID, "", 200, &rows)
	if len(rows.Items) != 2 || rows.Items[0].Account != "a1" {
		t.Fatalf("label rows = %+v", rows.Items)
	}

	// to the Trash: its clock starts, the label stays and follows it
	post("set", map[string]any{"refs": []string{h1.Ref}, "tray": "trash"}, 200)
	if len(list("inbox")) != 2 {
		t.Fatal("still in the inbox")
	}
	tr := find(list("trash"), "Hello 1") // listing heals the tag's ref, if the move did not tell
	u := f.srv.mail.owners["ana"]
	e, ok := u.trash[mailKey("a1", h1.MessageID)]
	if !ok || e.From != RoleInbox {
		t.Fatalf("trash entry = %+v %v", e, ok)
	}
	f.call(t, f.owner, "GET", "/api/mail/label/"+work.ID, "", 200, &rows)
	for _, r := range rows.Items {
		if r.MessageID == h1.MessageID && r.Ref != tr.Ref {
			t.Fatalf("label row points at %s, the message is at %s", r.Ref, tr.Ref)
		}
	}

	// a stale ref finds the message again by its Message-ID
	var msg MailMessage
	f.call(t, f.owner, "GET", "/api/mail/a1/msg/"+h1.Ref+"?mid="+h1.MessageID, "", 200, &msg)
	if msg.Subject != "Hello 1" || !strings.HasPrefix(msg.Ref, "trash.") || len(msg.Labels) != 1 {
		t.Fatalf("found again = %+v", msg.MailSummary)
	}

	// Undo: restore by Message-ID, back to the Inbox; the clock is gone
	out := post("restore", map[string]any{"mids": []string{h1.MessageID}}, 200)
	if out["restored"] != float64(1) || len(list("trash")) != 0 || len(list("inbox")) != 3 {
		t.Fatalf("restore = %v", out)
	}
	if _, ok := u.trash[mailKey("a1", h1.MessageID)]; ok {
		t.Fatal("trash entry kept after restore")
	}

	// Spam and back
	h2 := find(list("inbox"), "Hello 2")
	post("set", map[string]any{"refs": []string{h2.Ref}, "tray": "spam"}, 200)
	sp := find(list("spam"), "Hello 2")
	post("set", map[string]any{"refs": []string{sp.Ref}, "tray": "inbox"}, 200)
	h2 = find(list("inbox"), "Hello 2")
	post("set", map[string]any{"refs": []string{h2.Ref}, "tray": "drafts"}, 409) // the server has no Drafts

	// Empty Spam: everything there, for good; the inbox untouched
	appendMail(t, f.addr, "Junk", plainMail(700), false)
	appendMail(t, f.addr, "Junk", plainMail(701), false)
	if out := post("spam/empty", map[string]any{}, 200); out["deleted"] != float64(2) || len(list("spam")) != 0 || len(list("inbox")) != 3 {
		t.Fatalf("empty spam = %v", out)
	}

	// only the Trash deletes for good
	post("forget", map[string]any{"refs": []string{h2.Ref}}, 400)

	// the purge: two in the Trash, one of them "3 days" old with trashDays 2
	inbox = list("inbox")
	post("set", map[string]any{"refs": []string{find(inbox, "Hello 1").Ref, find(inbox, "No id").Ref}, "tray": "trash"}, 200)
	f.call(t, f.owner, "PUT", "/api/mail/settings", `{"trashDays":2}`, 200, nil)
	f.srv.mail.mu.Lock()
	u.trash[mailKey("a1", h1.MessageID)] = mailTrashEntry{At: time.Now().Add(-72 * time.Hour), From: RoleInbox}
	f.srv.mail.mu.Unlock()
	n, err := f.srv.mail.purgeAccount(t.Context(), "ana", f.srv.mail.account("ana", "a1"), false)
	if err != nil || n != 1 {
		t.Fatalf("purge = %d %v", n, err)
	}
	left := list("trash")
	if len(left) != 1 || left[0].Subject != "No id" {
		t.Fatalf("trash after purge = %+v", left)
	}
	f.call(t, f.owner, "GET", "/api/mail/label/"+work.ID, "", 200, &rows)
	if len(rows.Items) != 1 || rows.Items[0].Subject != "No id" {
		t.Fatalf("the purged one keeps its label: %+v", rows.Items)
	}

	// Empty Trash
	out = post("trash/empty", map[string]any{}, 200)
	if out["deleted"] != float64(1) || len(list("trash")) != 0 {
		t.Fatalf("empty = %v", out)
	}

	// deleting a label takes it off everything
	f.call(t, f.owner, "DELETE", "/api/mail/labels/"+work.ID, "", 200, nil)
	var labels struct{ Labels []MailLabel }
	f.call(t, f.owner, "GET", "/api/mail/labels", "", 200, &labels)
	if len(labels.Labels) != 0 || len(u.labels.Tags) != 0 {
		t.Fatalf("after delete: %+v / %d tags", labels.Labels, len(u.labels.Tags))
	}

	// the newest unread, for the push
	m, ok, err := f.srv.mail.account("ana", "a1").prov.LatestUnseen(t.Context())
	if err != nil || !ok || m.Subject != "Hello 2" {
		t.Fatalf("latest unseen = %+v %v %v", m, ok, err)
	}
}

// TestMailLabelOldColour: a label saved with the retired amber reads as yellow.
func TestMailLabelOldColour(t *testing.T) {
	f := newMailFixture(t)
	dir := f.srv.mail.dir("ana")
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "labels.json"), []byte(`{"labels":[{"id":"l1","name":"A","color":"#f9a825"}],"tags":{}}`), 0o600)
	var got struct{ Labels []MailLabel }
	f.call(t, f.owner, "GET", "/api/mail/labels", "", 200, &got)
	if len(got.Labels) != 1 || got.Labels[0].Color != "#fdd835" {
		t.Fatalf("labels = %+v", got.Labels)
	}
}
