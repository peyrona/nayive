package main

// Bugs audit 2 (cleanup Phase 5, batch F3): eMail on the server.

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// TestBug_SS4_MailRefusesOwnIP: a mail server named by this machine's own
// public IP is refused like the LAN - from the machine itself it would get
// past the firewall (the Bookmarks fetcher already refuses it).
func TestBug_SS4_MailRefusesOwnIP(t *testing.T) {
	bmSetFor(t, &bmOwnAddrs, func() ([]net.Addr, error) {
		return []net.Addr{&net.IPNet{IP: net.ParseIP("203.0.113.7"), Mask: net.CIDRMask(24, 32)}}, nil
	})
	reset := func() { bmOwnMu.Lock(); bmOwnAt = time.Time{}; bmOwnMu.Unlock() }
	reset()
	t.Cleanup(reset)
	bmSetFor(t, &mailNetGuard, true)

	if err := mailDialControl("tcp4", "203.0.113.7:993", nil); !errors.Is(err, errMailPrivateNet) {
		t.Fatalf("own public address: %v, want refused", err)
	}
	if err := mailDialControl("tcp4", "203.0.113.8:993", nil); err != nil {
		t.Fatalf("a neighbour's address: %v, want allowed", err)
	}
}

// TestBug_SF5_SendAfterUserGone: a Send that ends after the admin deleted
// (or renamed away) the user panicked on the tombstone's nil map - the app
// said "failed" for a mail that went. And a purge job taken before the admin
// acted wrote state.json into the old home.
func TestBug_SF5_SendAfterUserGone(t *testing.T) {
	f := newMailFixture(t)
	h := f.srv.mail
	state := filepath.Join(h.dir("ana"), "state.json")
	if err := os.MkdirAll(filepath.Dir(state), 0o700); err != nil {
		t.Fatal(err)
	}
	os.Remove(state)
	h.DropUser("ana")

	func() {
		defer func() {
			if p := recover(); p != nil {
				t.Fatalf("sendDone on a deleted user panicked: %v", p)
			}
		}()
		h.sendDone("ana", "a1", "<m1@example.com>")
	}()
	if err := h.purgeClockOK("ana"); !errors.Is(err, errDamaged) {
		t.Errorf("purgeClockOK on a deleted user = %v, want refused", err)
	}
	if _, err := os.Stat(state); err == nil {
		t.Error("state.json written for a deleted user")
	}
}

// sf6Fixture: a mail to yourself, its copy in the Inbox unread and in Sent
// read (so each can be told apart), both deleted together.
func sf6Fixture(t *testing.T) (*mailFixture, string) {
	t.Helper()
	f, _ := newWriteFixture(t)
	appendMail(t, f.addr, "INBOX", plainMail(1), false)
	appendMail(t, f.addr, "Sent Items", plainMail(1), true)
	f.addAccount(t, mailTestPass, 200)
	inbox, sentTray := f.tray(t, "inbox"), f.tray(t, "sent")
	if len(inbox) != 1 || len(sentTray) != 1 {
		t.Fatalf("setup: inbox %d, sent %d", len(inbox), len(sentTray))
	}
	refs, _ := json.Marshal([]string{inbox[0].Ref, sentTray[0].Ref})
	f.call(t, f.owner, "POST", "/api/mail/a1/set", `{"refs":`+string(refs)+`,"tray":"trash"}`, 200, nil)
	return f, inbox[0].MessageID
}

func (f *mailFixture) tray(t *testing.T, tray string) []MailSummary {
	t.Helper()
	var p mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray="+tray, "", 200, &p)
	return p.Items
}

// sf6Check: the unread copy is back in the Inbox, the read one in Sent.
func (f *mailFixture) sf6Check(t *testing.T) {
	t.Helper()
	inbox, sentTray := f.tray(t, "inbox"), f.tray(t, "sent")
	if len(inbox) != 1 || len(sentTray) != 1 || inbox[0].Seen || !sentTray[0].Seen {
		t.Errorf("inbox %+v, sent %+v - want the unread copy in the Inbox, the read one in Sent", inbox, sentTray)
	}
}

// TestBug_SF6_UndoBothCopiesOwnTrays: a mail to yourself (one Message-ID in
// the Inbox and in Sent) deleted together and Undone: each copy goes back to
// its own tray. The second copy overwrote the first's "from", and both went
// to the same tray.
func TestBug_SF6_UndoBothCopiesOwnTrays(t *testing.T) {
	f, mid := sf6Fixture(t)
	var out map[string]any
	f.call(t, f.owner, "POST", "/api/mail/a1/restore", `{"mids":["`+mid+`","`+mid+`"]}`, 200, &out)
	if out["restored"] != float64(2) {
		t.Errorf("restored %v, want 2", out["restored"])
	}
	f.sf6Check(t)
}

// TestBug_SF6_RestoreFromTrashView: the same, restored by ref from the Trash
// view, in both orders - the copy is matched by its ref, not its place.
func TestBug_SF6_RestoreFromTrashView(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		f, _ := sf6Fixture(t)
		refs := []string{}
		for _, r := range f.tray(t, "trash") {
			refs = append(refs, r.Ref)
		}
		if reverse {
			refs[0], refs[1] = refs[1], refs[0]
		}
		raw, _ := json.Marshal(refs)
		f.call(t, f.owner, "POST", "/api/mail/a1/restore", `{"refs":`+string(raw)+`}`, 200, nil)
		f.sf6Check(t)
	}
}

// TestBug_SF6_RestoreOneKeepsOther: one copy restored alone; the other, still
// in the Trash, keeps its tray (the whole entry went, and it fell back to
// the Inbox).
func TestBug_SF6_RestoreOneKeepsOther(t *testing.T) {
	f, _ := sf6Fixture(t)
	restore := func(seen bool) {
		for _, r := range f.tray(t, "trash") {
			if r.Seen == seen {
				f.call(t, f.owner, "POST", "/api/mail/a1/restore", `{"refs":["`+r.Ref+`"]}`, 200, nil)
				return
			}
		}
		t.Fatalf("no copy with seen=%v in the Trash", seen)
	}
	restore(false) // the Inbox's
	restore(true)  // then Sent's
	f.sf6Check(t)
}

// TestBug_SF6_UnknownCopyIsInbox: a copy whose tray is not known (its clock
// started by the purge) stays "Inbox" when another copy comes to the Trash.
func TestBug_SF6_UnknownCopyIsInbox(t *testing.T) {
	f := newMailFixture(t)
	h := f.srv.mail
	mid := "<m1@example.com>"
	h.mu.Lock()
	h.userLocked("ana").trash[mailKey("a1", mid)] = mailTrashEntry{At: time.Now()}
	h.mu.Unlock()
	from := MailRef{Role: RoleSent, UIDValidity: 1, UID: 5}
	to := MailRef{Role: RoleTrash, UIDValidity: 1, UID: 9}
	h.noteTrashed("ana", "a1", []MailSummary{{Ref: from.String(), MessageID: mid}}, map[string]MailRef{from.String(): to})
	if got, _ := h.trashFrom("ana", "a1", mid, to.String(), 0); got != RoleSent {
		t.Errorf("the copy from Sent: %q, want sent", got)
	}
	if got, _ := h.trashFrom("ana", "a1", mid, "trash.1.8", 0); got != RoleInbox {
		t.Errorf("the unknown copy: %q, want inbox", got)
	}
}

// TestBug_SF6_OldTrashFileLoads: a trash.json written before the fix (one
// "from" per entry) still loads, and its copy goes back where it came from.
func TestBug_SF6_OldTrashFileLoads(t *testing.T) {
	f := newMailFixture(t)
	h := f.srv.mail
	dir := h.dir("ana")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := `{"a1|<m1@example.com>":{"at":"2026-10-01T10:00:00Z","from":"sent"},"a1|<m2@example.com>":{"at":"2026-10-01T10:00:00Z"}}`
	if err := os.WriteFile(filepath.Join(dir, "trash.json"), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	h2 := NewMailHub(f.srv.cfg, f.srv.users, nil, f.srv.log)
	if got, _ := h2.trashFrom("ana", "a1", "<m1@example.com>", "trash.1.3", 0); got != RoleSent {
		t.Errorf("old entry: from %q, want sent", got)
	}
	if got, _ := h2.trashFrom("ana", "a1", "<m2@example.com>", "trash.1.4", 0); got != RoleInbox {
		t.Errorf("old entry with no from: %q, want inbox", got)
	}
}

// sf6Entry changes the Trash entry of `mid` (as a test only can).
func (f *mailFixture) sf6Entry(mid string, change func(e *mailTrashEntry)) {
	h := f.srv.mail
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked("ana")
	e := u.trash[mailKey("a1", mid)]
	change(&e)
	u.trash[mailKey("a1", mid)] = e
}

// sf6Purge runs the automatic purge once; how many went.
func (f *mailFixture) sf6Purge(t *testing.T) int {
	t.Helper()
	n, err := f.srv.mail.purgeAccount(t.Context(), "ana", f.srv.mail.account("ana", "a1"), false)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// TestBug_SF6_PartialForgetRestartsClock: one copy restored while the other's
// noted ref is stale (it left the Trash unseen and came back, or the server
// renumbered): the copy still there kept the old clock and was purged days
// early.
func TestBug_SF6_PartialForgetRestartsClock(t *testing.T) {
	f, mid := sf6Fixture(t)
	f.sf6Entry(mid, func(e *mailTrashEntry) {
		e.At = time.Now().Add(-40 * 24 * time.Hour)
		for i := range e.Copies {
			if e.Copies[i].From == RoleSent {
				e.Copies[i].Ref = "trash.1.999" // stale
			}
		}
	})
	for _, r := range f.tray(t, "trash") {
		if !r.Seen { // the Inbox's copy, by its ref
			f.call(t, f.owner, "POST", "/api/mail/a1/restore", `{"refs":["`+r.Ref+`"]}`, 200, nil)
		}
	}
	if n := f.sf6Purge(t); n != 0 || len(f.tray(t, "trash")) != 1 {
		t.Errorf("purged %d, %d left in the Trash - want none purged", n, len(f.tray(t, "trash")))
	}
}

// TestBug_SF6_PurgeDropsStaleCopies: every copy noted for a Message-ID left
// the Trash unseen, and the mail is there again (moved back by a phone): the
// purge used the old clock and expunged it early.
func TestBug_SF6_PurgeDropsStaleCopies(t *testing.T) {
	f, mid := sf6Fixture(t)
	f.sf6Entry(mid, func(e *mailTrashEntry) {
		e.At = time.Now().Add(-40 * 24 * time.Hour)
		for i := range e.Copies {
			e.Copies[i].Ref = "trash.1." + strconv.Itoa(900+i) // stale
		}
	})
	if n := f.sf6Purge(t); n != 0 || len(f.tray(t, "trash")) != 2 {
		t.Errorf("purged %d, %d left in the Trash - want none purged", n, len(f.tray(t, "trash")))
	}
}

// TestBug_SF6_NoUIDPlusBothCopies: a server that does not tell the refs in
// the Trash (no UIDPLUS): restoring both copies at once sent both to the
// first copy's tray.
func TestBug_SF6_NoUIDPlusBothCopies(t *testing.T) {
	f, mid := sf6Fixture(t)
	f.sf6Entry(mid, func(e *mailTrashEntry) {
		for i := range e.Copies {
			e.Copies[i].Ref = ""
		}
	})
	f.call(t, f.owner, "POST", "/api/mail/a1/restore", `{"mids":["`+mid+`","`+mid+`"]}`, 200, nil)
	if in, sent := f.tray(t, "inbox"), f.tray(t, "sent"); len(in) != 1 || len(sent) != 1 {
		t.Errorf("inbox %d, sent %d - want one copy in each", len(in), len(sent))
	}
}

// TestBug_SF6_EmptySpamLeavesTrash: Empty Spam forgets its rows; one with the
// Message-ID of a copy in the Trash took that copy's tray record.
func TestBug_SF6_EmptySpamLeavesTrash(t *testing.T) {
	f := newMailFixture(t)
	h := f.srv.mail
	mid := "<m1@example.com>"
	from := MailRef{Role: RoleSent, UIDValidity: 1, UID: 5}
	h.noteTrashed("ana", "a1", []MailSummary{{Ref: from.String(), MessageID: mid}}, nil)
	spam := MailRef{Role: RoleSpam, UIDValidity: 3, UID: 7}
	h.forget("ana", "a1", []MailSummary{{Ref: spam.String(), MessageID: mid}}, true)
	if got, _ := h.trashFrom("ana", "a1", mid, "trash.1.8", 0); got != RoleSent {
		t.Errorf("the Trash copy after Empty Spam: from %q, want sent", got)
	}
}
