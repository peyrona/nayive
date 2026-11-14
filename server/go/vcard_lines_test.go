package main

import (
	"strings"
	"testing"
)

// vcardLines: a 3.0 card's line that starts with a space is a fold even right
// after a "=" (Contacts once folded a kept QUOTED-PRINTABLE line there); a 2.1
// card's soft breaks still join.
func TestVcardLinesFoldAfterEquals(t *testing.T) {
	v3 := "BEGIN:VCARD\r\nVERSION:3.0\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Bego=C3=B1a=\r\n C3=8D=C3=B1iguez\r\nEND:VCARD\r\n"
	got := vcardLines(strings.NewReader(v3))
	if len(got) != 4 || got[2] != "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Bego=C3=B1a=C3=8D=C3=B1iguez" {
		t.Fatalf("3.0 fold after \"=\": %q", got)
	}
	v21 := "BEGIN:VCARD\r\nVERSION:2.1\r\nNOTE;ENCODING=QUOTED-PRINTABLE:=C3=91and=\r\n=C3=BA\r\nEND:VCARD\r\n"
	got = vcardLines(strings.NewReader(v21))
	if len(got) != 4 || got[2] != "NOTE;ENCODING=QUOTED-PRINTABLE:=C3=91and=C3=BA" {
		t.Fatalf("2.1 soft break: %q", got)
	}
}
