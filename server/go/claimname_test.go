package main

import (
	"errors"
	"io/fs"
	"reflect"
	"testing"
)

// The free-name claim keeps each caller's numbering: convert starts at
// "(1)", the others at "(2)"; an exhausted run ends on fs.ErrExist.
func TestClaimNameNumbering(t *testing.T) {
	for _, tc := range []struct {
		first, tries int
		want         []string
	}{
		{1, 4, []string{"a.mp4", "a (1).mp4", "a (2).mp4", "a (3).mp4"}},
		{2, 3, []string{"a.mp4", "a (2).mp4", "a (3).mp4"}},
	} {
		var seen []string
		name, err := claimName("a", ".mp4", tc.first, tc.tries, func(n string) error {
			seen = append(seen, n)
			return &fs.PathError{Op: "link", Path: n, Err: fs.ErrExist}
		})
		if name != "" || !errors.Is(err, fs.ErrExist) || !reflect.DeepEqual(seen, tc.want) {
			t.Fatalf("first %d: got %q %v %v, want %v", tc.first, name, err, seen, tc.want)
		}
	}
	name, err := claimName("x", "", 2, 9, func(n string) error {
		if n == "x (3)" {
			return nil
		}
		return fs.ErrExist
	})
	if name != "x (3)" || err != nil {
		t.Fatalf("got %q %v", name, err)
	}
	boom := errors.New("boom")
	if name, err := claimName("x", "", 2, 9, func(string) error { return boom }); name != "" || err != boom {
		t.Fatalf("got %q %v", name, err)
	}
	if zipCandidate("F", 1) != "F" || zipCandidate("F", 7) != "F (7)" {
		t.Fatal("zipCandidate changed")
	}
}
