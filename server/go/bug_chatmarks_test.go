package main

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// TestBug_SS1_StripMarksClipped: a 4000-rune text packed with marks and links
// took ~125 ms to strip, once per quote of it, under the hub's lock. Only its
// first marksMax runes are looked at now (marks.js does the same).
func TestBug_SS1_StripMarksClipped(t *testing.T) {
	long := strings.Repeat(" *x", 800) + strings.Repeat(" http://ab", 160)
	head := string([]rune(long)[:600]) // marks.js clips at 600 too
	start := time.Now()
	got := stripMarks(long)
	took := time.Since(start)
	if got != stripMarks(head) {
		t.Fatalf("the strip of a long text is not the strip of its first 600 runes")
	}
	if n := utf8.RuneCountInString(got); n > 600 {
		t.Fatalf("stripped %d runes, want at most 600", n)
	}
	if took > 50*time.Millisecond {
		t.Fatalf("one strip took %v", took)
	}
	// A short text is stripped whole, as before.
	if got := stripMarks("*hola* _tú_"); got != "hola tú" {
		t.Fatalf("short text: %q", got)
	}
}
