package main

// =============================================================================
// Batch 4 part 3: a renewed push subscription (sw.js pushsubscriptionchange ->
// POST /api/push with old_endpoint) moves the phone row that held the old
// endpoint at once, without waiting for the app to send its new one.
// =============================================================================

import (
	"testing"
)

func TestDeviceFollowsRenewedPush(t *testing.T) {
	srv, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	id := enrolPhone(t, client, base)
	const old, fresh = "https://fcm.googleapis.com/fcm/send/viejo", "https://fcm.googleapis.com/fcm/send/nuevo"
	jsonCall(t, client, "PUT", base+"/api/device/"+id, `{"endpoint":"`+old+`"}`, 200, nil)

	p256, au := pushRenewKeys(t)
	sub := func(endpoint, oldEndpoint string) string {
		return `{"subscription":{"endpoint":"` + endpoint + `","keys":{"p256dh":"` + p256 + `","auth":"` + au +
			`"}},"old_endpoint":"` + oldEndpoint + `"}`
	}

	// Another account naming ana's old endpoint moves nothing of hers.
	beto := signedInClient(t, base, "beto", "xyz")
	jsonCall(t, beto, "POST", base+"/api/push", sub("https://fcm.googleapis.com/fcm/send/beto", old), 200, nil)
	if !srv.devices.HasApp("ana", old) {
		t.Fatal("beto's renewal moved ana's phone")
	}

	// A plain subscribe (no old_endpoint) leaves the row alone.
	jsonCall(t, client, "POST", base+"/api/push", sub("https://fcm.googleapis.com/fcm/send/otro", ""), 200, nil)
	if !srv.devices.HasApp("ana", old) {
		t.Fatal("a plain subscribe moved the phone")
	}

	// The renewal: the phone now knows its Chrome by the new endpoint.
	jsonCall(t, client, "POST", base+"/api/push", sub(fresh, old), 200, nil)
	if !srv.devices.HasApp("ana", fresh) || srv.devices.HasApp("ana", old) {
		t.Fatal("the phone row kept the old endpoint after a renewal")
	}
	if !srv.devices.SkipCallPush("ana", fresh) {
		t.Fatal("a call would ring the renewed Chrome too")
	}
}
