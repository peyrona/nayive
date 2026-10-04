package main

// Bugs audit 2 (cleanup Phase 5, batch F3): eMail on the server.

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
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

// TestBug_SF6_UndoBothCopiesOwnTrays: a mail to yourself (one Message-ID in
// the Inbox and in Sent) deleted together and Undone: each copy goes back to
// its own tray. The second copy overwrote the first's "from", and both went
// to the same tray.
func TestBug_SF6_UndoBothCopiesOwnTrays(t *testing.T) {
	f, _ := newWriteFixture(t)
	appendMail(t, f.addr, "INBOX", plainMail(1), true)
	appendMail(t, f.addr, "Sent Items", plainMail(1), true)
	f.addAccount(t, mailTestPass, 200)
	var inbox, sentTray mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox", "", 200, &inbox)
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=sent", "", 200, &sentTray)
	if len(inbox.Items) != 1 || len(sentTray.Items) != 1 {
		t.Fatalf("setup: inbox %d, sent %d", len(inbox.Items), len(sentTray.Items))
	}
	refs, _ := json.Marshal([]string{inbox.Items[0].Ref, sentTray.Items[0].Ref})
	f.call(t, f.owner, "POST", "/api/mail/a1/set", `{"refs":`+string(refs)+`,"tray":"trash"}`, 200, nil)
	mid := inbox.Items[0].MessageID
	var out map[string]any
	f.call(t, f.owner, "POST", "/api/mail/a1/restore", `{"mids":["`+mid+`","`+mid+`"]}`, 200, &out)
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=inbox", "", 200, &inbox)
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=sent", "", 200, &sentTray)
	if out["restored"] != float64(2) || len(inbox.Items) != 1 || len(sentTray.Items) != 1 {
		t.Errorf("restored %v: inbox %d, sent %d - want one copy in each", out["restored"], len(inbox.Items), len(sentTray.Items))
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
	if got := h2.trashFrom("ana", "a1", "<m1@example.com>", 0); got != RoleSent {
		t.Errorf("old entry: from %q, want sent", got)
	}
	if got := h2.trashFrom("ana", "a1", "<m1@example.com>", 1); got != RoleSent {
		t.Errorf("old entry, a second copy: from %q, want sent", got)
	}
	if got := h2.trashFrom("ana", "a1", "<m2@example.com>", 0); got != RoleInbox {
		t.Errorf("old entry with no from: %q, want inbox", got)
	}
}
