package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestUserPushOnlyToPushServices: a signed-in user's device, too, may only be
// a real push service - the server POSTs to it. Checked when it is saved and
// again when it is read to send (a push.json written by hand).
func TestUserPushOnlyToPushServices(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	p256, au := testPushKeys(t)

	for _, bad := range []string{"https://127.0.0.1/x", "https://intranet.local/x", "https://fcm.googleapis.com:8443/x",
		"https://[::1]/x", "https://[::1%25.google.com]/fcm/send/x", "https://[::ffff:127.0.0.1%25.google.com]/x",
		"https://[::ffff:10.0.0.1%25.push.apple.com]/x", "https://evil.google.com/x"} {
		if got := users.AddPushSub("ana", bad, p256, au, "es", "", nil); got != "invalid" {
			t.Errorf("AddPushSub(%q) = %q, want invalid", bad, got)
		}
	}
	if got := users.AddPushSub("ana", "https://fcm.googleapis.com/fcm/send/x", p256, au, "es", "", nil); got != "added" {
		t.Errorf("a real push service = %q, want added", got)
	}
	if got := users.AddPushSub("ana", "https://jmt17.google.com/fcm/send/y", p256, au, "es", "", nil); got != "added" {
		t.Errorf("Chrome's newer endpoint = %q, want added", got)
	}

	raw, _ := json.Marshal(map[string]any{"subs": []PushSub{
		{Endpoint: "https://127.0.0.1/x", Keys: PushKeys{P256dh: p256, Auth: au}, Lang: "es"}}})
	os.WriteFile(filepath.Join(cfg.HomesDir, "beto", "data", "push.json"), raw, 0o644)
	if subs := users.UserPush("beto").Subs; len(subs) != 0 {
		t.Errorf("a stored endpoint to an internal host is still used: %+v", subs)
	}
}
