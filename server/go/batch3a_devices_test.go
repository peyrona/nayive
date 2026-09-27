package main

import (
	"testing"
)

// TestDeviceSetEndpoint: PUT /api/device/<id> {endpoint} - the launcher, which
// no longer keeps the phone's token, updates the push endpoint of the Chrome
// inside that phone's app. Only on the signed-in user's own phone, only to a
// real push service, and it never moves the phone to another account.
func TestDeviceSetEndpoint(t *testing.T) {
	srv, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	id := enrolPhone(t, client, base)
	fresh := "https://fcm.googleapis.com/fcm/send/nuevo"

	jsonCall(t, client, "PUT", base+"/api/device/"+id, `{"endpoint":"`+fresh+`"}`, 200, nil)
	if !srv.devices.HasApp("ana", fresh) {
		t.Fatal("the phone's endpoint was not updated")
	}

	for _, bad := range []string{"", "http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://intranet.local/x",
		"https://[::1]/x", "https://[::1%25.google.com]/fcm/send/x", "https://[::ffff:127.0.0.1%25.google.com]/x",
		"https://[::ffff:10.0.0.1%25.push.apple.com]/x"} {
		jsonCall(t, client, "PUT", base+"/api/device/"+id, `{"endpoint":"`+bad+`"}`, 400, nil)
	}
	jsonCall(t, client, "PUT", base+"/api/device/nope", `{"endpoint":"`+fresh+`"}`, 404, nil)

	// Another account knowing the id: not found, and nothing moves.
	beto := signedInClient(t, base, "beto", "xyz")
	jsonCall(t, beto, "PUT", base+"/api/device/"+id,
		`{"endpoint":"https://fcm.googleapis.com/fcm/send/beto"}`, 404, nil)
	if !srv.devices.HasApp("ana", fresh) || srv.devices.HasApp("beto", "https://fcm.googleapis.com/fcm/send/beto") {
		t.Fatal("another account changed ana's phone")
	}
	if len(srv.devices.List("beto")) != 0 || len(srv.devices.List("ana")) != 1 {
		t.Fatal("the phone changed hands")
	}
}
