package main

// =============================================================================
// Chat: a JPEG the owner sends from their own files - linked, never copied.
// =============================================================================

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestChatLinkPhoto(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos", "Viaje"), 0o755)
	os.WriteFile(filepath.Join(home, "files", "Fotos", "IMG_7.jpeg"), keepJPEG, 0o644)
	os.WriteFile(filepath.Join(home, "files", "Fotos", "nota.txt"), []byte("hola"), 0o644)
	send := "/api/chat/conv/" + conv + "/messages"

	// Only the owner, only a JPEG of their files.
	f.call(t, anonymous(), "POST", "/api/c/"+f.carmen+"/conv/"+conv+"/messages",
		`{"ref":"files/Fotos/IMG_7.jpeg"}`, 403, nil)
	f.call(t, f.owner, "POST", send, `{"ref":"data/chat/chat.json"}`, 400, nil)
	f.call(t, f.owner, "POST", send, `{"ref":"files/Fotos/nota.txt"}`, 400, nil)
	f.call(t, f.owner, "POST", send, `{"ref":"files/Fotos/nope.jpg"}`, 404, nil)
	f.call(t, f.owner, "POST", send, `{"ref":"files/../data/x.jpg"}`, 404, nil)

	usage := f.srv.users.UserUsageBytes("ana")
	var m chatMsgOut
	f.call(t, f.owner, "POST", send, `{"ref":"files/Fotos/IMG_7.jpeg","text":"mira","w":40,"h":30}`, 201, &m)
	if m.Kind != "photo" || !m.Kept || m.Text != "mira" || m.File == nil || m.File.Name != "IMG_7.jpeg" ||
		m.File.W != 40 || m.File.Size != int64(len(keepJPEG)) {
		t.Fatalf("linked photo = %+v %+v", m, m.File)
	}
	if entries, _ := os.ReadDir(filepath.Join(home, "data", "chat", "conv", conv, "media")); len(entries) != 0 {
		t.Fatalf("a copy landed under media/: %d entries", len(entries))
	}
	if got := f.srv.users.UserUsageBytes("ana"); got != usage {
		t.Fatalf("usage moved %d -> %d: nothing was copied", usage, got)
	}

	media := fmt.Sprintf("%s/api/c/%s/conv/%s/media/%d", f.base, f.carmen, conv, m.ID)
	get := func(url string, want []byte) {
		t.Helper()
		resp := do(t, anonymous(), "GET", url, nil, nil)
		if body := readBody(t, resp); resp.StatusCode != 200 || !bytes.Equal(body, want) {
			t.Fatalf("GET %s = %d, %d bytes", url, resp.StatusCode, len(body))
		}
	}
	get(media, keepJPEG)
	get(media+"?thumb=1", keepJPEG) // no thumbnail yet: the photo itself

	// Photos' thumbnail, when there is one, goes to the bubble.
	info, _ := os.Stat(filepath.Join(home, "files", "Fotos", "IMG_7.jpeg"))
	thumb := []byte{0xFF, 0xD8, 0xFF, 0xD9}
	os.MkdirAll(filepath.Join(home, "data", "photos", "thumbs"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "photos", "thumbs", thumbName(info.Size(), info.ModTime().Unix())), thumb, 0o644)
	get(media+"?thumb=1", thumb)
	get(media, keepJPEG)

	// Renamed, then moved: still there, found by its inode.
	os.Rename(filepath.Join(home, "files", "Fotos", "IMG_7.jpeg"), filepath.Join(home, "files", "Fotos", "playa.jpeg"))
	get(media, keepJPEG)
	os.Rename(filepath.Join(home, "files", "Fotos", "playa.jpeg"), filepath.Join(home, "files", "Fotos", "Viaje", "playa.jpeg"))
	get(media, keepJPEG)
	f.srv.chat.mu.Lock()
	path := f.srv.chat.conv(f.srv.chat.owner("ana"), conv).st.Kept[m.ID]
	f.srv.chat.mu.Unlock()
	if path != "files/Fotos/Viaje/playa.jpeg" {
		t.Fatalf("the link was not updated: %q", path)
	}

	// Saved anew at the same path (an edit): followed by its path.
	edited := append([]byte{}, keepJPEG...)
	edited[6] = 0x33
	p := filepath.Join(home, "files", "Fotos", "Viaje", "playa.jpeg")
	os.WriteFile(p+".tmp", edited, 0o644)
	os.Rename(p+".tmp", p)
	get(media, edited)

	// Deleting the message never deletes the owner's photo.
	f.call(t, f.owner, "DELETE", fmt.Sprintf("/api/chat/conv/%s/messages/%d", conv, m.ID), "", 200, nil)
	if _, err := os.Stat(p); err != nil {
		t.Fatal("deleting the message deleted the owner's photo")
	}

	// Gone from the files: gone from the chat, no error page.
	f.call(t, f.owner, "POST", send, `{"ref":"files/Fotos/Viaje/playa.jpeg"}`, 201, &m)
	os.Remove(p)
	resp := do(t, anonymous(), "GET", fmt.Sprintf("%s/api/c/%s/conv/%s/media/%d", f.base, f.carmen, conv, m.ID), nil, nil)
	readBody(t, resp)
	if resp.StatusCode != 404 {
		t.Fatalf("a removed photo = %d", resp.StatusCode)
	}
}
