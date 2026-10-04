package main

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hearUnlocked runs `then` (may be nil) when the chat hub says `ev`, and
// tells whether h.mu was free at that moment. It counts the times it ran.
func hearUnlocked(t *testing.T, f *chatFixture, ev string, then func()) (free *bool, runs *int) {
	t.Helper()
	free, runs = new(bool), new(int)
	h := f.srv.chat
	hook := func(who any, e string, n int) {
		if who != h || e != ev {
			return
		}
		*runs++
		if h.mu.TryLock() {
			h.mu.Unlock()
			*free = true
		}
		if then != nil {
			then()
		}
	}
	testHook.Store(&hook)
	t.Cleanup(func() { testHook.Store(nil) })
	return free, runs
}

// fwTemps are the forward temps left under ana's chat folder.
func fwTemps(f *chatFixture) []string {
	var out []string
	filepath.WalkDir(f.srv.chat.chatDir("ana"), func(path string, d fs.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(d.Name(), ".fw-") {
			out = append(out, path)
		}
		return nil
	})
	return out
}

// TestBug_OL1_ForwardCopiesOutsideLock: forwarding a file counts the quota
// and copies the bytes with the hub's lock free - every other chat goes on.
func TestBug_OL1_ForwardCopiesOutsideLock(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	doc := []byte("un fichero de Carmen")
	orig := f.upload(t, "file", "notas.txt", doc)
	free, runs := hearUnlocked(t, f, "fwd-copy", nil)

	var fw chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/d-"+f.ids["Javi"]+"/messages",
		fmt.Sprintf(`{"fwdConv":"%s","fwdId":%d}`, conv, orig.ID), 201, &fw)
	if *runs != 1 || !*free {
		t.Fatalf("the copy ran %d times, with the lock free: %v", *runs, *free)
	}
	resp := do(t, anonymous(), "GET", fmt.Sprintf("%s/api/c/%s/conv/d-%s/media/%d", f.base, f.javi, f.ids["Javi"], fw.ID), nil, nil)
	if body := readBody(t, resp); resp.StatusCode != 200 || !bytes.Equal(body, doc) || fw.File == nil || fw.File.Size != int64(len(doc)) {
		t.Fatalf("the forwarded file = %d %q, %+v", resp.StatusCode, body, fw.File)
	}
	if left := fwTemps(f); len(left) != 0 {
		t.Fatalf("temps left: %v", left)
	}
}

// TestBug_OL1_ForwardRecheckedUnderLock: the message forwarded is deleted
// while its file is copied (no lock held): the forward is refused under the
// lock, nothing is sent and no copy is left behind.
func TestBug_OL1_ForwardRecheckedUnderLock(t *testing.T) {
	f := newChatFixture(t)
	conv := "d-" + f.ids["Carmen"]
	orig := f.upload(t, "file", "notas.txt", []byte("se va"))
	_, runs := hearUnlocked(t, f, "fwd-copy", func() {
		if code, body := callJSON(t, anonymous(), "DELETE", fmt.Sprintf("%s/api/c/%s/conv/%s/messages/%d", f.base, f.carmen, conv, orig.ID), ""); code != 200 {
			t.Errorf("delete during the copy = %d %s", code, body)
		}
	})
	f.call(t, f.owner, "POST", "/api/chat/conv/d-"+f.ids["Javi"]+"/messages",
		fmt.Sprintf(`{"fwdConv":"%s","fwdId":%d}`, conv, orig.ID), 404, nil)
	if *runs != 1 {
		t.Fatalf("the copy ran %d times", *runs)
	}
	var list msgList
	f.call(t, f.owner, "GET", "/api/chat/conv/d-"+f.ids["Javi"]+"/messages", "", 200, &list)
	if len(list.Msgs) != 0 {
		t.Fatalf("a forward of a deleted message was sent: %+v", list.Msgs)
	}
	if left := fwTemps(f); len(left) != 0 {
		t.Fatalf("temps left: %v", left)
	}
	media, _ := os.ReadDir(filepath.Join(f.srv.chat.chatDir("ana"), "conv", "d-"+f.ids["Javi"], "media"))
	if len(media) != 0 {
		t.Fatalf("files left in the chat it was going to: %d", len(media))
	}
}

// movedKeptPhoto: a photo kept by an older server (no copy under media/, only
// the link to the owner's file), then moved in the owner's files - opening it
// needs a walk of the home. Answers the conversation and the message id.
func movedKeptPhoto(t *testing.T, f *chatFixture) (string, int64) {
	t.Helper()
	conv := "d-" + f.ids["Carmen"]
	home := filepath.Join(f.srv.cfg.HomesDir, "ana")
	os.MkdirAll(filepath.Join(home, "files", "Fotos", "Viaje"), 0o755)
	p := filepath.Join(home, "files", "Fotos", "IMG_0002.jpg")
	os.WriteFile(p, keepJPEG, 0o644)
	var m chatMsgOut
	f.call(t, f.owner, "POST", "/api/chat/conv/"+conv+"/messages", `{"ref":"files/Fotos/IMG_0002.jpg"}`, 201, &m)
	os.Remove(filepath.Join(home, "data", "chat", "conv", conv, "media", fmt.Sprintf("%d.jpg", m.ID)))
	os.Rename(p, filepath.Join(home, "files", "Fotos", "Viaje", "playa.jpg"))
	return conv, m.ID
}

// TestBug_OL2_KeptWalkOutsideLock: the walk that finds a moved kept photo
// runs with the hub's lock free, and the photo is still shown.
func TestBug_OL2_KeptWalkOutsideLock(t *testing.T) {
	f := newChatFixture(t)
	conv, id := movedKeptPhoto(t, f)
	free, runs := hearUnlocked(t, f, "kept-walk", nil)
	if code, body := f.dsMedia(t, conv, id); code != 200 || !bytes.Equal(body, keepJPEG) {
		t.Fatalf("the moved photo = %d", code)
	}
	if *runs != 1 || !*free {
		t.Fatalf("the walk ran %d times, with the lock free: %v", *runs, *free)
	}
	// Found: the next look needs no walk.
	if code, _ := f.dsMedia(t, conv, id); code != 200 || *runs != 1 {
		t.Fatalf("second look = %d, walks %d", code, *runs)
	}
}

// TestBug_OL2_KeptWalkRecheckedUnderLock: the message is deleted during the
// walk (no lock held): what runs after it, under the lock, sees that.
func TestBug_OL2_KeptWalkRecheckedUnderLock(t *testing.T) {
	f := newChatFixture(t)
	conv, id := movedKeptPhoto(t, f)
	_, runs := hearUnlocked(t, f, "kept-walk", func() {
		if code, body := callJSON(t, f.owner, "DELETE", fmt.Sprintf("%s/api/chat/conv/%s/messages/%d", f.base, conv, id), ""); code != 200 {
			t.Errorf("delete during the walk = %d %s", code, body)
		}
	})
	if code, _ := f.dsMedia(t, conv, id); code != 404 {
		t.Fatalf("a photo deleted during the walk = %d, want 404", code)
	}
	if *runs != 1 {
		t.Fatalf("the walk ran %d times", *runs)
	}
	if _, err := os.Stat(filepath.Join(f.srv.cfg.HomesDir, "ana", "files", "Fotos", "Viaje", "playa.jpg")); err != nil {
		t.Fatalf("the owner's photo went with the message: %v", err)
	}
}
