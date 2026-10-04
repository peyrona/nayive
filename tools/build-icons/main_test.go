package main

import "testing"

// The wrapper SVG is the one build-icons.py made (its output, pasted): the
// same text gives Inkscape the same PNGs.
func TestWrapperSVGAsBefore(t *testing.T) {
	var email glyph
	for _, g := range glyphs {
		if g.name == "email" {
			email = g
		}
		if g.name == "launcher" {
			t.Fatal(`"launcher" is artwork (tools/launcher-logo-512.png), never a glyph`)
		}
	}
	const head = "<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512' viewBox='0 0 512 512'>" +
		"<rect width='512' height='512' rx='96' fill='#1E1F23'/><g transform='translate(112.64 112.64) scale(11.9467)' "
	const glyphSVG = "<rect x='2' y='4' width='20' height='16' rx='2'></rect><polyline points='22 6 12 13 2 6'></polyline></g></svg>"
	for _, tc := range []struct {
		fill bool
		want string
	}{
		{false, head + "fill='none' stroke='#16A085' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" + glyphSVG},
		{true, head + "fill='#16A085' stroke='none'>" + glyphSVG},
	} {
		if got := wrapperSVG(email.svg, tc.fill); got != tc.want {
			t.Errorf("fill %v:\n got %s\nwant %s", tc.fill, got, tc.want)
		}
	}
	if len(glyphs) != 12 {
		t.Errorf("%d glyphs, want the 12 of build-icons.py", len(glyphs))
	}
}
