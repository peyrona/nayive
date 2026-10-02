package main

import (
	"encoding/json"
	"testing"
)

// TestNegativeQuotaRefused: a quota below zero would stop that person from
// uploading anything, so it is refused like any other bad number; zero and
// "remove it" still work.
func TestNegativeQuotaRefused(t *testing.T) {
	users, _, _ := newTestUsers(t)
	if got := users.SaveAccount("cuotas", SaveAccountOptions{Password: "clave"}); got != "created" {
		t.Fatalf("create = %q", got)
	}
	for raw, want := range map[string]string{`-5`: "bad-quota", `"-0.5"`: "bad-quota", `0`: "updated", `2.5`: "updated", `null`: "updated"} {
		got := users.SaveAccount("cuotas", SaveAccountOptions{SetQuota: true, Quota: json.RawMessage(raw)})
		if got != want {
			t.Errorf("quota %s = %q, want %q", raw, got, want)
		}
	}
}
