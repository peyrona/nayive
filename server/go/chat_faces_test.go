package main

// =============================================================================
// Pictures chosen in Chat that last (2026-09-27): the owner's own picture for
// another Nayive account (chatData.Faces, users/<account>/photo), and a
// person picked from the Contacts app whose picture becomes that card's PHOTO
// (cards/photo?uid=, vcard_photo.go).
// =============================================================================

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

var faceJPEG = []byte{0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9}

func (f *chatFixture) putRaw(t *testing.T, client *http.Client, path string, body []byte, want int) {
	t.Helper()
	resp := do(t, client, "PUT", f.base+path, bytes.NewReader(body), map[string]string{"Content-Type": "image/jpeg"})
	raw := readBody(t, resp)
	if resp.StatusCode != want {
		t.Fatalf("PUT %s = %d, want %d: %s", path, resp.StatusCode, want, raw)
	}
}

func (f *chatFixture) status(t *testing.T, client *http.Client, method, path string) int {
	t.Helper()
	resp := do(t, client, method, f.base+path, nil, nil)
	readBody(t, resp)
	return resp.StatusCode
}

// TestChatUserFace: ana's picture for beto is hers alone, shows before and
// after a chat exists (in either home), outlives the chat, and follows the
// admin's rename and delete.
func TestChatUserFace(t *testing.T) {
	f := newChatFixture(t)
	beto := f.signedIn(t, "beto", "xyz")

	f.putRaw(t, f.owner, "/api/chat/users/nadie/photo", faceJPEG, 404)
	f.putRaw(t, f.owner, "/api/chat/users/ana/photo", faceJPEG, 404) // not myself
	f.putRaw(t, f.owner, "/api/chat/users/beto/photo", []byte("<svg/>"), 400)
	f.putRaw(t, anonymous(), "/api/c/"+f.carmen+"/users/beto/photo", faceJPEG, 403)

	// No chat yet: set from "Nuevo chat".
	f.putRaw(t, f.owner, "/api/chat/users/beto/photo", faceJPEG, 200)
	var sum struct{ Avatars map[string]int64 }
	sum.Avatars = nil
	f.call(t, f.owner, "GET", "/api/chat", "", 200, &sum)
	if sum.Avatars["u-beto"] == 0 {
		t.Fatalf("ana's avatars = %v", sum.Avatars)
	}
	if c := f.status(t, f.owner, "GET", "/api/chat/avatar/u-beto"); c != 200 {
		t.Fatalf("ana cannot see her picture for beto: %d", c)
	}

	// beto starts the chat: it lives in HIS home, ana's picture still shows.
	var st chatUserStart
	f.call(t, beto, "POST", "/api/chat/contacts", `{"user":"ana"}`, 201, &st)
	sum.Avatars = nil
	f.call(t, f.owner, "GET", "/api/chat", "", 200, &sum)
	if sum.Avatars["u-beto"] == 0 {
		t.Fatalf("ana's avatars with the chat in beto's home = %v", sum.Avatars)
	}
	// ...and nobody else sees it: not beto, not a person by link.
	var bsum struct{ Avatars map[string]int64 }
	f.call(t, beto, "GET", "/api/chat/via/ana", "", 404, nil)
	f.call(t, beto, "GET", "/api/chat", "", 200, &bsum)
	if _, ok := bsum.Avatars["u-beto"]; ok {
		t.Fatalf("beto sees ana's picture of him: %v", bsum.Avatars)
	}
	bsum.Avatars = nil
	f.call(t, anonymous(), "GET", "/api/c/"+f.carmen, "", 200, &bsum)
	if _, ok := bsum.Avatars["u-beto"]; ok {
		t.Fatalf("a person sees ana's picture of beto: %v", bsum.Avatars)
	}
	if c := f.status(t, anonymous(), "GET", "/api/c/"+f.carmen+"/avatar/u-beto"); c != 404 {
		t.Fatalf("a person reads ana's picture of beto: %d", c)
	}
	// ana cannot set it through beto's home (a guest there).
	f.putRaw(t, f.owner, "/api/chat/via/beto/users/beto/photo", faceJPEG, 403)

	// The admin renames beto: the picture follows; deletes him: it goes.
	h := f.srv.chat
	home := f.srv.cfg.HomesDir
	os.Rename(filepath.Join(home, "beto"), filepath.Join(home, "bruno"))
	h.RenameUser("beto", "bruno")
	sum.Avatars = nil
	f.call(t, f.owner, "GET", "/api/chat", "", 200, &sum)
	if sum.Avatars["u-bruno"] == 0 || sum.Avatars["u-beto"] != 0 {
		t.Fatalf("after the rename = %v", sum.Avatars)
	}
	if _, err := os.Stat(filepath.Join(home, "ana", "data", "chat", "avatars", "u-bruno.jpg")); err != nil {
		t.Fatalf("the file did not follow the rename: %v", err)
	}
	os.RemoveAll(filepath.Join(home, "bruno"))
	h.DeleteUser("bruno")
	sum.Avatars = nil
	f.call(t, f.owner, "GET", "/api/chat", "", 200, &sum)
	if _, ok := sum.Avatars["u-bruno"]; ok {
		t.Fatalf("a deleted account keeps its picture: %v", sum.Avatars)
	}
}

// TestChatUserFaceRemove: DELETE drops the picture and its file.
func TestChatUserFaceRemove(t *testing.T) {
	f := newChatFixture(t)
	f.putRaw(t, f.owner, "/api/chat/users/beto/photo", faceJPEG, 200)
	f.call(t, f.owner, "DELETE", "/api/chat/users/beto/photo", "", 200, nil)
	if c := f.status(t, f.owner, "GET", "/api/chat/avatar/u-beto"); c != 404 {
		t.Fatalf("a removed picture is still served: %d", c)
	}
	var disk chatData
	loadJSONFile(filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "chat.json"), &disk)
	if len(disk.Faces) != 0 {
		t.Fatalf("chat.json faces = %v", disk.Faces)
	}
}

// TestChatPersonFromCard: a person picked from the address book keeps the
// card's UID, and a picture set for them becomes that card's PHOTO.
func TestChatPersonFromCard(t *testing.T) {
	f := newChatFixture(t)
	vcf := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "contacts.vcf")
	book := "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:card-1\r\nFN:Lola\r\nTEL;TYPE=CELL:600\r\nEND:VCARD\r\n" +
		"BEGIN:VCARD\r\nVERSION:3.0\r\nUID:card-2\r\nFN:Pepe\r\nEND:VCARD\r\n"
	os.WriteFile(vcf, []byte(book), 0o644)

	var c chatContactOut
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"name":"Lola","card":"card-1"}`, 201, &c)
	if c.Card != "card-1" {
		t.Fatalf("contact = %+v", c)
	}

	f.putRaw(t, f.owner, "/api/chat/cards/photo?uid=nope", faceJPEG, 404)
	f.putRaw(t, f.owner, "/api/chat/cards/photo?uid=card-1", []byte("GIF89a......"), 400)
	f.putRaw(t, anonymous(), "/api/c/"+f.carmen+"/cards/photo?uid=card-1", faceJPEG, 403)
	f.putRaw(t, f.owner, "/api/chat/cards/photo?uid=card-1", faceJPEG, 200)
	f.putRaw(t, f.owner, "/api/chat/cards/photo?uid=card-1", faceJPEG, 200) // again: replaces

	raw, _ := os.ReadFile(vcf)
	// The card's REV is the time the picture was set (B4): any time, here.
	got := regexp.MustCompile(`REV:[0-9TZ:-]+`).ReplaceAllString(string(raw), "REV:<now>")
	want := "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:card-1\r\nFN:Lola\r\nTEL;TYPE=CELL:600\r\n" +
		"PHOTO;ENCODING=b;TYPE=JPEG:" + base64.StdEncoding.EncodeToString(faceJPEG) + "\r\nREV:<now>\r\nEND:VCARD\r\n" +
		"BEGIN:VCARD\r\nVERSION:3.0\r\nUID:card-2\r\nFN:Pepe\r\nEND:VCARD\r\n"
	if got != want {
		t.Fatalf("contacts.vcf =\n%q\nwant\n%q", got, want)
	}
}

// TestWithCardPhoto: the file writer on its own - folded and 2.1 photos go,
// every other byte stays, the line ends are the file's.
func TestWithCardPhoto(t *testing.T) {
	img := bytes.Repeat([]byte{0xFF, 0xD8, 0xFF, 0x01}, 40) // a long base64: folded
	b64 := base64.StdEncoding.EncodeToString(img)

	// 2.1 (as Android exports): an old base64 PHOTO folded with two spaces and
	// its blank line; a QUOTED-PRINTABLE name with a soft break; LF ends.
	in := "BEGIN:VCARD\nVERSION:2.1\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=4C=6F=\n=6C=61;;;;\n" +
		"UID:a\nPHOTO;ENCODING=BASE64;JPEG:/9j/AAAA\n  BBBB\n\nEND:VCARD\n"
	now := time.Date(2026, 10, 2, 12, 30, 5, 0, time.UTC)
	out, err := withCardPhoto([]byte(in), "a", "JPEG", img, now)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Contains(s, "AAAA") || strings.Contains(s, "BBBB") || strings.Contains(s, "\r") {
		t.Fatalf("2.1 result =\n%s", s)
	}
	if !strings.HasPrefix(s, "BEGIN:VCARD\nVERSION:2.1\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=4C=6F=\n=6C=61;;;;\nUID:a\nPHOTO;ENCODING=BASE64;TYPE=JPEG:") ||
		!strings.HasSuffix(s, "\n\nREV:2026-10-02T12:30:05Z\nEND:VCARD\n") {
		t.Fatalf("2.1 result =\n%s", s)
	}
	var joined string
	for i, l := range strings.Split(s, "\n") {
		if len(l) > 75 {
			t.Fatalf("line %d is %d long", i, len(l))
		}
		if strings.HasPrefix(l, "PHOTO") {
			joined = l
		} else if joined != "" && strings.HasPrefix(l, " ") {
			joined += l[1:]
		} else if joined != "" && !strings.HasPrefix(joined, "done") {
			if joined != "PHOTO;ENCODING=BASE64;TYPE=JPEG:"+b64 {
				t.Fatalf("unfolded photo = %q", joined)
			}
			joined = "done"
		}
	}
	if joined != "done" {
		t.Fatalf("no photo line found in\n%s", s)
	}

	// 4.0: a data: URL. A card without that UID, or none at all: not found.
	// An old REV goes: the card changed now.
	out, _ = withCardPhoto([]byte("BEGIN:VCARD\r\nVERSION:4.0\r\nUID:b\r\nREV:20200101T000000Z\r\nEND:VCARD\r\n"), "b", "PNG", img, now)
	if !strings.Contains(strings.ReplaceAll(string(out), "\r\n ", ""), "PHOTO:data:image/png;base64,"+b64+"\r\nREV:2026-10-02T12:30:05Z\r\nEND:VCARD") ||
		strings.Contains(string(out), "2020") {
		t.Fatalf("4.0 result = %q", out)
	}
	if _, err := withCardPhoto([]byte(in), "zz", "JPEG", img, now); err != errCardNotFound {
		t.Fatalf("missing uid: %v", err)
	}
	if _, err := withCardPhoto([]byte(""), "a", "JPEG", img, now); err != errCardNotFound {
		t.Fatalf("empty file: %v", err)
	}
}
