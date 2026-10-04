package main

import "testing"

// A few of the rules, on single parts (the full proof against zipdiff.py was
// 1364 docx pairs, byte-identical output).
func TestMeaningRules(t *testing.T) {
	const w = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
	const w14 = `xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"`
	const mc = `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`
	for _, tc := range []struct {
		a, b string
		same bool
	}{
		{`<w:p ` + w + `/>`, `<x:p xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`, true},
		{`<w:p ` + w + ` ` + w14 + ` w14:paraId="1"/>`, `<w:p ` + w + ` ` + w14 + ` w14:paraId="2"/>`, true},
		{`<w:t ` + w + ` xml:space="preserve">a</w:t>`, `<w:t ` + w + `>a</w:t>`, true},
		{`<w:t ` + w + ` xml:space="preserve"> a</w:t>`, `<w:t ` + w + `> a</w:t>`, false},
		{`<r ` + mc + ` mc:Ignorable="b a"/>`, `<r ` + mc + ` mc:Ignorable="a  b"/>`, true},
		{"<r>\n  <k/>\n</r>", `<r><k/></r>`, true},
		{`<r><t> </t></r>`, `<r><t/></r>`, false},
		{`<r a="x&#10;y"/>`, "<r a=\"x\ny\"/>", false},
		{"<r a=\"x\ny\"/>", `<r a="x y"/>`, true},
		{`<r><q:k/></r>`, `<r><q:k/></r>`, true}, // unbound: compared as bytes
		{`<r><q:k/></r>`, `<r><q:k /></r>`, false},
	} {
		a, b := meaningOf("p.xml", []byte(tc.a)), meaningOf("p.xml", []byte(tc.b))
		if a.equal(b) != tc.same {
			t.Errorf("%s vs %s: same = %v, want %v", tc.a, tc.b, !tc.same, tc.same)
		}
	}
}
