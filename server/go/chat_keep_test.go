package main

// =============================================================================
// Chat: a photo kept in the owner's files (keep), and auto-delete (expire).
// =============================================================================

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var keepJPEG = []byte{0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9}

// upload sends one photo or file as Carmen and returns the message.
func (f *chatFixture) upload(t *testing.T, kind, name string, body []byte) chatMsgOut {
	t.Helper()
	conv := "d-" + f.ids["Carmen"]
	resp := do(t, anonymous(), "POST", fmt.Sprintf("%s/api/c/%s/conv/%s/upload?kind=%s&name=%s",
		f.base, f.carmen, conv, kind, name), bytes.NewReader(body), nil)
	raw := readBody(t, resp)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("upload %s = %d: %s", name, resp.StatusCode, raw)
	}
	var m chatMsgOut
	json.Unmarshal(raw, &m)
	return m
}

// TestChatKeep: the owner moves a photo into their files; the chat keeps
// showing it, and deleting the message never deletes the photo.
func TestChatKeep(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos"), 0o755)
	photo := f.upload(t, "photo", "IMG_1.jpg", keepJPEG)
	keepPath := fmt.Sprintf("/api/chat/conv/%s/messages/%d/keep", conv, photo.ID)

	f.call(t, anonymous(), "POST", fmt.Sprintf("/api/c/%s/conv/%s/messages/%d/keep", f.carmen, conv, photo.ID),
		`{"dir":"files/Fotos"}`, 403, nil)
	f.call(t, f.owner, "POST", keepPath, `{"dir":"data"}`, 400, nil)
	f.call(t, f.owner, "POST", keepPath, `{"dir":"files/../data"}`, 403, nil)
	f.call(t, f.owner, "POST", keepPath, `{"dir":"files/Nope"}`, 404, nil)

	var kept struct {
		Path string     `json:"path"`
		Msg  chatMsgOut `json:"msg"`
	}
	f.call(t, f.owner, "POST", keepPath, `{"dir":"files/Fotos"}`, 200, &kept)
	if kept.Path != "files/Fotos/IMG_1.jpg" || !kept.Msg.Kept {
		t.Fatalf("keep = %+v", kept)
	}
	if _, err := os.Stat(filepath.Join(home, "files", "Fotos", "IMG_1.jpg")); err != nil {
		t.Fatal("the photo is not in the owner's folder")
	}
	if entries, _ := os.ReadDir(filepath.Join(home, "data", "chat", "conv", conv, "media")); len(entries) != 0 {
		t.Fatalf("the photo is still under media/: %d entries", len(entries))
	}
	f.call(t, f.owner, "POST", keepPath, `{"dir":"files"}`, 200, &kept)
	if kept.Path != "files/Fotos/IMG_1.jpg" {
		t.Fatalf("keeping it again moved it: %q", kept.Path)
	}

	// Both sides still see it, from the owner's file, never cached for good.
	for _, url := range []string{
		fmt.Sprintf("%s/api/c/%s/conv/%s/media/%d", f.base, f.carmen, conv, photo.ID),
		fmt.Sprintf("%s/api/chat/conv/%s/media/%d", f.base, conv, photo.ID),
	} {
		client := anonymous()
		if url[len(f.base):len(f.base)+10] == "/api/chat/" {
			client = f.owner
		}
		resp := do(t, client, "GET", url, nil, nil)
		body := readBody(t, resp)
		if resp.StatusCode != 200 || !bytes.Equal(body, keepJPEG) || resp.Header.Get("Cache-Control") != "private, no-cache" {
			t.Fatalf("GET %s = %d %q, %d bytes", url, resp.StatusCode, resp.Header.Get("Cache-Control"), len(body))
		}
	}
	var list msgList
	f.call(t, anonymous(), "GET", "/api/c/"+f.carmen+"/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 1 || !list.Msgs[0].Kept {
		t.Fatalf("the person's list = %+v", list.Msgs)
	}
	if raw := f.call(t, anonymous(), "GET", "/api/c/"+f.carmen+"/conv/"+conv+"/messages", "", 200, nil); bytes.Contains(raw, []byte("Fotos")) {
		t.Fatalf("a person learns the owner's folder: %s", raw)
	}

	// After a restart the link is read back from state.json.
	f.srv.chat.DropUser("ana")
	f.call(t, anonymous(), "GET", "/api/c/"+f.carmen+"/conv/"+conv+"/messages", "", 200, &list)
	resp0 := do(t, anonymous(), "GET", fmt.Sprintf("%s/api/c/%s/conv/%s/media/%d", f.base, f.carmen, conv, photo.ID), nil, nil)
	if body := readBody(t, resp0); len(list.Msgs) != 1 || !list.Msgs[0].Kept || resp0.StatusCode != 200 || !bytes.Equal(body, keepJPEG) {
		t.Fatalf("after a restart: %+v, media %d", list.Msgs, resp0.StatusCode)
	}

	// A second photo of the same name gets its own.
	second := f.upload(t, "photo", "IMG_1.jpg", keepJPEG)
	f.call(t, f.owner, "POST", fmt.Sprintf("/api/chat/conv/%s/messages/%d/keep", conv, second.ID), `{"dir":"files/Fotos"}`, 200, &kept)
	if kept.Path != "files/Fotos/IMG_1 (2).jpg" {
		t.Fatalf("second keep = %q", kept.Path)
	}

	// A kept photo forwards (a copy, from the owner's file).
	var fw chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/d-"+f.ids["Javi"]+"/messages",
		fmt.Sprintf(`{"fwdConv":"%s","fwdId":%d}`, conv, photo.ID), 201, &fw)
	resp := do(t, anonymous(), "GET", fmt.Sprintf("%s/api/c/%s/conv/d-%s/media/%d", f.base, f.javi, f.ids["Javi"], fw.ID), nil, nil)
	if body := readBody(t, resp); resp.StatusCode != 200 || !bytes.Equal(body, keepJPEG) || fw.Kept {
		t.Fatalf("forwarded kept photo = %d, kept %v", resp.StatusCode, fw.Kept)
	}

	// Carmen deletes hers for everyone: the owner's photo stays.
	f.call(t, anonymous(), "DELETE", fmt.Sprintf("/api/c/%s/conv/%s/messages/%d", f.carmen, conv, photo.ID), "", 200, nil)
	if _, err := os.Stat(filepath.Join(home, "files", "Fotos", "IMG_1.jpg")); err != nil {
		t.Fatal("deleting the message deleted the kept photo")
	}
	// Both delete the chat (a purge): the second kept photo stays too.
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/clear", "", 200, nil)
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/conv/"+conv+"/clear", "", 200, nil)
	if _, err := os.Stat(filepath.Join(home, "files", "Fotos", "IMG_1 (2).jpg")); err != nil {
		t.Fatal("purging the chat deleted a kept photo")
	}
	f.srv.chat.mu.Lock()
	left := len(f.srv.chat.conv(f.srv.chat.owner("ana"), conv).st.Kept)
	f.srv.chat.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d links to kept photos outlived their messages", left)
	}
}

// age moves the first `n` messages of a conversation `days` into the past, on
// disk too.
func (f *chatFixture) age(t *testing.T, conv string, n int, days int) {
	t.Helper()
	h := f.srv.chat
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.conv(h.owner("ana"), conv)
	old := time.Now().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
	for i := 0; i < n && i < len(c.msgs); i++ {
		c.msgs[i].At = old + int64(i)
	}
	h.writeMonth(c, monthOf(time.Now().UnixMilli()))
	h.writeMonth(c, monthOf(old))
}

// TestChatAutoDelete: messages older than the owner's N days go for good,
// their files too - but not a kept photo.
func TestChatAutoDelete(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	gpath := "/api/c/" + f.carmen + "/conv/" + conv
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos"), 0o755)

	f.call(t, anonymous(), "POST", gpath+"/messages", `{"kind":"text","text":"viejo secreto"}`, 201, nil)
	file := f.upload(t, "file", "nota.txt", []byte("adjunto viejo"))
	photo := f.upload(t, "photo", "vieja.jpg", keepJPEG)
	f.call(t, f.owner, "POST", fmt.Sprintf("/api/chat/conv/%s/messages/%d/keep", conv, photo.ID), `{"dir":"files/Fotos"}`, 200, nil)
	f.call(t, anonymous(), "POST", gpath+"/messages", `{"kind":"text","text":"nuevo"}`, 201, nil)
	f.age(t, conv, 3, 40)

	f.call(t, anonymous(), "PUT", "/api/c/"+f.carmen+"/autodelete", `{"days":30}`, 403, nil)
	f.call(t, f.owner, "PUT", "/api/chat/autodelete", `{"days":-1}`, 400, nil)
	f.call(t, f.owner, "PUT", "/api/chat/autodelete", `{"days":4000}`, 400, nil)
	f.call(t, f.owner, "PUT", "/api/chat/autodelete", `{"days":60}`, 200, nil)
	var list struct {
		msgList
		Gone int64 `json:"gone"`
	}
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 4 || list.Gone != 0 {
		t.Fatalf("60 days deleted a 40-day-old message: %d left, gone %d", len(list.Msgs), list.Gone)
	}

	f.call(t, f.owner, "PUT", "/api/chat/autodelete", `{"days":30}`, 200, nil)
	f.call(t, anonymous(), "GET", gpath+"/messages", "", 200, &list)
	if len(list.Msgs) != 1 || list.Msgs[0].Text != "nuevo" || list.Gone != photo.ID {
		t.Fatalf("after 30 days: %d left (%+v), gone %d", len(list.Msgs), list.Msgs, list.Gone)
	}
	if _, err := os.Stat(filepath.Join(home, "data", "chat", "conv", conv, "media", fmt.Sprintf("%d.txt", file.ID))); !os.IsNotExist(err) {
		t.Fatal("an expired file is still on disk")
	}
	if _, err := os.Stat(filepath.Join(home, "files", "Fotos", "vieja.jpg")); err != nil {
		t.Fatal("auto-delete took a kept photo")
	}
	old := time.Now().Add(-40 * 24 * time.Hour).UTC().Format("2006-01")
	if old != time.Now().UTC().Format("2006-01") {
		if _, err := os.Stat(filepath.Join(home, "data", "chat", "conv", conv, old+".json")); !os.IsNotExist(err) {
			t.Fatal("the emptied month file is still there")
		}
	}
	// age() moved the old texts out of this month, so look in EVERY month file.
	months, _ := filepath.Glob(filepath.Join(home, "data", "chat", "conv", conv, "*.json"))
	for _, p := range months {
		if raw, _ := os.ReadFile(p); bytes.Contains(raw, []byte("viejo secreto")) {
			t.Fatalf("an expired text is still on disk, in %s", filepath.Base(p))
		}
	}
	var sum map[string]any
	f.call(t, f.owner, "GET", "/api/chat", "", 200, &sum)
	if sum["deleteAfter"] != float64(30) {
		t.Fatalf("summary deleteAfter = %v", sum["deleteAfter"])
	}
	f.call(t, anonymous(), "GET", "/api/c/"+f.carmen, "", 200, &sum)
	if sum["deleteAfter"] != float64(30) {
		t.Fatalf("a person is not told: deleteAfter = %v", sum["deleteAfter"])
	}

	// The hourly pass reads chat.json for an owner nobody has opened.
	f.call(t, f.owner, "PUT", "/api/chat/autodelete", `{"days":0}`, 200, nil)
	f.age(t, conv, 1, 40)
	h := f.srv.chat
	h.mu.Lock()
	h.owner("ana").data.DeleteAfter = 30
	h.saveData(h.owner("ana"))
	h.mu.Unlock()
	h.DropUser("ana")
	h.expireAll(time.Now())
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 0 {
		t.Fatalf("the hourly pass left %d messages", len(list.Msgs))
	}
}

// TestChatPhotoPos: a photo with a GPS position carries it in its message
// (the page's "See on the map"), a forward too; a photo without one has none.
func TestChatPhotoPos(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	fix := time.Date(2026, 9, 19, 10, 0, 0, 0, time.UTC)
	photo := f.upload(t, "photo", "gps.jpg", exifJPEG(t, nil, gpsEntries(41.5, -3.25, fix, 12)))
	if p := photo.File.Pos; p == nil || math.Abs(p.Lat-41.5) > 1e-6 || math.Abs(p.Lon+3.25) > 1e-6 || p.Acc != 12 {
		t.Fatalf("pos = %+v, want 41.5, -3.25 ±12", p)
	}

	var fw chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/d-"+f.ids["Javi"]+"/messages",
		fmt.Sprintf(`{"fwdConv":"%s","fwdId":%d}`, conv, photo.ID), 201, &fw)
	if fw.File == nil || fw.File.Pos == nil || fw.File.Pos.Lat != photo.File.Pos.Lat {
		t.Fatalf("the forward lost the position: %+v", fw.File)
	}

	var month chatMonth
	raw, _ := os.ReadFile(filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "conv", conv, monthOf(photo.At)+".json"))
	json.Unmarshal(raw, &month)
	onDisk := false
	for _, m := range month.Messages {
		onDisk = onDisk || (m.ID == photo.ID && m.File != nil && m.File.Pos != nil && m.File.Pos.Lat == photo.File.Pos.Lat)
	}
	if !onDisk {
		t.Fatalf("the position is not on disk: %s", raw)
	}

	plain := f.upload(t, "photo", "plain.jpg", plainJPEG(t))
	if plain.File.Pos != nil {
		t.Fatalf("a photo without GPS got a position: %+v", plain.File.Pos)
	}
}

// TestChatPhotoKeepsGPS: a chat photo keeps its Exif - the position too (his
// call, 2026-09-19) - but not what a phone appends after the image; a person's
// picture still loses its position.
func TestChatPhotoKeepsGPS(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	orig, trailer := gpsJPEG(t)
	photo := f.upload(t, "photo", "gps.jpg", orig)

	resp := do(t, anonymous(), "GET", fmt.Sprintf("%s/api/c/%s/conv/%s/media/%d", f.base, f.carmen, conv, photo.ID), nil, nil)
	body := readBody(t, resp)
	if resp.StatusCode != 200 || !bytes.Equal(body, orig[:len(orig)-len(trailer)]) {
		t.Fatalf("the photo came back changed: %d, %d bytes of %d", resp.StatusCode, len(body), len(orig)-len(trailer))
	}
	if n := binary.LittleEndian.Uint16(exifTIFF(t, body)[testGPSIFD:]); n != 2 {
		t.Fatalf("the GPS IFD has %d entries, want 2", n)
	}

	resp = do(t, f.owner, "PUT", f.base+"/api/chat/contacts/"+f.ids["Carmen"]+"/photo", bytes.NewReader(orig),
		map[string]string{"Content-Type": "image/jpeg"})
	readBody(t, resp)
	resp = do(t, f.owner, "GET", f.base+"/api/chat/avatar/"+f.ids["Carmen"], nil, nil)
	body = readBody(t, resp)
	if n := binary.LittleEndian.Uint16(exifTIFF(t, body)[testGPSIFD:]); n != 0 || bytes.Contains(body, []byte("MOTIONPHOTO")) {
		t.Fatalf("a person's picture kept its position (%d GPS entries)", n)
	}
}
