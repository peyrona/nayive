package main

// Data-safety seal (cleanup Phase 3, batch S1): eMail's own files that failed
// to load are never written over, and the automatic Trash purge does not run
// on defaults it read instead of them (F4).

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestDS_F4_DamagedMailFilesNotOverwritten: accounts.json and labels.json cut
// short (a write cut by a power cut, a disk error): adding an account or a
// label is refused, and both files keep every byte - the sealed passwords and
// the labels are still there for a repair.
func TestDS_F4_DamagedMailFilesNotOverwritten(t *testing.T) {
	f := newMailFixture(t)
	dir := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "mail")
	os.MkdirAll(dir, 0o700)
	accounts := `{"accounts":[{"id":"a1","email":"old@example.com","user":"old@example.com","pass":"v1:SEALED","imap_host":"imap.old.example","imap_port":993,"smtp_host":"smtp.old.example","smtp_port":465,"added":"2026-01-01T00:00:00Z"}],"next":2`
	labels := `{"labels":[{"id":"l1","name":"Facturas","color":"#e53935"}],"tags":{"a1|x@y":{"labels":["l1"]`
	os.WriteFile(filepath.Join(dir, "accounts.json"), []byte(accounts), 0o600)
	os.WriteFile(filepath.Join(dir, "labels.json"), []byte(labels), 0o600)

	if out := f.addAccount(t, mailTestPass, http.StatusInternalServerError); out["code"] != "damaged" {
		t.Errorf("adding an account over a cut accounts.json = %v, want code \"damaged\"", out)
	}
	if code, body := callJSON(t, f.owner, "POST", f.base+"/api/mail/labels", `{"name":"Nueva"}`); code == http.StatusOK {
		t.Errorf("a new label over a cut labels.json = 200 %s", body)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "accounts.json")); string(got) != accounts {
		t.Errorf("accounts.json changed:\n%s", got)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "labels.json")); string(got) != labels {
		t.Errorf("labels.json changed:\n%s", got)
	}
}

// TestDS_F4_DamagedSettingsStopsAutoPurge: settings.json cut short reads as
// the default 30 days; the automatic purge must not delete, on that default,
// mail the user keeps longer - and the settings file is not written over.
func TestDS_F4_DamagedSettingsStopsAutoPurge(t *testing.T) {
	f := newMailFixture(t)
	dir := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "mail")
	os.MkdirAll(dir, 0o700)
	settings := `{"trashDays": 365, "showImages": tru`
	os.WriteFile(filepath.Join(dir, "settings.json"), []byte(settings), 0o600)
	appendMail(t, f.addr, "Trash", plainMail(1), true)
	f.addAccount(t, mailTestPass, 200)

	var trash mailPageOut
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=trash", "", 200, &trash)
	if len(trash.Items) != 1 {
		t.Fatalf("trash = %+v", trash.Items)
	}
	// In the Trash for 31 days, by Nayive's own clock.
	f.srv.mail.mu.Lock()
	u := f.srv.mail.owners["ana"]
	u.trash[mailKey("a1", trash.Items[0].MessageID)] = mailTrashEntry{At: time.Now().Add(-31 * 24 * time.Hour), From: RoleInbox}
	f.srv.mail.mu.Unlock()

	n, _ := f.srv.mail.purgeAccount(t.Context(), "ana", f.srv.mail.account("ana", "a1"), false)
	f.call(t, f.owner, "GET", "/api/mail/a1/list?tray=trash", "", 200, &trash)
	if n != 0 || len(trash.Items) != 1 {
		t.Errorf("the automatic purge deleted %d by the default days (trash now %d)", n, len(trash.Items))
	}
	if code, _ := callJSON(t, f.owner, "PUT", f.base+"/api/mail/settings", `{"trashDays":7}`); code == http.StatusOK {
		t.Error("new settings were saved over a cut settings.json")
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "settings.json")); string(got) != settings {
		t.Errorf("settings.json changed:\n%s", got)
	}
}
