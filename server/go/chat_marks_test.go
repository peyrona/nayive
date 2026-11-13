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

// A "Translate and send" message: the translation, then chatOrig and the
// original. Pushes, quotes and search hits show the translation only, as the
// page's C.stripMarks does.
func TestStripMarksTranslation(t *testing.T) {
	text := "Bonjour, *ça va* ?" + chatOrig + "Hola, ¿qué tal?"
	if got := stripMarks(text); got != "Bonjour, ça va ?" {
		t.Errorf("stripMarks = %q", got)
	}
	if got := chatMsgText(&ChatMsg{Text: text}); got != "Bonjour, *ça va* ?" {
		t.Errorf("chatMsgText = %q", got)
	}
	if chatOrig != "\n⁣" {
		t.Errorf("chatOrig drifted from the page's C.ORIG")
	}
}
