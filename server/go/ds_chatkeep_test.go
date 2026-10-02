package main

// Data-safety seal (cleanup Phase 3, batch S4): Chat's photos and history are
// never lost. A photo sent from, or kept in, the owner's files outlives that
// file and is never swapped for another one at its path (J4); "Editar" never
// writes over the photo (J1); "delete chat for me" never purges what a removed
// member may come back to (J6); auto-delete says what it would delete (J7)
// and never runs on a clock that just jumped (J8).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// dsMedia GETs a message's photo as Carmen: status and bytes.
func (f *chatFixture) dsMedia(t *testing.T, conv string, id int64) (int, []byte) {
	t.Helper()
	resp := do(t, anonymous(), "GET", fmt.Sprintf("%s/api/c/%s/conv/%s/media/%d", f.base, f.carmen, conv, id), nil, nil)
	body := readBody(t, resp)
	return resp.StatusCode, body
}

// dsOtherJPEG is another picture than keepJPEG.
func dsOtherJPEG(b byte) []byte {
	other := append([]byte{}, keepJPEG...)
	other[6] = b
	return other
}

// TestDS_J4_LinkedPhotoOutlivesItsFile: a photo sent from the owner's files
// stays in the conversation when the owner bins that file and empties the
// bin, and a NEW photo later saved at that path (cameras reuse names) is never
// shown in the old message.
func TestDS_J4_LinkedPhotoOutlivesItsFile(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos"), 0o755)
	os.WriteFile(filepath.Join(home, "files", "Fotos", "IMG_0001.jpg"), keepJPEG, 0o644)
	var m chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"ref":"files/Fotos/IMG_0001.jpg"}`, 201, &m)

	jsonCall(t, f.owner, "DELETE", f.base+"/api/files?paths=files/Fotos/IMG_0001.jpg", "", 200, nil)
	if code, body := f.dsMedia(t, conv, m.ID); code != 200 || !bytes.Equal(body, keepJPEG) {
		t.Errorf("binned in Drive: the chat's photo = %d, the same: %v", code, bytes.Equal(body, keepJPEG))
	}
	other := dsOtherJPEG(0x77)
	readBody(t, do(t, f.owner, "PUT", f.base+"/api/files?file=files/Fotos/IMG_0001.jpg", bytes.NewReader(other), nil))
	f.srv.chat.mu.Lock() // past the "not looked for again" window
	f.srv.chat.conv(f.srv.chat.owner("ana"), conv).missed = nil
	f.srv.chat.mu.Unlock()
	if code, body := f.dsMedia(t, conv, m.ID); code != 200 || !bytes.Equal(body, keepJPEG) {
		t.Errorf("a new photo at that path: the old message shows the new one: %v (%d)", bytes.Equal(body, other), code)
	}
	jsonCall(t, f.owner, "POST", f.base+"/api/files?trash=empty", "", 200, nil)
	f.srv.chat.DropUser("ana") // and a restart
	if code, body := f.dsMedia(t, conv, m.ID); code != 200 || !bytes.Equal(body, keepJPEG) {
		t.Errorf("bin emptied, restart: the chat's photo = %d", code)
	}
	// Editar must never open that other file as this photo: keep answers it
	// is no longer in the owner's files.
	code, _ := callJSON(t, f.owner, "POST", fmt.Sprintf("%s/api/chat/conv/%s/messages/%d/keep", f.base, conv, m.ID), `{}`)
	if code != 410 {
		t.Errorf("keep of a photo whose file is gone = %d, want 410", code)
	}
}

// TestDS_J4_KeptPhotoOutlivesItsFile: a guest's photo the owner kept
// (Copiar) stays in the conversation when the owner bins the kept file.
func TestDS_J4_KeptPhotoOutlivesItsFile(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos"), 0o755)
	photo := f.upload(t, "photo", "IMG_1.jpg", keepJPEG)
	f.call(t, f.owner, "POST", fmt.Sprintf("/api/chat/conv/%s/messages/%d/keep", conv, photo.ID), `{"dir":"files/Fotos"}`, 200, nil)
	jsonCall(t, f.owner, "DELETE", f.base+"/api/files?paths=files/Fotos/IMG_1.jpg", "", 200, nil)
	jsonCall(t, f.owner, "POST", f.base+"/api/files?trash=empty", "", 200, nil)
	if code, body := f.dsMedia(t, conv, photo.ID); code != 200 || !bytes.Equal(body, keepJPEG) {
		t.Errorf("the kept file binned and the bin emptied: the chat's photo = %d", code)
	}
}

// TestDS_J4_OldKeptLinkNeverShowsAnotherFile: a photo kept by an older
// server (no copy under media/, only the link to the owner's file): a new
// file at its path is never shown; the photo itself, moved, still is - and
// from then on the chat holds it too.
func TestDS_J4_OldKeptLinkNeverShowsAnotherFile(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos", "Viaje"), 0o755)
	p := filepath.Join(home, "files", "Fotos", "IMG_0002.jpg")
	os.WriteFile(p, keepJPEG, 0o644)
	var m chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"ref":"files/Fotos/IMG_0002.jpg"}`, 201, &m)
	own := filepath.Join(home, "data", "chat", "conv", conv, "media", fmt.Sprintf("%d.jpg", m.ID))
	os.Remove(own) // as an older server left it

	// The photo moved away, another one saved at its path.
	os.Rename(p, filepath.Join(home, "files", "Fotos", "Viaje", "playa.jpg"))
	other := dsOtherJPEG(0x55)
	os.WriteFile(p, other, 0o644)
	if code, body := f.dsMedia(t, conv, m.ID); code != 200 || !bytes.Equal(body, keepJPEG) {
		t.Errorf("an old link: the message shows %d, the other photo: %v", code, bytes.Equal(body, other))
	}
	if b, err := os.ReadFile(own); err != nil || !bytes.Equal(b, keepJPEG) {
		t.Errorf("the chat did not take its own copy once found: %v", err)
	}
	// Gone from everywhere but a new file at the path: never that one.
	os.Remove(own)
	os.Remove(filepath.Join(home, "files", "Fotos", "Viaje", "playa.jpg"))
	f.srv.chat.mu.Lock()
	f.srv.chat.conv(f.srv.chat.owner("ana"), conv).missed = nil
	f.srv.chat.mu.Unlock()
	if code, body := f.dsMedia(t, conv, m.ID); bytes.Equal(body, other) {
		t.Errorf("a new file at the old path shows in the old message (%d)", code)
	}
}

// TestDS_J1_EditedPhotoIsANewFile: the owner's edit of a photo sent from
// their library is a NEW file beside it, and the message is pointed there:
// the library original keeps its bytes, the person sees the edit. Only the
// owner, and only for a photo already safe in their files.
func TestDS_J1_EditedPhotoIsANewFile(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos"), 0o755)
	orig := filepath.Join(home, "files", "Fotos", "IMG_7.jpeg")
	os.WriteFile(orig, keepJPEG, 0o644)
	var m chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"ref":"files/Fotos/IMG_7.jpeg"}`, 201, &m)

	// The page saves the edit beside it, never over a name (If-None-Match: *).
	edit := dsOtherJPEG(0x44)
	resp := do(t, f.owner, "PUT", f.base+"/api/files?file=files/Fotos/IMG_7-editado.jpg", bytes.NewReader(edit),
		map[string]string{"If-None-Match": "*"})
	if readBody(t, resp); resp.StatusCode != 200 {
		t.Fatalf("saving the edit = %d", resp.StatusCode)
	}
	edited := fmt.Sprintf("/api/chat/conv/%s/messages/%d/edited", conv, m.ID)
	f.call(t, anonymous(), "POST", fmt.Sprintf("/api/c/%s/conv/%s/messages/%d/edited", f.carmen, conv, m.ID),
		`{"ref":"files/Fotos/IMG_7-editado.jpg"}`, 403, nil)
	var out struct {
		Path string     `json:"path"`
		Msg  chatMsgOut `json:"msg"`
	}
	f.call(t, f.owner, "POST", edited, `{"ref":"files/Fotos/IMG_7-editado.jpg","w":40,"h":30}`, 200, &out)
	if out.Path != "files/Fotos/IMG_7-editado.jpg" || !out.Msg.Kept || out.Msg.Rev <= m.Rev || out.Msg.File.W != 40 {
		t.Errorf("edited = %+v", out)
	}
	if b, _ := os.ReadFile(orig); !bytes.Equal(b, keepJPEG) {
		t.Error("the library original was changed")
	}
	if code, body := f.dsMedia(t, conv, m.ID); code != 200 || !bytes.Equal(body, edit) {
		t.Errorf("the person does not see the edit: %d", code)
	}
	f.srv.chat.DropUser("ana") // after a restart too
	if code, body := f.dsMedia(t, conv, m.ID); code != 200 || !bytes.Equal(body, edit) {
		t.Errorf("after a restart the person does not see the edit: %d", code)
	}

	// A guest's photo nobody kept: its only copy is the chat's - refused.
	photo := f.upload(t, "photo", "suya.jpg", keepJPEG)
	f.call(t, f.owner, "POST", fmt.Sprintf("/api/chat/conv/%s/messages/%d/edited", conv, photo.ID),
		`{"ref":"files/Fotos/IMG_7-editado.jpg"}`, 409, nil)
	if code, body := f.dsMedia(t, conv, photo.ID); code != 200 || !bytes.Equal(body, keepJPEG) {
		t.Errorf("a refused edit changed the guest's photo: %d", code)
	}
}

// TestDS_J6_PurgeKeepsRemovedMembersHistory: Carmen deletes the group chat,
// Javi is removed by mistake, the owner deletes it too, Javi is put back:
// he never deleted it, and finds all of it. Once he deletes it as well, it
// is purged.
func TestDS_J6_PurgeKeepsRemovedMembersHistory(t *testing.T) {
	f := newChatFixture(t)
	var g struct{ ID string }
	f.call(t, f.owner, "POST", "/api/chat/groups", fmt.Sprintf(`{"name":"Familia","members":["%s","%s"]}`, f.ids["Carmen"], f.ids["Javi"]), 201, &g)
	conv := "g-" + g.ID
	for i := 1; i <= 3; i++ {
		f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", fmt.Sprintf(`{"kind":"text","text":"foto %d"}`, i), 201, nil)
	}
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/conv/"+conv+"/clear", "", 200, nil)
	f.call(t, f.owner, "PATCH", "/api/chat/groups/"+g.ID, fmt.Sprintf(`{"members":["%s"]}`, f.ids["Carmen"]), 200, nil)
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/clear", "", 200, nil)
	f.call(t, f.owner, "PATCH", "/api/chat/groups/"+g.ID, fmt.Sprintf(`{"members":["%s","%s"]}`, f.ids["Carmen"], f.ids["Javi"]), 200, nil)
	var list msgList
	f.call(t, anonymous(), "GET", "/api/c/"+f.javi+"/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 3 {
		t.Errorf("Javi (never cleared it) sees %d of 3 messages", len(list.Msgs))
	}

	f.call(t, anonymous(), "POST", "/api/c/"+f.javi+"/conv/"+conv+"/clear", "", 200, nil)
	month := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "conv", conv, time.Now().UTC().Format("2006-01")+".json")
	if raw, err := os.ReadFile(month); err == nil && bytes.Contains(raw, []byte("foto 1")) {
		t.Error("everybody deleted it: still on disk")
	}
}

// TestDS_J7_AutoDeleteCount: before auto-delete is set, the owner can see
// how many messages it would delete now - and asking deletes nothing.
func TestDS_J7_AutoDeleteCount(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	for i := 1; i <= 3; i++ {
		f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", fmt.Sprintf(`{"kind":"text","text":"m%d"}`, i), 201, nil)
	}
	f.call(t, f.owner, "POST", "/api/chat/conv/d-"+f.ids["Javi"]+"/messages", `{"kind":"text","text":"j"}`, 201, nil)
	f.age(t, conv, 2, 40)
	f.call(t, f.owner, "DELETE", "/api/chat/conv/"+conv+"/messages/2", "", 200, nil) // deleted for everyone: not counted

	count := func(days string) int {
		var out struct{ N int }
		f.call(t, f.owner, "GET", "/api/chat/autodelete?days="+days, "", 200, &out)
		return out.N
	}
	if n := count("30"); n != 1 {
		t.Errorf("30 days would delete %d, want 1", n)
	}
	if n := count("1"); n != 1 {
		t.Errorf("1 day would delete %d, want 1", n)
	}
	if n := count("60"); n != 0 {
		t.Errorf("60 days would delete %d, want 0", n)
	}
	f.call(t, f.owner, "GET", "/api/chat/autodelete?days=-1", "", 400, nil)
	f.call(t, anonymous(), "GET", "/api/c/"+f.carmen+"/autodelete?days=1", "", 403, nil)
	var list msgList
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
	if len(list.Msgs) != 3 {
		t.Errorf("counting deleted messages: %d left", len(list.Msgs))
	}
}

// TestDS_J8_NoAutoDeleteOnAJumpedClock: the clock is three days past the last
// auto-delete pass (a wrong date at boot): nothing is deleted, and it is
// logged. Once the clock has run steady long enough, it runs.
func TestDS_J8_NoAutoDeleteOnAJumpedClock(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	for i := 1; i <= 3; i++ {
		f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", fmt.Sprintf(`{"kind":"text","text":"m%d"}`, i), 201, nil)
	}
	f.age(t, conv, 2, 40)
	var logged bytes.Buffer
	h := f.srv.chat
	h.log = slog.New(slog.NewTextHandler(&logged, nil))
	last, _ := json.Marshal(map[string]int64{"ran": time.Now().Add(-72 * time.Hour).UnixMilli()})
	os.WriteFile(filepath.Join(f.srv.cfg.ConfigDir, "chat-autodelete.json"), last, 0o644)

	left := func() int {
		var list msgList
		f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
		return len(list.Msgs)
	}
	f.call(t, f.owner, "PUT", "/api/chat/autodelete", `{"days":30}`, 200, nil)
	h.expireAll(time.Now())
	if n := left(); n != 3 {
		t.Errorf("a clock 3 days past the last pass deleted: %d of 3 left", n)
	}
	if !strings.Contains(logged.String(), "auto-delete") {
		t.Errorf("not logged:\n%s", logged.String())
	}

	old := chatClockTrust
	chatClockTrust = 0 // the clock has run steady "long enough"
	t.Cleanup(func() { chatClockTrust = old })
	h.expireAll(time.Now())
	if n := left(); n != 1 {
		t.Errorf("a steady clock: %d left, want 1", n)
	}
	var kept struct{ Ran int64 }
	raw, _ := os.ReadFile(filepath.Join(f.srv.cfg.ConfigDir, "chat-autodelete.json"))
	if json.Unmarshal(raw, &kept); time.Since(time.UnixMilli(kept.Ran)) > time.Minute {
		t.Errorf("the pass's time was not kept: %s", raw)
	}
}

// dsChatJSON is the bytes of the owner's chat data outside media/: what a
// message adds to the quota besides its photo.
func dsChatJSON(home string) int64 {
	var n int64
	filepath.WalkDir(filepath.Join(home, "data", "chat"), func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && d.Name() == "media" {
			return filepath.SkipDir
		}
		if info, err := d.Info(); err == nil && info.Mode().IsRegular() {
			n += info.Size()
		}
		return nil
	})
	return n
}

// dsBigJPEG is a JPEG of about 64 KB: big next to a message's JSON.
func dsBigJPEG() []byte {
	b := []byte{0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02}
	b = append(b, bytes.Repeat([]byte{0x11}, 64<<10)...)
	return append(b, 0xFF, 0xD9)
}

// TestDS_J4_LinkedPhotoCountedOnce: a photo sent from the library, or kept,
// has two names in the home (media/ and files/) but takes its room once: the
// quota, measured again from the disk, counts it once.
func TestDS_J4_LinkedPhotoCountedOnce(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos"), 0o755)
	os.WriteFile(filepath.Join(home, "files", "Fotos", "IMG_7.jpg"), dsBigJPEG(), 0o644)
	measure := func() (int64, int64) {
		f.srv.users.ForgetUsage("ana")
		return f.srv.users.UserUsageBytes("ana"), dsChatJSON(home)
	}

	before, json0 := measure()
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"ref":"files/Fotos/IMG_7.jpg"}`, 201, nil)
	after, json1 := measure()
	if grew := after - before - (json1 - json0); grew != 0 {
		t.Errorf("sending a library photo of %d bytes added %d to the quota", len(dsBigJPEG()), grew)
	}

	photo := f.upload(t, "photo", "IMG_1.jpg", dsBigJPEG())
	before, json0 = measure()
	f.call(t, f.owner, "POST", fmt.Sprintf("/api/chat/conv/%s/messages/%d/keep", conv, photo.ID), `{"dir":"files/Fotos"}`, 200, nil)
	after, json1 = measure()
	if grew := after - before - (json1 - json0); grew != 0 {
		t.Errorf("keeping a chat photo of %d bytes added %d to the quota", len(dsBigJPEG()), grew)
	}
}

// TestDS_J1_EditNotSavedIsUndone: the message that would show the edit
// cannot be written (disk full, I/O error): answered with an error, and the
// message still shows the photo it showed - now and after a restart. The
// edit stays a file of the owner's.
func TestDS_J1_EditNotSavedIsUndone(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes into a 0500 folder")
	}
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos"), 0o755)
	os.WriteFile(filepath.Join(home, "files", "Fotos", "IMG_7.jpeg"), keepJPEG, 0o644)
	var m chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"ref":"files/Fotos/IMG_7.jpeg"}`, 201, &m)
	edit := dsOtherJPEG(0x44)
	os.WriteFile(filepath.Join(home, "files", "Fotos", "IMG_7-editado.jpg"), edit, 0o644)

	dir := filepath.Join(home, "data", "chat", "conv", conv)
	os.Chmod(dir, 0o500) // its month and state cannot be written; media/ can
	code, body := callJSON(t, f.owner, "POST", fmt.Sprintf("%s/api/chat/conv/%s/messages/%d/edited", f.base, conv, m.ID),
		`{"ref":"files/Fotos/IMG_7-editado.jpg"}`)
	os.Chmod(dir, 0o755)
	if code < 400 {
		t.Errorf("an edit that could not be saved = %d %s", code, body)
	}
	if code, got := f.dsMedia(t, conv, m.ID); code != 200 || !bytes.Equal(got, keepJPEG) {
		t.Errorf("the message shows the unsaved edit: %v (%d)", bytes.Equal(got, edit), code)
	}
	var where struct{ Path string }
	f.call(t, f.owner, "POST", fmt.Sprintf("/api/chat/conv/%s/messages/%d/keep", conv, m.ID), `{}`, 200, &where)
	if where.Path != "files/Fotos/IMG_7.jpeg" {
		t.Errorf("the message is kept as %q", where.Path)
	}
	f.srv.chat.DropUser("ana") // a restart
	if code, got := f.dsMedia(t, conv, m.ID); code != 200 || !bytes.Equal(got, keepJPEG) {
		t.Errorf("after a restart the message shows the unsaved edit: %v (%d)", bytes.Equal(got, edit), code)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "files", "Fotos", "IMG_7-editado.jpg")); !bytes.Equal(b, edit) {
		t.Error("the edit's file was lost")
	}
}

// TestDS_J8_DoubtSurvivesRestart: the clock was doubted 25 hours ago and
// looked at an hour ago (the server restarted since): a day has gone by on a
// steady clock, so auto-delete runs. Had the clock jumped again since the
// last look, the doubt starts over.
func TestDS_J8_DoubtSurvivesRestart(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	for i := 1; i <= 3; i++ {
		f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", fmt.Sprintf(`{"kind":"text","text":"m%d"}`, i), 201, nil)
	}
	f.age(t, conv, 2, 40)
	h := f.srv.chat
	h.mu.Lock()
	h.owner("ana").data.DeleteAfter = 30
	h.saveData(h.owner("ana"))
	h.mu.Unlock()
	clockFile := filepath.Join(f.srv.cfg.ConfigDir, "chat-autodelete.json")
	left := func() int {
		var list msgList
		f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, &list)
		return len(list.Msgs)
	}
	at := func(d time.Duration) int64 { return time.Now().Add(-d).UnixMilli() }
	restart := func(disk map[string]int64) {
		raw, _ := json.Marshal(disk)
		os.WriteFile(clockFile, raw, 0o644)
		h.mu.Lock()
		h.clockRead = false // read again, as after a restart
		h.mu.Unlock()
	}

	// A jump since the last look (3 days of gap): the doubt starts over.
	restart(map[string]int64{"ran": at(96 * time.Hour), "doubt": at(50 * time.Hour), "seen": at(72 * time.Hour)})
	h.expireAll(time.Now())
	if n := left(); n != 3 {
		t.Errorf("a clock that jumped again since the last look was believed: %d of 3 left", n)
	}
	var disk struct{ Doubt int64 }
	raw, _ := os.ReadFile(clockFile)
	if json.Unmarshal(raw, &disk); time.Since(time.UnixMilli(disk.Doubt)) > time.Minute {
		t.Errorf("the doubt did not start over: %s", raw)
	}

	// Doubted 25 h ago, last looked at an hour ago, a restart since: believed.
	restart(map[string]int64{"ran": at(96 * time.Hour), "doubt": at(25 * time.Hour), "seen": at(time.Hour)})
	h.expireAll(time.Now())
	if n := left(); n != 1 {
		t.Errorf("a day of steady clock across a restart: %d left, want 1", n)
	}
}

// TestDS_J4_LeftoverLinkSwept: a link made for media/ and never put in place
// (the server stopped between the two) is swept when the chat is read again.
func TestDS_J4_LeftoverLinkSwept(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	photo := f.upload(t, "photo", "IMG_1.jpg", keepJPEG)
	media := filepath.Join(f.srv.cfg.HomesDir, "ana", "data", "chat", "conv", conv, "media")
	left := filepath.Join(media, ".ln-0123456789")
	os.WriteFile(left, keepJPEG, 0o644)
	f.srv.chat.DropUser("ana") // a restart
	f.call(t, f.owner, "GET", "/api/chat/conv/"+conv+"/messages", "", 200, nil)
	if _, err := os.Lstat(left); err == nil {
		t.Error("the leftover link is still there")
	}
	if code, _ := f.dsMedia(t, conv, photo.ID); code != 200 {
		t.Errorf("the photo itself = %d", code)
	}
}
