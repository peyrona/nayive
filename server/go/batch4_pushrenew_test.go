package main

// =============================================================================
// Batch 4 (cross.md #15): a renewed push subscription (the service worker's
// pushsubscriptionchange) names the endpoint it replaces. The new one keeps the
// old one's language and label, and the old one is dropped in the same write.
// =============================================================================

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"testing"
)

func pushRenewKeys(t *testing.T) (string, string) {
	t.Helper()
	key, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	return base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		base64.RawURLEncoding.EncodeToString(auth)
}

func pushRenewFind(subs []PushSub, endpoint string) *PushSub {
	for i := range subs {
		if subs[i].Endpoint == endpoint {
			return &subs[i]
		}
	}
	return nil
}

// TestPushRenewCarriesLangAndLabel: the worker's guesses ("de", its platform)
// lose to what the launcher stored; the old endpoint is gone, nothing added.
func TestPushRenewCarriesLangAndLabel(t *testing.T) {
	users, _, _ := newTestUsers(t)
	p256, au := pushRenewKeys(t)
	const old, other, fresh = "https://fcm.googleapis.com/fcm/send/old",
		"https://fcm.googleapis.com/fcm/send/other", "https://fcm.googleapis.com/fcm/send/new"

	users.AddPushSub("ana", old, p256, au, "fr", "Móvil de Ana", nil)
	users.AddPushSub("ana", other, p256, au, "it", "Portátil", nil)
	before := pushRenewFind(users.UserPush("ana").Subs, old).Created

	if got := users.RenewPushSub("ana", old, fresh, p256, au, "de", "Linux armv8l", nil); got != "added" {
		t.Fatalf("RenewPushSub = %q, want added", got)
	}
	subs := users.UserPush("ana").Subs
	if len(subs) != 2 {
		t.Fatalf("devices = %d, want 2: %+v", len(subs), subs)
	}
	if pushRenewFind(subs, old) != nil {
		t.Errorf("the old endpoint is still there")
	}
	n := pushRenewFind(subs, fresh)
	if n == nil || n.Lang != "fr" || n.Label != "Móvil de Ana" || n.Created != before {
		t.Errorf("renewed device = %+v, want lang fr, label \"Móvil de Ana\", created %d", n, before)
	}
	if o := pushRenewFind(subs, other); o == nil || o.Lang != "it" || o.Label != "Portátil" {
		t.Errorf("the other device changed: %+v", o)
	}
}

// TestPushRenewUnknownOldIsPlainAdd: an old endpoint this user never had (or
// another user's) changes nothing but the add itself.
func TestPushRenewUnknownOldIsPlainAdd(t *testing.T) {
	users, _, _ := newTestUsers(t)
	p256, au := pushRenewKeys(t)
	const betos, fresh = "https://fcm.googleapis.com/fcm/send/beto", "https://fcm.googleapis.com/fcm/send/new"

	users.AddPushSub("beto", betos, p256, au, "pt", "Beto", nil)
	if got := users.RenewPushSub("ana", betos, fresh, p256, au, "de", "x", nil); got != "added" {
		t.Fatalf("RenewPushSub = %q, want added", got)
	}
	if n := pushRenewFind(users.UserPush("ana").Subs, fresh); n == nil || n.Lang != "de" || n.Label != "x" {
		t.Errorf("plain add = %+v, want lang de, label x", n)
	}
	if b := users.UserPush("beto").Subs; len(b) != 1 || b[0].Endpoint != betos || b[0].Lang != "pt" {
		t.Errorf("beto's device was touched: %+v", b)
	}
}

// TestPushRenewAtTheCapEvictsNobody: with MaxPushSubs devices, a renewal
// replaces its own entry; no other device is pushed out.
func TestPushRenewAtTheCapEvictsNobody(t *testing.T) {
	users, _, _ := newTestUsers(t)
	p256, au := pushRenewKeys(t)
	ep := func(i int) string { return fmt.Sprintf("https://fcm.googleapis.com/fcm/send/d%d", i) }
	for i := 0; i < MaxPushSubs; i++ {
		users.AddPushSub("ana", ep(i), p256, au, "es", fmt.Sprint("d", i), nil)
	}
	const fresh = "https://fcm.googleapis.com/fcm/send/new"
	users.RenewPushSub("ana", ep(5), fresh, p256, au, "", "", nil)

	subs := users.UserPush("ana").Subs
	if len(subs) != MaxPushSubs {
		t.Fatalf("devices = %d, want %d", len(subs), MaxPushSubs)
	}
	for i := 0; i < MaxPushSubs; i++ {
		if got := pushRenewFind(subs, ep(i)); (got != nil) != (i != 5) {
			t.Errorf("device %d present = %v", i, got != nil)
		}
	}
	if n := pushRenewFind(subs, fresh); n == nil || n.Label != "d5" {
		t.Errorf("renewed device = %+v, want label d5", n)
	}
}

// TestPushRenewNewAlreadyThere: the launcher re-posted the new endpoint first;
// the renewal still drops the old one and keeps a single entry for the new.
func TestPushRenewNewAlreadyThere(t *testing.T) {
	users, _, _ := newTestUsers(t)
	p256, au := pushRenewKeys(t)
	const old, fresh = "https://fcm.googleapis.com/fcm/send/old", "https://fcm.googleapis.com/fcm/send/new"

	users.AddPushSub("ana", old, p256, au, "fr", "Móvil", nil)
	users.AddPushSub("ana", fresh, p256, au, "fr", "Móvil", nil)
	if got := users.RenewPushSub("ana", old, fresh, p256, au, "de", "x", nil); got != "updated" {
		t.Fatalf("RenewPushSub = %q, want updated", got)
	}
	subs := users.UserPush("ana").Subs
	if len(subs) != 1 || subs[0].Endpoint != fresh || subs[0].Lang != "fr" || subs[0].Label != "Móvil" {
		t.Errorf("devices = %+v, want only the new one, fr / Móvil", subs)
	}
}

// TestPushRenewOverHTTP: POST /api/push with "old_endpoint" does the same.
func TestPushRenewOverHTTP(t *testing.T) {
	srv, ts, client := newTestServer(t)
	p256, au := pushRenewKeys(t)
	const old, fresh = "https://fcm.googleapis.com/fcm/send/old", "https://fcm.googleapis.com/fcm/send/new"
	srv.users.AddPushSub("ana", old, p256, au, "it", "Tablet", nil)

	signIn(t, client, ts.URL, "ana", "abc")
	jsonCall(t, client, "POST", ts.URL+"/api/push",
		`{"subscription":{"endpoint":"`+fresh+`","keys":{"p256dh":"`+p256+`","auth":"`+au+`"}},`+
			`"lang":"en","label":"Win32","old_endpoint":"`+old+`"}`, 200, nil)

	subs := srv.users.UserPush("ana").Subs
	if len(subs) != 1 || subs[0].Endpoint != fresh || subs[0].Lang != "it" || subs[0].Label != "Tablet" {
		t.Errorf("devices = %+v, want only the new one, it / Tablet", subs)
	}
}
