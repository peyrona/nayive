package main

// =============================================================================
// Sending one Web Push message, and the words it is written in.
// =============================================================================
//
// Two senders share this: the reminder loop (calendar events, trips) and the
// video converter ("tu película está lista"). The rules below used to live
// inside reminders.go; they must stay in ONE place, not be copied:
//
//   - 404 / 410: the device is gone for good -> drop it from push.json.
//   - 401 / 403: OUR VAPID key is wrong, not the device -> log loudly and
//     NEVER prune (that would wipe every device on the server in one go).
//   - anything else: transient, the device is kept.
//
// java: no locks here. deliverPush only touches Users (which locks itself) and
// the VapidStore; a phrasebook belongs to ONE goroutine, so each sender keeps
// its own.

import (
	"os"
	"path/filepath"
	"time"
)

// deliverPush sends one message to one device and prunes the device when the
// push service says it is gone. It returns the push service's status, so the
// caller can decide what a transient failure means to it.
func deliverPush(push *VapidStore, users *Users, log Logger, user string, sub PushSub,
	payload any, ttl int) (int, error) {

	status, err := push.SendJSON(sub, payload, ttl)
	switch {
	case status == 404 || status == 410:
		// Permanent: the push service says this subscription is gone.
		users.RemovePushSub(user, sub.Endpoint)
		log.Info("push: dropped a dead device", "user", user, "status", status)
	case status == 401 || status == 403:
		// OUR credentials are wrong, not the device's. Never prune here.
		log.Error("push REJECTED our VAPID key - check config/vapid.json; "+
			"no devices were removed", "status", status)
	}
	return status, err
}

// pushTransient is a failure that keeps the device: not a success, not "gone",
// not "our key is wrong".
func pushTransient(status int) bool {
	switch {
	case status >= 200 && status < 300:
		return false
	case status == 404 || status == 410 || status == 401 || status == 403:
		return false
	}
	return true
}

// -----------------------------------------------------------------------------
// the words: the UI's own dictionaries, apps/shared/i18n/<lang>.json
// -----------------------------------------------------------------------------

type cachedStrings struct {
	mtime time.Time
	words map[string]string
}

// phrasebook reads a language file once and again only when it changes.
type phrasebook struct {
	appsDir string
	cache   map[string]cachedStrings // lang -> the UI's own dictionary
}

func newPhrasebook(appsDir string) *phrasebook {
	return &phrasebook{appsDir: appsDir, cache: make(map[string]cachedStrings)}
}

func (p *phrasebook) words(lang string) map[string]string {
	path := filepath.Join(p.appsDir, "shared", "i18n", lang+".json")
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	if hit, found := p.cache[lang]; found && hit.mtime.Equal(info.ModTime()) {
		return hit.words
	}
	words := make(map[string]string)
	loadJSONFile(path, &words)
	p.cache[lang] = cachedStrings{mtime: info.ModTime(), words: words}
	return words
}

// phrase falls back lang -> es -> a built-in string, so a missing or
// half-written dictionary can never stop a notification going out.
func (p *phrasebook) phrase(lang, key, builtin string) string {
	if words := p.words(lang); words[key] != "" {
		return words[key]
	}
	if words := p.words("es"); words[key] != "" {
		return words[key]
	}
	return builtin
}
