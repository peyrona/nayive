package main

import "testing"

// TestFnmatch pins the rules the Drive search box documents, including the two
// places Go's path.Match would disagree with Python: "[!x]" negation and a
// malformed pattern matching nothing instead of erroring.
func TestFnmatch(t *testing.T) {
	cases := []struct {
		name, pattern string
		want          bool
	}{
		{"foto.jpg", "*.jpg", true},
		{"foto.jpeg", "*.jpg", false},
		{"foto.jpg", "foto.???", true},
		{"foto.jpg", "foto.??", false},
		{"a.txt", "[ab].txt", true},
		{"c.txt", "[ab].txt", false},
		{"c.txt", "[!ab].txt", true},
		{"a.txt", "[!ab].txt", false},
		{"m.txt", "[a-z].txt", true},
		{"3.txt", "[a-z].txt", false},
		{"3.txt", "[0-9].txt", true},
		{"anything", "*", true},
		{"", "*", true},
		{"", "?", false},
		{"exact", "exact", true},
		// "*" spans a "/" in fnmatch, unlike path.Match. Only basenames are
		// matched in practice, but the rule is pinned so a future caller knows.
		{"a/b/c", "a*c", true},
		// A malformed class is a literal "[" - never an error.
		{"[weird", "[weird", true},
		{"weird", "[weird", false},
		// "]" first inside the class is a literal one.
		{"]", "[]]", true},
		// Several stars in a row are harmless.
		{"abcdef", "a**f", true},
		{"abcdef", "a*c*f", true},
		{"abcdef", "a*x*f", false},
		// Accents survive: the matcher walks runes, not bytes.
		{"canción.mp3", "canci*.mp3", true},
		{"canción.mp3", "canci?n.mp3", true},
	}

	for _, tc := range cases {
		if got := fnmatch(tc.name, tc.pattern); got != tc.want {
			t.Errorf("fnmatch(%q, %q) = %v, want %v", tc.name, tc.pattern, got, tc.want)
		}
	}
}
