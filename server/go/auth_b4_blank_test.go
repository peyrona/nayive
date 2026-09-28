package main

// A config.json that does not parse, or whose password is not a string, reads
// as "no password" - and must never let a blank password in (review of
// batch 4 part 3).

import (
	"os"
	"path/filepath"
	"testing"
)

func TestB4BlankPasswordNeedsARealBlank(t *testing.T) {
	users, cfg, _ := newTestUsers(t)
	path := filepath.Join(cfg.HomesDir, "ana", "data", "config.json")

	cases := []struct {
		body  string
		blank bool // a blank password signs in, and NeedsPassword says so
	}{
		{`{"password":""}`, true},
		{`{"lang":"es"}`, true},
		{`{"password":null}`, true},
		{`{"password":"abc"`, false}, // cut short
		{`{"password":1234}`, false},
		{`not json`, false},
		{`[]`, false},
	}
	for _, c := range cases {
		os.WriteFile(path, []byte(c.body), 0o644)
		got := users.Authenticate("ana", "") == "user"
		if got != c.blank {
			t.Errorf("%s: blank sign-in = %v, want %v", c.body, got, c.blank)
		}
		if need := users.NeedsPassword("user", "ana"); need != c.blank {
			t.Errorf("%s: NeedsPassword = %v, want %v", c.body, need, c.blank)
		}
	}
}
