package main

// =============================================================================
// Whose save is this? - one browser, two accounts.
// =============================================================================
//
// shared/store.js queues a save in the browser while the server cannot be
// reached, and sends it later with whatever session cookie the browser holds
// THEN. If another account signed in on that browser meanwhile - a sign-out,
// an expired session, a second tab - the first person's file went into the
// second person's home.
//
// So the page learns who it belongs to when it loads - the readable cookie
// "nayive_who", set beside the session cookie - and every queued save carries
// that name in X-Nayive-User. A save whose name is not the session's is
// refused with 423: the browser keeps it, and it goes up once its owner signs
// in again. No header = a page from before this (or one that loaded signed
// out): taken as before.
//
// 423, not 401 (the "session expired" bar - wrong for the person signed in),
// not 403/409 (the store drops those), not 412 (a conflict: offers a copy),
// not 421 (Chrome re-sends a 421 on a new connection by itself).
//
// The cookie is NOT HttpOnly on purpose: it holds only "role:name", which the
// page shows anyway. It never authenticates anything.

import (
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const (
	WhoCookieName = "nayive_who"
	whoHeader     = "X-Nayive-User"
)

// whoValue is the cookie's value and the header's: "role:name", escaped so a
// name with a space, a comma or an accent is still one cookie token. The role
// is in it because an admin and a user may share a name.
func whoValue(role, user string) string {
	return url.PathEscape(role + ":" + user)
}

// whoCookieHeader lives exactly as long as the session cookie beside it.
func whoCookieHeader(role, user string, ttl time.Duration, remember, secure bool) string {
	out := WhoCookieName + "=" + whoValue(role, user) + "; SameSite=Lax; Path=/"
	if remember {
		out += "; Max-Age=" + strconv.Itoa(int(ttl.Seconds()))
	}
	if secure {
		out += "; Secure"
	}
	return out
}

func clearWhoCookieHeader() string {
	return WhoCookieName + "=; SameSite=Lax; Path=/; Max-Age=0"
}

// saveOwnerOK refuses a save queued under another account. True = go on.
func saveOwnerOK(w http.ResponseWriter, r *http.Request, role, user string) bool {
	h := r.Header.Get(whoHeader)
	if h == "" || h == whoValue(role, user) {
		return true
	}
	sendError(w, r, http.StatusLocked, "this save belongs to another account")
	return false
}
