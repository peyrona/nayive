package main

// =============================================================================
// eMail: "new mail" on the user's devices (Web Push, like Chat's).
// =============================================================================
//
// The unread poll (mail.go) calls pushNew when an account's Inbox holds more
// unread mail than the last time it looked. One new message: its sender is the
// title and its subject the text; more: "3 new emails" and the newest one's
// sender and subject. The tag is the account's, so a newer notice replaces
// the older one instead of stacking; a tap opens that account's Inbox. The
// words come from the UI's own dictionary, in each device's language.

import (
	"context"
	"strconv"
	"strings"
)

const mailPushTTL = 24 * 60 * 60 // seconds: news a day old is no news

func (h *MailHub) phrase(lang, key, builtin string) string {
	h.wordsMu.Lock()
	defer h.wordsMu.Unlock()
	return h.words.phrase(lang, key, builtin)
}

func (h *MailHub) pushNew(ctx context.Context, user string, a *mailAcct, added int) {
	if h.push == nil || h.users == nil {
		return
	}
	subs := h.users.UserPush(user).Subs
	if len(subs) == 0 {
		return
	}
	m, ok, err := a.prov.LatestUnseen(ctx)
	if err != nil || !ok {
		return // read in the meantime, or no answer: nothing worth a buzz
	}
	sender := ""
	if len(m.From) > 0 {
		sender = firstNonEmpty(m.From[0].Name, m.From[0].Addr)
	}
	for _, sub := range subs {
		subject := firstNonEmpty(clip(m.Subject, 120), h.phrase(sub.Lang, "mail.noSubject", "(sin asunto)"))
		title, body := firstNonEmpty(sender, a.Email), subject
		if added > 1 {
			title = strings.ReplaceAll(h.phrase(sub.Lang, "mail.pushMany", "{n} correos nuevos"), "{n}", strconv.Itoa(added))
			body = firstNonEmpty(sender, a.Email) + ": " + subject
		}
		payload := map[string]any{
			"title": title,
			"body":  body,
			"url":   URLPrefix + "/email/?a=" + a.ID,
			"tag":   "mail-" + a.ID,
		}
		go deliverPush(h.push, h.users, h.log, user, sub, payload, mailPushTTL)
	}
}
