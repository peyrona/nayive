package main

// Data-safety seal (cleanup Phase 3, batch S8): the last routes that read a
// home moved under them (an admin rename while the request was let in) as
// "not there". 404 tells a page or the phone "no such thing - start again";
// 503 tells it "try again", and by then it asks the right home (L2,
// sendMissing in sandbox.go).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestDS_L2_GoneHomeNot404PhoneChatMail: the phone's chunk and its "end",
// Chat's "Copiar" into the owner's files, and an eMail sent with a Drive
// file, while the admin renames the account under them: 503, never 404. A
// thing really missing from a home that is there is still 404 on each.
func TestDS_L2_GoneHomeNot404PhoneChatMail(t *testing.T) {
	t.Run("phone", func(t *testing.T) {
		shortHold(t)
		srv, ts, client := newTestServer(t)
		signIn(t, client, ts.URL, "ana", "abc")
		id := enrolPhone(t, client, ts.URL)
		jsonCall(t, client, "PUT", ts.URL+"/api/device/"+id, `{"media":true}`, 200, nil)
		m := mediaPhone{t, ts.URL}
		data := bytes.Repeat([]byte("0123456789"), 100)
		code, st := m.start("img-1", "IMG_1.jpg", int64(len(data)), time.Now())
		if code != 200 {
			t.Fatalf("start = %d %v", code, st)
		}
		up := st["upload"].(string)
		if code, out := m.put(up, 0, data[:400]); code != 200 {
			t.Fatalf("first chunk = %d %v", code, out)
		}
		if code, _ := m.put(up+"x", 0, data); code != http.StatusNotFound {
			t.Errorf("a chunk of an upload that is not there = %d, want 404", code)
		}

		if got := srv.users.RenameAccount("ana", "ana2"); got != "renamed" {
			t.Fatalf("rename: %s", got)
		}
		if code, out := m.put(up, 400, data[400:]); code != http.StatusServiceUnavailable {
			t.Errorf("a chunk while the home moved = %d %v, want 503", code, out)
		}
		if code, out := m.end(up); code != http.StatusServiceUnavailable {
			t.Errorf("the end while the home moved = %d %v, want 503", code, out)
		}
		if _, err := os.Stat(filepath.Join(srv.cfg.HomesDir, "ana")); err == nil {
			t.Errorf("homes/ana/ came back (a ghost home)")
		}
	})

	t.Run("chat", func(t *testing.T) {
		f := newChatFixture(t)
		conv := "d-" + f.ids["Carmen"]
		os.MkdirAll(filepath.Join(f.srv.cfg.HomesDir, "ana", "files", "Fotos"), 0o755)
		photo := f.upload(t, "photo", "IMG_1.jpg", keepJPEG)
		keep := fmt.Sprintf("/api/chat/conv/%s/messages/%d/keep", conv, photo.ID)
		f.call(t, f.owner, "POST", keep, `{"dir":"files/Nope"}`, http.StatusNotFound, nil)

		if got := f.srv.users.RenameAccount("ana", "ana2"); got != "renamed" {
			t.Fatalf("rename: %s", got)
		}
		code, raw := callJSON(t, f.owner, "POST", f.base+keep, `{"dir":"files/Fotos"}`)
		if code != http.StatusServiceUnavailable {
			t.Errorf("Copiar while the home moved = %d %s, want 503", code, raw)
		}
		if _, err := os.Stat(filepath.Join(f.srv.cfg.HomesDir, "ana")); err == nil {
			t.Errorf("homes/ana/ came back (a ghost home)")
		}
	})

	t.Run("mail", func(t *testing.T) {
		f, sent := newWriteFixture(t)
		f.addAccount(t, mailTestPass, 200)
		os.WriteFile(filepath.Join(f.srv.cfg.HomesDir, "ana", "files", "plano.txt"), []byte("un plano"), 0o644)
		send := func(drive string) (int, []byte) {
			var body bytes.Buffer
			mw := multipart.NewWriter(&body)
			raw, _ := json.Marshal(MailOut{To: "a@b.c", Subject: "plano", Text: "va", Drive: []string{drive}})
			mw.WriteField("json", string(raw))
			mw.Close()
			resp := do(t, f.owner, "POST", f.base+"/api/mail/a1/send", &body,
				map[string]string{"Content-Type": mw.FormDataContentType()})
			return resp.StatusCode, readBody(t, resp)
		}
		if code, raw := send("files/nada.txt"); code != http.StatusNotFound {
			t.Errorf("a Drive file that is not there = %d %s, want 404", code, raw)
		}

		if got := f.srv.users.RenameAccount("ana", "ana2"); got != "renamed" {
			t.Fatalf("rename: %s", got)
		}
		if code, raw := send("files/plano.txt"); code != http.StatusServiceUnavailable {
			t.Errorf("a Drive file while the home moved = %d %s, want 503", code, raw)
		}
		if len(*sent) != 0 {
			t.Errorf("a mail went out without its file: %d sent", len(*sent))
		}
	})
}
