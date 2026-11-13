package main

// =============================================================================
// chat_search.go - the launcher's search through the owner's own chats.
// =============================================================================
//
// Read only: it never writes a conversation. It sees what the owner's Chat
// shows them - never a message deleted for everyone, nor one of a chat they
// deleted for themselves (up to its Cleared mark), nor a deleted person's or
// group's chat. The chats of OTHER homes the owner takes part in ("via") are
// not searched yet.

import (
	"sort"
	"strings"
)

// ChatHit is one message found.
type ChatHit struct {
	Conv string `json:"conv"` // "d-<id>" | "g-<id>": chat/index.html?c=<conv>
	Name string `json:"name"` // the chat as the owner sees it named
	ID   int64  `json:"id"`
	At   int64  `json:"at"` // unix ms
	From string `json:"from"`
	Text string `json:"text"`
}

// chatMsgText is what a message says, for the search: its text, a file's
// name, a card's name, a place, a poll's question and options. A translated
// text, the translation only (chatOrig).
func chatMsgText(m *ChatMsg) string {
	parts := []string{translationOnly(m.Text)}
	if m.File != nil {
		parts = append(parts, m.File.Name)
	}
	if m.Card != nil {
		parts = append(parts, m.Card.Name)
		parts = append(parts, m.Card.Emails...)
		parts = append(parts, m.Card.Tels...)
	}
	if m.Loc != nil {
		parts = append(parts, m.Loc.Place)
	}
	if m.Poll != nil {
		parts = append(parts, m.Poll.Q)
		parts = append(parts, m.Poll.Opts...)
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// Search is `user`'s own messages that `keep` takes (text, sender's name, unix
// ms), newest first, at most `limit`; more is true when there were others.
// `snip` cuts a found text down to what the row shows.
func (h *ChatHub) Search(user string, keep func(text, from string, at int64) bool, snip func(string) string, limit int) (hits []ChatHit, more bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	hits = []ChatHit{}
	o := h.owner(user)
	if o == nil {
		return hits, false
	}
	meName := o.data.Me.Name
	sender := func(pid string) string {
		if pid == "o" {
			return meName
		}
		if c := o.contact(pid); c != nil {
			return c.Name
		}
		return ""
	}
	for _, id := range o.visible("o") {
		c := h.conv(o, id)
		floor := c.floor("o")
		name := o.convName(id, "o")
		for i := len(c.msgs) - 1; i >= 0; i-- {
			m := c.msgs[i]
			if m.ID <= floor {
				break // msgs are by id: nothing older is the owner's to see
			}
			if m.Deleted {
				continue
			}
			text := chatMsgText(m)
			if text == "" {
				continue
			}
			from := sender(m.From)
			if keep(text, from, m.At) {
				hits = append(hits, ChatHit{Conv: id, Name: name, ID: m.ID, At: m.At, From: from, Text: snip(text)})
			}
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].At > hits[j].At })
	if len(hits) > limit {
		return hits[:limit], true
	}
	return hits, false
}
