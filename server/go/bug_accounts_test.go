package main

// =============================================================================
// Bugs audit 2: a password set or cleared by the admin signs that user out
// (SS2); changing your own password drops every push subscription (SS3).
// =============================================================================

import (
	"net/http"
	"testing"
)

// TestBug_SS2_AdminPasswordDropsSessions: set -> the old session is gone;
// clear -> a kept session cannot pick the new password; a quota-only save
// signs nobody out.
func TestBug_SS2_AdminPasswordDropsSessions(t *testing.T) {
	_, ts, admin := newTestServer(t)
	base := ts.URL
	signIn(t, admin, base, "jefe", "secreto")

	ana := signedInClient(t, base, "ana", "abc")
	if code := postAdmin(t, admin, base, `{"action":"update-user","name":"ana","quota":5}`); code != http.StatusOK {
		t.Fatalf("quota save = %d", code)
	}
	if who, _ := whoami(t, ana, base); who != "ana" {
		t.Fatal("a quota-only save signed ana out")
	}

	if code := postAdmin(t, admin, base, `{"action":"update-user","name":"ana","password":"nueva"}`); code != http.StatusOK {
		t.Fatalf("password save = %d", code)
	}
	if who, _ := whoami(t, ana, base); who != "" {
		t.Fatalf("after the admin set a new password, the old session is still %q", who)
	}

	ana = signedInClient(t, base, "ana", "nueva")
	if code := postAdmin(t, admin, base, `{"action":"update-user","name":"ana","password":null}`); code != http.StatusOK {
		t.Fatalf("password clear = %d", code)
	}
	if code, raw := callJSON(t, ana, "POST", base+"/api/password", `{"current":"","new":"intruso"}`); code != http.StatusUnauthorized {
		t.Fatalf("a kept session set the password after a clear: %d %s", code, raw)
	}
}

// TestBug_SS3_PasswordChangeDropsPushSubs: an intruder's browser stops getting
// chat and mail pushes; the window setting stays.
func TestBug_SS3_PasswordChangeDropsPushSubs(t *testing.T) {
	_, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")

	const ep = "https://fcm.googleapis.com/fcm/send/intruso"
	p256, au := pushRenewKeys(t)
	jsonCall(t, client, "POST", base+"/api/push",
		`{"subscription":{"endpoint":"`+ep+`","keys":{"p256dh":"`+p256+`","auth":"`+au+`"}},"window_minutes":20}`, 200, nil)
	var before struct {
		Subscribed bool `json:"subscribed"`
		Window     int  `json:"window_minutes"`
	}
	jsonCall(t, client, "GET", base+"/api/push?endpoint="+ep, "", 200, &before)
	if !before.Subscribed {
		t.Fatal("the subscription did not register")
	}

	jsonCall(t, client, "POST", base+"/api/password", `{"current":"abc","new":"nueva"}`, 200, nil)

	var after struct {
		Subscribed bool `json:"subscribed"`
		Window     int  `json:"window_minutes"`
		Count      int  `json:"count"`
	}
	jsonCall(t, client, "GET", base+"/api/push?endpoint="+ep, "", 200, &after)
	if after.Subscribed || after.Count != 0 {
		t.Fatalf("after a password change the push subscriptions remain: %+v", after)
	}
	if after.Window != before.Window || after.Window != 20 {
		t.Fatalf("the window changed: %d -> %d", before.Window, after.Window)
	}
}
