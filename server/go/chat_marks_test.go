package main

import (
	"encoding/json"
	"os"
	"testing"
)

// The same cases as the page's (tools/chat-test/marks.test.mjs), so the two
// strippers cannot drift apart.
func TestStripMarks(t *testing.T) {
	raw, err := os.ReadFile("../../tools/chat-test/strip-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases [][2]string
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 10 {
		t.Fatalf("only %d cases", len(cases))
	}
	for _, c := range cases {
		if got := stripMarks(c[0]); got != c[1] {
			t.Errorf("stripMarks(%q) = %q, want %q", c[0], got, c[1])
		}
	}
}
