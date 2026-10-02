package main

// Data-safety seal (cleanup Phase 3, batch S2): a Contacts picture set from
// Chat is never lost to a Contacts save (B4).

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestDS_B4_CardPhotoNotLostToHeldSave: the Contacts app saved a few edits
// in a row (its held Last-Modified is then ahead of the clock); Chat sets the
// card's picture; the app's next save, with the time it holds, is refused
// (412, so it merges) instead of writing the book without the PHOTO.
func TestDS_B4_CardPhotoNotLostToHeldSave(t *testing.T) {
	f := newChatFixture(t)
	book := "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:card-1\r\nFN:Lola\r\nTEL;TYPE=CELL:600\r\nEND:VCARD\r\n"
	put := func(body, ius string) (int, string) {
		h := map[string]string{"Content-Type": "text/vcard"}
		if ius != "" {
			h["If-Unmodified-Since"] = ius
		}
		resp := do(t, f.owner, "PUT", f.base+"/api/files?file=data/contacts.vcf", strings.NewReader(body), h)
		readBody(t, resp)
		return resp.StatusCode, resp.Header.Get("Last-Modified")
	}
	held := ""
	for i := 0; i < 4; i++ { // the Contacts app saving a few edits in a row
		_, held = put(book+fmt.Sprintf("NOTE:%d\r\n", i), held)
	}
	f.putRaw(t, f.owner, "/api/chat/cards/photo?uid=card-1", faceJPEG, 200)

	code, _ := put(book+"NOTE:after\r\n", held)
	after, _ := os.ReadFile(filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "contacts.vcf"))
	if code != 412 {
		t.Errorf("the Contacts save with its held time (%s) = %d, want 412", held, code)
	}
	if !bytes.Contains(after, []byte("PHOTO")) {
		t.Error("the picture set from Chat is gone")
	}
}

// TestDS_B4_CardPhotoWaitsForUploadLock: while a PUT of contacts.vcf holds
// the file's lock (its final check and rename), the picture waits - it never
// reads the book before that save and renames an older book over it.
func TestDS_B4_CardPhotoWaitsForUploadLock(t *testing.T) {
	srv, _, _ := newTestServer(t)
	vcf := filepath.Join(srv.cfg.HomesDir, "ana", "data", "contacts.vcf")
	os.WriteFile(vcf, []byte("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u1\r\nFN:Lola\r\nEND:VCARD\r\n"), 0o644)
	abs, _ := srv.users.ResolvePath("user", "ana", "data/contacts.vcf") // what a PUT locks

	unlock := lockPath(abs)
	done := make(chan error, 1)
	go func() { done <- setCardPhoto(vcf, "u1", faceJPEG) }()
	// Proving something does NOT happen needs a bounded wait: 300 ms is far
	// longer than the whole write takes when nothing holds it.
	select {
	case err := <-done:
		unlock()
		t.Fatalf("the picture was written while a save held the file (%v)", err)
	case <-time.After(300 * time.Millisecond):
	}
	unlock()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(vcf); !bytes.Contains(raw, []byte("PHOTO")) {
		t.Error("no PHOTO after the lock was released")
	}
}

// TestDS_B4_CardPhotoBumpsREV: the card's REV becomes the time the picture
// was set, so a merge with an edit made before it (an offline phone) does
// not count that older card as the newer one.
func TestDS_B4_CardPhotoBumpsREV(t *testing.T) {
	vcf := filepath.Join(t.TempDir(), "contacts.vcf")
	os.WriteFile(vcf, []byte("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u1\r\nFN:Lola\r\nREV:2020-01-01T00:00:00Z\r\nEND:VCARD\r\n"+
		"BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u2\r\nFN:Pepe\r\nREV:2020-01-01T00:00:00Z\r\nEND:VCARD\r\n"), 0o644)
	before := time.Now().UTC().Truncate(time.Second)
	if err := setCardPhoto(vcf, "u1", faceJPEG); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(vcf)
	revs := regexp.MustCompile(`REV:(\S+)`).FindAllStringSubmatch(string(raw), -1)
	if len(revs) != 2 {
		t.Fatalf("REV lines = %v in\n%s", revs, raw)
	}
	got, err := time.Parse("2006-01-02T15:04:05Z", revs[0][1])
	if err != nil || got.Before(before) {
		t.Errorf("the card's REV = %q, want the time the picture was set (>= %s)", revs[0][1], before.Format(time.RFC3339))
	}
	if revs[1][1] != "2020-01-01T00:00:00Z" {
		t.Errorf("the OTHER card's REV changed: %q", revs[1][1])
	}
}
