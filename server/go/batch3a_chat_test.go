package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// TestChatForwardCountsBytes: a person's forward copies the file, so it counts
// against their daily upload allowance and the owner's quota, as an upload does.
func TestChatForwardCountsBytes(t *testing.T) {
	f := newChatFixture(t)
	guest := anonymous()
	conv := "d-" + f.ids["Carmen"]
	body := bytes.Repeat([]byte("x"), 4096)
	resp := do(t, guest, "POST", fmt.Sprintf("%s/api/c/%s/conv/%s/upload?kind=file&name=a.bin",
		f.base, f.carmen, conv), bytes.NewReader(body), nil)
	raw := readBody(t, resp)
	if resp.StatusCode != 201 {
		t.Fatalf("upload = %d: %s", resp.StatusCode, raw)
	}
	var file chatMsgOut
	json.Unmarshal(raw, &file)
	path := "/api/c/" + f.carmen + "/conv/" + conv + "/messages"
	fwd := fmt.Sprintf(`{"fwdConv":"%s","fwdId":%d}`, conv, file.ID)

	f.call(t, guest, "POST", path, fwd, 201, nil) // room left: it goes

	// Today's allowance almost used up: the file no longer fits.
	h := f.srv.chat
	h.mu.Lock()
	h.owner("ana").day[f.ids["Carmen"]] = chatDayUse{
		day: time.Now().Format("2006-01-02"), bytes: chatGuestDayByte - 1000}
	h.mu.Unlock()
	f.call(t, guest, "POST", path, fwd, 429, nil)

	// A fresh day, but the owner's quota is full.
	h.mu.Lock()
	delete(h.owner("ana").day, f.ids["Carmen"])
	h.mu.Unlock()
	setUserQuota(t, f.srv, "ana", "abc", 0.000001) // about 1 KB
	f.call(t, guest, "POST", path, fwd, 507, nil)
}
