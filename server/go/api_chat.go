// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// /api/chat (the owner, signed in) and /api/c/<token> (a person, by link).
// =============================================================================
//
// Both speak the same language about conversations; only who is asking
// differs. The owner is participant "o", a person is their own id. Under
// either prefix:
//
//	GET    ""                               the chat list, the names, who is online, calls
//	GET    wait?v=N&dev=D&s=S               long-poll: returns when version != N
//	                                        (+ the calls, and the call signals for page D after S)
//	POST   conv/<c>/call                    {"video","dev"}: ring the other side (chat_call.go)
//	POST   call/<id>/answer | end | sig     answer it, end it, one signal to the other page
//	GET    conv/<c>/messages                last page | ?since=REV | ?before=ID | ?all=1
//	POST   conv/<c>/messages                send text | loc | card | poll | a forward |
//	                                        (the owner) a JPEG of their files, {"ref"}: no copy
//	PATCH  conv/<c>/messages/<id>           edit one's own text or caption
//	DELETE conv/<c>/messages/<id>           delete one's own, for everyone
//	POST   conv/<c>/messages/<id>/react     {"emoji"} ("" takes it back)
//	POST   conv/<c>/messages/<id>/vote      {"opt"}
//	POST   conv/<c>/upload?kind=photo|file  the raw bytes of one photo or file
//	GET    conv/<c>/media/<id>              that photo or file (a kept photo: the owner's file;
//	                                        ?thumb=1: Photos' thumbnail of it, when there is one)
//	POST   conv/<c>/read | typing | prefs   read cursor, "escribiendo...", pin/mute
//	POST   conv/<c>/clear                   delete the chat for me (WhatsApp's "Eliminar chat")
//	POST   conv/<c>/later                   {"text","at","replyTo","cid"}: send that text at `at`
//	                                        (unix ms); the summary lists my own ("later")
//	DELETE conv/<c>/later/<id>              drop one of mine
//	POST   conv/<c>/later/<id>/send         send one of mine now
//
// The owner only (/api/chat):
//
//	GET    unread                           {"n"}: the launcher's badge
//	PUT    me                               {"name","motto"}: the name people see,
//	                                        and the owner's own line under "Chat"
//	POST   contacts                         {"name"} -> a person and their link
//	PATCH  contacts/<id>                    {"name"}
//	POST   contacts/<id>/link               a new link; the old one stops working
//	DELETE contacts/<id>
//	POST   groups                           {"name","members"}
//	PATCH  groups/<id>                      {"name"?,"members"?}
//	DELETE groups/<id>
//	PUT    contacts/<id>/photo | groups/<id>/photo   the raw JPEG of their picture
//	DELETE contacts/<id>/photo | groups/<id>/photo
//	PUT    me/photo | DELETE me/photo       the owner's own picture (avatar "o")
//	PUT    users/<account>/photo | DELETE   the owner's picture for another Nayive account
//	                                        (avatar "u-<account>", the owner's eyes only)
//	PUT    cards/photo?uid=<UID>            the raw JPEG/PNG: that card's PHOTO in the
//	                                        Contacts app's data/contacts.vcf
//	PUT    autodelete                       {"days"}: delete messages older than that (0 = never)
//	GET    autodelete?days=N                {"n"}: how many messages that would delete now
//	POST   conv/<c>/messages/<id>/keep      {"dir"}: that photo, also in the owner's
//	                                        files/<dir> (a hard link) -> {"path"}
//	POST   conv/<c>/messages/<id>/edited    {"ref","w","h"}: the message shows that NEW
//	                                        file of the owner's (their edit of the photo,
//	                                        saved beside it) -> {"path"}; the old stays
//
// A person only (/api/c/<token>): GET|POST|DELETE push - their devices.
// Both: GET avatar/<id>?v=N - a picture the asker may see (avatarsFor).
//
// ANOTHER NAYIVE USER, signed in, reads a chat that lives in someone else's
// home through a third door: /api/chat/via/<that home>/... - the same routes
// as a person's (they ARE that home's contact, ChatContact.User), found by
// their session instead of a token. Not push: their devices are their
// account's. The owner's summary lists these homes ("via") and the other
// accounts ("users"); POST contacts {"user"} starts a chat with one.
//
// And the pages behind a link, no session: /c/<token>/ (apps/chat/guest.html),
// /c/<token>/manifest.webmanifest (named after the owner, so the phone's icon
// says who it is) and /c/<token>/sw.js (apps/chat/guest-sw.js: notifications).
// The token sits INSIDE the service worker's scope on purpose: a subscription
// that changes while no page is open can still tell which link it belongs to.

import (
	"encoding/json"
	"errors"
	"html"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const guestPagePath = "chat/guest.html"
const guestWorkerPath = "chat/guest-sw.js"

// chatActor is who is asking: always resolved again under h.mu.
type chatActor struct {
	o     *chatOwner
	pid   string
	c     *ChatContact // a person; nil for the owner
	token string
	via   bool // a Nayive user reading this home's chat from their own Chat
}

func (a chatActor) guest() bool { return a.c != nil }

// -----------------------------------------------------------------------------
// the two front doors
// -----------------------------------------------------------------------------

func (s *Server) apiChatOwner(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if sess.Role == "admin" {
		sendError(w, r, http.StatusForbidden, "el chat es por usuario; entra como usuario")
		return
	}
	user := sess.User
	s.chatRoute(w, r, func() (chatActor, bool) {
		o := s.chat.owner(user)
		if o == nil {
			return chatActor{}, false
		}
		return chatActor{o: o, pid: "o"}, true
	})
}

// apiChatVia is a signed-in user reading the chat that lives in ANOTHER
// user's home (the "owner" in the path), where they are a contact by account.
func (s *Server) apiChatVia(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if sess.Role == "admin" {
		sendError(w, r, http.StatusForbidden, "el chat es por usuario; entra como usuario")
		return
	}
	user, home := sess.User, r.PathValue("owner")
	if rest := splitPath(r.PathValue("rest")); len(rest) > 0 && rest[0] == "push" {
		sendError(w, r, http.StatusNotFound, "no such endpoint") // their devices are their account's
		return
	}
	s.chatRoute(w, r, func() (chatActor, bool) {
		if home == user {
			return chatActor{}, false
		}
		o := s.chat.owner(home)
		if o == nil {
			return chatActor{}, false
		}
		c := o.userContact(user)
		if c == nil {
			return chatActor{}, false
		}
		return chatActor{o: o, pid: c.ID, c: c, via: true}, true
	})
}

func (s *Server) apiChatGuest(w http.ResponseWriter, r *http.Request) {
	publicHeaders(w)
	token := r.PathValue("token")
	s.chatRoute(w, r, func() (chatActor, bool) {
		o, c := s.chat.byToken(token)
		if o == nil {
			return chatActor{}, false
		}
		return chatActor{o: o, pid: c.ID, c: c, token: token}, true
	})
}

// chatRoute picks the handler for the rest of the path. `who` is called with
// h.mu held, by every handler, so a person deleted a moment ago is refused.
func (s *Server) chatRoute(w http.ResponseWriter, r *http.Request, who func() (chatActor, bool)) {
	rest := splitPath(r.PathValue("rest"))
	h := s.chat

	// resolve runs `fn` under the lock with the actor, or answers 404.
	resolve := func(fn func(a chatActor)) {
		h.mu.Lock()
		defer h.mu.Unlock()
		a, ok := who()
		if !ok {
			sendError(w, r, http.StatusNotFound, "este enlace ya no está disponible")
			return
		}
		// chat.json failed to load: reading what loaded is fine, a change is
		// refused - it would be saved over every person, link and group (F5).
		if a.o.damaged && r.Method != http.MethodGet && r.Method != http.MethodHead {
			sendError(w, r, http.StatusInternalServerError, chatDamagedText)
			return
		}
		fn(a)
	}
	method := func(allowed ...string) bool {
		if contains(allowed, r.Method) || (r.Method == http.MethodHead && contains(allowed, http.MethodGet)) {
			return true
		}
		sendError(w, r, http.StatusMethodNotAllowed, "método no permitido")
		return false
	}
	ownerOnly := func(a chatActor) bool {
		if a.guest() {
			sendError(w, r, http.StatusForbidden, "no permitido")
			return false
		}
		return true
	}

	switch {
	case len(rest) == 0:
		if method(http.MethodGet) {
			resolve(func(a chatActor) { s.chatSummary(w, r, a) })
		}

	case len(rest) == 1 && rest[0] == "wait":
		if method(http.MethodGet) {
			s.chatWait(w, r, who)
		}

	case len(rest) == 1 && rest[0] == "unread":
		if method(http.MethodGet) {
			resolve(func(a chatActor) {
				if ownerOnly(a) {
					sendJSON(w, r, http.StatusOK, map[string]int{"n": s.chatUnread(a)})
				}
			})
		}

	case len(rest) == 1 && rest[0] == "me":
		if !method(http.MethodPut) {
			return
		}
		var body struct {
			Name string `json:"name"`
			// A pointer: left out, the motto stays as it is; "" clears it.
			Motto *string `json:"motto"`
		}
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		resolve(func(a chatActor) {
			if !ownerOnly(a) {
				return
			}
			name := cleanChatName(body.Name)
			if name == "" {
				sendError(w, r, http.StatusBadRequest, "falta el nombre")
				return
			}
			a.o.data.Me.Name = name
			if body.Motto != nil {
				a.o.data.Me.Motto = cleanChatMotto(*body.Motto)
			}
			s.chat.saveData(a.o)
			a.o.changed(true)
			sendJSON(w, r, http.StatusOK, map[string]string{"name": name, "motto": a.o.data.Me.Motto})
		})

	case len(rest) == 1 && rest[0] == "autodelete":
		if !method(http.MethodGet, http.MethodPut) {
			return
		}
		if r.Method != http.MethodPut {
			// What N days would delete NOW, shown before it is set (J7): a
			// typo - 1 for 10 - reads "deletes 12 345 messages".
			days, err := strconv.Atoi(queryValue(r, "days"))
			if err != nil || days < 0 || days > chatMaxDeleteAfter {
				sendError(w, r, http.StatusBadRequest, "días no válidos")
				return
			}
			resolve(func(a chatActor) {
				if ownerOnly(a) {
					sendJSON(w, r, http.StatusOK, map[string]int{"n": h.countExpiring(a.o, days, time.Now())})
				}
			})
			return
		}
		var body struct {
			Days int `json:"days"`
		}
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		if body.Days < 0 || body.Days > chatMaxDeleteAfter {
			sendError(w, r, http.StatusBadRequest, "días no válidos")
			return
		}
		resolve(func(a chatActor) {
			if !ownerOnly(a) {
				return
			}
			was := a.o.data.DeleteAfter
			a.o.data.DeleteAfter = body.Days
			if err := h.saveData(a.o); err != nil {
				// Not saved: the old number stays, also for the hourly
				// auto-delete, which reads memory (SF2).
				a.o.data.DeleteAfter = was
				sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
				return
			}
			a.o.changed(true)
			h.expire(a.o, time.Now())
			sendJSON(w, r, http.StatusOK, map[string]int{"days": body.Days})
		})

	case len(rest) == 1 && rest[0] == "push":
		s.chatPush(w, r, resolve)

	case len(rest) == 2 && rest[0] == "me" && rest[1] == "photo":
		s.chatPhoto(w, r, "me", "o", resolve, ownerOnly)

	case len(rest) == 3 && (rest[0] == "contacts" || rest[0] == "groups" || rest[0] == "users") && rest[2] == "photo":
		s.chatPhoto(w, r, rest[0], rest[1], resolve, ownerOnly)

	case len(rest) == 2 && rest[0] == "cards" && rest[1] == "photo":
		if method(http.MethodPut) {
			s.chatCardPhoto(w, r, resolve, ownerOnly)
		}

	case len(rest) == 2 && rest[0] == "avatar":
		if method(http.MethodGet) {
			s.chatAvatar(w, r, rest[1], resolve)
		}

	case rest[0] == "contacts" && len(rest) <= 3:
		s.chatContacts(w, r, rest[1:], resolve, ownerOnly)

	case rest[0] == "groups" && len(rest) <= 2:
		s.chatGroups(w, r, rest[1:], resolve, ownerOnly)

	case len(rest) == 3 && rest[0] == "conv" && rest[2] == "call":
		if method(http.MethodPost) {
			s.chatCallStart(w, r, rest[1], resolve)
		}

	case len(rest) == 3 && rest[0] == "call":
		if method(http.MethodPost) {
			s.chatCallAct(w, r, rest[1], rest[2], resolve)
		}

	case rest[0] == "conv" && len(rest) >= 3:
		s.chatConvRoute(w, r, rest[1], rest[2:], resolve, method)

	default:
		sendError(w, r, http.StatusNotFound, "no such endpoint")
	}
}

// -----------------------------------------------------------------------------
// the list
// -----------------------------------------------------------------------------

type chatConvOut struct {
	ID      string       `json:"id"`
	Kind    string       `json:"kind"` // "d" | "g"
	Name    string       `json:"name"`
	With    string       `json:"with,omitempty"`    // d: the other participant
	Members []string     `json:"members,omitempty"` // g: everyone in it, the owner first
	Last    *chatMsgOut  `json:"last,omitempty"`
	Unread  int          `json:"unread"`
	Pin     bool         `json:"pin,omitempty"`
	Mute    bool         `json:"mute,omitempty"`
	Seen    bool         `json:"seen,omitempty"`   // my last message has been read by everybody
	Hidden  bool         `json:"hidden,omitempty"` // I deleted it and nothing came in since
	Later   []*ChatLater `json:"later,omitempty"`  // my texts scheduled here, soonest first
	Rev     int64        `json:"rev"`
	Created int64        `json:"created"`
}

type chatContactOut struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Token   string   `json:"token"`
	User    string   `json:"user,omitempty"` // a Nayive account (no link)
	Card    string   `json:"card,omitempty"` // the Contacts app's card (UID) they came from
	Created int64    `json:"created"`
	Opened  int64    `json:"opened,omitempty"`
	Push    bool     `json:"push"`
	Groups  []string `json:"groups"`
}

func (s *Server) chatSummary(w http.ResponseWriter, r *http.Request, a chatActor) {
	h, o := s.chat, a.o
	if a.guest() && !a.via && a.c.Opened == 0 {
		a.c.Opened = time.Now().Unix()
		h.saveData(o)
		o.changed(true)
	}

	people := map[string]string{"o": o.data.Me.Name}
	convs := []chatConvOut{}
	for _, id := range o.visible(a.pid) {
		c := h.conv(o, id)
		out := chatConvOut{
			ID: id, Kind: id[:1], Name: o.convName(id, a.pid), Rev: c.st.Rev,
			Unread: c.unread(a.pid), Pin: c.st.Pin[a.pid], Mute: c.st.Mute[a.pid],
			Hidden: c.hiddenFor(a.pid), Later: o.laterOf(id, a.pid),
		}
		if strings.HasPrefix(id, "d-") {
			out.With = "o"
			if !a.guest() {
				out.With = id[2:]
			}
			if ct := o.contact(id[2:]); ct != nil {
				out.Created = ct.Created
			}
		} else if g := o.group(id[2:]); g != nil {
			out.Members = o.members(id)
			out.Created = g.Created
		}
		if m := c.lastFor(a.pid); m != nil {
			lm := c.out(m)
			out.Last = &lm
			if m.From == a.pid {
				out.Seen = true
				for _, p := range o.members(id) {
					if p != a.pid && c.st.Read[p] < m.ID {
						out.Seen = false
					}
				}
			}
		}
		for _, p := range o.members(id) {
			people[p] = h.nameOf(o, p)
		}
		// A sender who has since left the group, or been deleted, still has a name.
		if a.guest() && out.Kind == "g" {
			for _, m := range c.msgs {
				if _, seen := people[m.From]; !seen {
					people[m.From] = h.nameOf(o, m.From)
				}
			}
		}
		convs = append(convs, out)
	}

	res := map[string]any{
		"me":      a.pid,
		"owner":   o.data.Me.Name,
		"v":       o.version,
		"meta":    o.meta,
		"people":  people,
		"convs":   convs,
		"online":  o.onlineFor(a.pid),
		"typing":  o.typingFor(a.pid),
		"avatars": o.avatarsFor(a.pid),
		"callsOn": h.callsOn(),
		"calls":   o.cs().callsFor(a.pid, ""),
		// Everybody sees the owner's auto-delete: a person is told, by a small
		// clock with the days, that their messages go too.
		"deleteAfter": o.data.DeleteAfter,
	}
	if a.guest() {
		res["name"] = a.c.Name
		if key, err := h.push.PublicKey(); err == nil {
			res["vapid"] = key
		}
	} else {
		contacts := []chatContactOut{}
		for _, c := range o.data.Contacts {
			people[c.ID] = c.Name // every person, the deleted too: old messages keep a name
			if c.Deleted {
				continue
			}
			contacts = append(contacts, h.contactOut(o, c))
		}
		res["contacts"] = contacts
		res["devices"] = len(h.users.UserPush(o.user).Subs)
		res["motto"] = o.data.Me.Motto // their own page shows it under "Chat"
		// The homes whose chats this user reads through /api/chat/via/<home>,
		// and every other account, for "Nuevo chat".
		via := []string{}
		for _, ref := range h.viaOf(o.user) {
			via = append(via, ref.owner)
		}
		res["via"] = via
		users := []map[string]string{}
		for _, u := range h.users.ListUserNames() {
			if u == o.user {
				continue
			}
			name := titleCase(u)
			if other := h.owner(u); other != nil {
				name = other.data.Me.Name
			}
			users = append(users, map[string]string{"user": u, "name": name})
		}
		res["users"] = users
	}
	sendJSON(w, r, http.StatusOK, res)
}

// chatUnread is the owner's unread messages in every conversation not muted -
// their own, and the ones in other users' homes they take part in (via).
func (s *Server) chatUnread(a chatActor) int {
	n := s.chat.unreadIn(a.o, a.pid)
	if !a.guest() {
		for _, ref := range s.chat.viaOf(a.o.user) {
			if o := s.chat.owner(ref.owner); o != nil {
				n += s.chat.unreadIn(o, ref.contact)
			}
		}
	}
	return n
}

func (h *ChatHub) unreadIn(o *chatOwner, pid string) int {
	n := 0
	for _, id := range o.visible(pid) {
		c := h.conv(o, id)
		if !c.st.Mute[pid] {
			n += c.unread(pid)
		}
	}
	return n
}

// chatWait is the long-poll. It does not hold the lock while it waits.
func (s *Server) chatWait(w http.ResponseWriter, r *http.Request, who func() (chatActor, bool)) {
	// At most waitCapMax at once per link or session (waitcap.go).
	key := chatWaitKey(r)
	if !takeWait(w, r, key) {
		return
	}
	defer waits.release(key)
	h := s.chat
	v, _ := strconv.ParseInt(queryValue(r, "v"), 10, 64)
	// The page's device id and the last call signal it read (chat_call.go).
	dev := queryValue(r, "dev")
	if !validDev(dev) {
		dev = ""
	}
	sigSeen, _ := strconv.ParseInt(queryValue(r, "s"), 10, 64)

	h.mu.Lock()
	a, ok := who()
	if !ok {
		h.mu.Unlock()
		sendError(w, r, http.StatusNotFound, "este enlace ya no está disponible")
		return
	}
	if dev != "" {
		cs := a.o.cs()
		cs.touch(dev, time.Now())
		cs.ack(dev, sigSeen)
	}
	// A signal this page has not read yet must not sit out a 25 s wait: a lost
	// reply would otherwise stall a call's setup.
	if a.o.version == v && (dev == "" || !a.o.cs().pending(dev, sigSeen)) {
		o, pid := a.o, a.pid
		// Presence first, THEN the channel: coming online wakes everybody
		// else's wait, and must not wake this one.
		h.waitStart(o, pid)
		if dev != "" {
			o.cs().waitStart(dev)
		}
		wake := o.wake
		h.mu.Unlock()

		timer := time.NewTimer(chatWaitMax)
		select {
		case <-wake:
		case <-timer.C:
		case <-r.Context().Done():
		case <-h.closing:
		}
		timer.Stop()

		h.mu.Lock()
		h.waitEnd(o, pid)
		if dev != "" {
			o.cs().waitEnd(dev, time.Now())
		}
		if a, ok = who(); !ok {
			h.mu.Unlock()
			sendError(w, r, http.StatusNotFound, "este enlace ya no está disponible")
			return
		}
	}
	revs := map[string]int64{}
	for _, id := range a.o.visible(a.pid) {
		revs[id] = h.conv(a.o, id).st.Rev
	}
	res := map[string]any{
		"v":      a.o.version,
		"meta":   a.o.meta,
		"revs":   revs,
		"online": a.o.onlineFor(a.pid),
		"typing": a.o.typingFor(a.pid),
		"calls":  a.o.cs().callsFor(a.pid, dev),
	}
	if dev != "" {
		res["sig"] = a.o.cs().sigsFor(dev, sigSeen)
	}
	h.mu.Unlock()
	sendJSON(w, r, http.StatusOK, res)
}

// -----------------------------------------------------------------------------
// a person's devices
// -----------------------------------------------------------------------------

func (s *Server) chatPush(w http.ResponseWriter, r *http.Request, resolve func(func(chatActor))) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		endpoint := queryValue(r, "endpoint")
		resolve(func(a chatActor) {
			if !a.guest() {
				sendError(w, r, http.StatusForbidden, "no permitido")
				return
			}
			key, err := s.chat.push.PublicKey()
			if err != nil {
				sendError(w, r, http.StatusServiceUnavailable, err.Error())
				return
			}
			subscribed := false
			for _, sub := range a.c.Subs {
				if endpoint != "" && sub.Endpoint == endpoint {
					subscribed = true
				}
			}
			sendJSON(w, r, http.StatusOK, map[string]any{"vapid_public": key, "subscribed": subscribed})
		})

	case http.MethodPost:
		var body struct {
			Subscription struct {
				Endpoint string   `json:"endpoint"`
				Keys     PushKeys `json:"keys"`
			} `json:"subscription"`
			Lang string `json:"lang"`
		}
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		sub, ok := cleanSub(PushSub{Endpoint: body.Subscription.Endpoint, Keys: body.Subscription.Keys,
			Lang: body.Lang, Created: time.Now().Unix()})
		if !ok || !chatPushHostOK(sub.Endpoint) || ValidateKeys(sub.Keys.P256dh, sub.Keys.Auth) != nil {
			sendError(w, r, http.StatusBadRequest, "suscripción no válida")
			return
		}
		resolve(func(a chatActor) {
			if !a.guest() {
				sendError(w, r, http.StatusForbidden, "no permitido")
				return
			}
			removeSub(a.c, sub.Endpoint)
			a.c.Subs = append(a.c.Subs, sub)
			if len(a.c.Subs) > chatMaxSubs {
				a.c.Subs = a.c.Subs[len(a.c.Subs)-chatMaxSubs:]
			}
			s.chat.saveData(a.o)
			a.o.changed(true)
			sendJSON(w, r, http.StatusOK, map[string]bool{"subscribed": true})
		})

	case http.MethodDelete:
		endpoint := queryValue(r, "endpoint")
		resolve(func(a chatActor) {
			if !a.guest() {
				sendError(w, r, http.StatusForbidden, "no permitido")
				return
			}
			if removeSub(a.c, endpoint) {
				s.chat.saveData(a.o)
				a.o.changed(true)
			}
			sendJSON(w, r, http.StatusOK, map[string]bool{"subscribed": false})
		})

	default:
		sendError(w, r, http.StatusMethodNotAllowed, "método no permitido")
	}
}

// -----------------------------------------------------------------------------
// people and groups (the owner)
// -----------------------------------------------------------------------------

func (h *ChatHub) contactOut(o *chatOwner, c *ChatContact) chatContactOut {
	out := chatContactOut{ID: c.ID, Name: c.Name, Token: c.Token, User: c.User, Card: c.Card, Created: c.Created,
		Opened: c.Opened, Push: len(c.Subs) > 0, Groups: []string{}}
	if c.User != "" {
		out.Push = len(h.users.UserPush(c.User).Subs) > 0
	}
	for _, g := range o.data.Groups {
		if !g.Deleted && contains(g.Members, c.ID) {
			out.Groups = append(out.Groups, g.ID)
		}
	}
	return out
}

func (s *Server) chatContacts(w http.ResponseWriter, r *http.Request, rest []string,
	resolve func(func(chatActor)), ownerOnly func(chatActor) bool) {

	h := s.chat
	var body struct {
		Name string `json:"name"`
		User string `json:"user"`
		Card string `json:"card"` // POST: the Contacts app's card they are picked from
	}
	if r.Method == http.MethodPost && len(rest) == 0 || r.Method == http.MethodPatch {
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
	}
	switch {
	case len(rest) == 0 && r.Method == http.MethodPost && body.User != "":
		s.chatAddUser(w, r, body.User, resolve, ownerOnly)

	case len(rest) == 0 && r.Method == http.MethodPost:
		name := cleanChatName(body.Name)
		if name == "" {
			sendError(w, r, http.StatusBadRequest, "falta el nombre")
			return
		}
		resolve(func(a chatActor) {
			if !ownerOnly(a) {
				return
			}
			h.ensureIndex()
			c := &ChatContact{ID: newChatID(), Name: name, Token: newToken(), Card: cleanCardUID(body.Card),
				Created: time.Now().Unix()}
			a.o.data.Contacts = append(a.o.data.Contacts, c)
			if err := h.saveData(a.o); err != nil {
				sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
				return
			}
			h.tokens[tokenKey(c.Token)] = chatTokenRef{owner: a.o.user, contact: c.ID}
			a.o.changed(true)
			sendJSON(w, r, http.StatusCreated, h.contactOut(a.o, c))
		})

	case len(rest) == 1 && (r.Method == http.MethodPatch || r.Method == http.MethodDelete):
		resolve(func(a chatActor) {
			if !ownerOnly(a) {
				return
			}
			c := a.o.contact(rest[0])
			if c == nil || c.Deleted {
				sendError(w, r, http.StatusNotFound, "no existe")
				return
			}
			if r.Method == http.MethodPatch {
				name := cleanChatName(body.Name)
				if name == "" {
					sendError(w, r, http.StatusBadRequest, "falta el nombre")
					return
				}
				c.Name = name
			} else {
				h.dropContact(a.o, c)
			}
			h.saveData(a.o)
			a.o.changed(true)
			sendJSON(w, r, http.StatusOK, h.contactOut(a.o, c))
		})

	case len(rest) == 2 && rest[1] == "link" && r.Method == http.MethodPost:
		resolve(func(a chatActor) {
			if !ownerOnly(a) {
				return
			}
			c := a.o.contact(rest[0])
			if c == nil || c.Deleted || c.User != "" { // a Nayive user has no link
				sendError(w, r, http.StatusNotFound, "no existe")
				return
			}
			h.ensureIndex()
			delete(h.tokens, tokenKey(c.Token))
			c.Token, c.Subs, c.Opened = newToken(), nil, 0
			h.tokens[tokenKey(c.Token)] = chatTokenRef{owner: a.o.user, contact: c.ID}
			h.saveData(a.o)
			a.o.changed(true)
			sendJSON(w, r, http.StatusOK, h.contactOut(a.o, c))
		})

	default:
		sendError(w, r, http.StatusMethodNotAllowed, "método no permitido")
	}
}

// chatAddUser starts a chat with another Nayive account - or finds the one the
// two already have, whichever side started it: one chat per pair. Answers
// {"conv", "via"} ("via" = the home it lives in when that is the other one's)
// and, when it is (now) in this home, "contact".
func (s *Server) chatAddUser(w http.ResponseWriter, r *http.Request, user string,
	resolve func(func(chatActor)), ownerOnly func(chatActor) bool) {

	h := s.chat
	if !ValidUsername(user) || !contains(h.users.ListUserNames(), user) {
		sendError(w, r, http.StatusNotFound, "no existe ese usuario")
		return
	}
	resolve(func(a chatActor) {
		if !ownerOnly(a) {
			return
		}
		if user == a.o.user {
			sendError(w, r, http.StatusBadRequest, "no puedes chatear contigo")
			return
		}
		if c := a.o.userContact(user); c != nil {
			sendJSON(w, r, http.StatusOK, map[string]any{"conv": "d-" + c.ID, "via": "", "contact": h.contactOut(a.o, c)})
			return
		}
		other := h.owner(user)
		if other == nil {
			sendError(w, r, http.StatusNotFound, "no existe ese usuario")
			return
		}
		if c := other.userContact(a.o.user); c != nil {
			sendJSON(w, r, http.StatusOK, map[string]any{"conv": "d-" + c.ID, "via": user})
			return
		}
		h.ensureIndex()
		c := &ChatContact{ID: newChatID(), Name: other.data.Me.Name, User: user, Created: time.Now().Unix()}
		a.o.data.Contacts = append(a.o.data.Contacts, c)
		if err := h.saveData(a.o); err != nil {
			a.o.data.Contacts = a.o.data.Contacts[:len(a.o.data.Contacts)-1]
			sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
		h.links[user] = append(h.links[user], chatTokenRef{owner: a.o.user, contact: c.ID})
		a.o.changed(true)
		other.changed(true) // their page starts reading this home at once
		sendJSON(w, r, http.StatusCreated, map[string]any{"conv": "d-" + c.ID, "via": "", "contact": h.contactOut(a.o, c)})
	})
}

func without(list []string, x string) []string {
	out := list[:0]
	for _, v := range list {
		if v != x {
			out = append(out, v)
		}
	}
	return out
}

func (s *Server) chatGroups(w http.ResponseWriter, r *http.Request, rest []string,
	resolve func(func(chatActor)), ownerOnly func(chatActor) bool) {

	h := s.chat
	var body struct {
		Name    *string   `json:"name"`
		Members *[]string `json:"members"`
	}
	if r.Method == http.MethodPost || r.Method == http.MethodPatch {
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
	}
	// members keeps the ids of live people, once each.
	members := func(o *chatOwner, ids []string) []string {
		out := []string{}
		for _, id := range ids {
			if c := o.contact(id); c != nil && !c.Deleted && !contains(out, id) {
				out = append(out, id)
			}
		}
		return out
	}
	type groupOut struct {
		ID      string   `json:"id"`
		Name    string   `json:"name"`
		Members []string `json:"members"`
		Created int64    `json:"created"`
	}

	switch {
	case len(rest) == 0 && r.Method == http.MethodPost:
		name := ""
		if body.Name != nil {
			name = cleanChatName(*body.Name)
		}
		if name == "" || body.Members == nil {
			sendError(w, r, http.StatusBadRequest, "faltan el nombre o las personas")
			return
		}
		resolve(func(a chatActor) {
			if !ownerOnly(a) {
				return
			}
			g := &ChatGroup{ID: newChatID(), Name: name, Members: members(a.o, *body.Members),
				Created: time.Now().Unix()}
			a.o.data.Groups = append(a.o.data.Groups, g)
			if err := h.saveData(a.o); err != nil {
				sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
				return
			}
			a.o.changed(true)
			sendJSON(w, r, http.StatusCreated, groupOut{g.ID, g.Name, g.Members, g.Created})
		})

	case len(rest) == 1 && (r.Method == http.MethodPatch || r.Method == http.MethodDelete):
		resolve(func(a chatActor) {
			if !ownerOnly(a) {
				return
			}
			g := a.o.group(rest[0])
			if g == nil || g.Deleted {
				sendError(w, r, http.StatusNotFound, "no existe")
				return
			}
			if r.Method == http.MethodDelete {
				g.Deleted = true
				if g.Photo > 0 {
					os.Remove(filepath.Join(a.o.dir, "avatars", g.ID+".jpg"))
					g.Photo = 0
				}
			} else {
				if body.Name != nil {
					name := cleanChatName(*body.Name)
					if name == "" {
						sendError(w, r, http.StatusBadRequest, "falta el nombre")
						return
					}
					g.Name = name
				}
				if body.Members != nil {
					next := members(a.o, *body.Members)
					// Who goes out may come back (an Undo, or later): their
					// history must still be there then - purge counts them (J6).
					for _, id := range g.Members {
						if !contains(next, id) && !contains(g.Left, id) {
							g.Left = append(g.Left, id)
						}
					}
					for _, id := range next {
						g.Left = without(g.Left, id)
					}
					if len(g.Left) == 0 {
						g.Left = nil
					}
					g.Members = next
				}
			}
			h.saveData(a.o)
			a.o.changed(true)
			sendJSON(w, r, http.StatusOK, groupOut{g.ID, g.Name, g.Members, g.Created})
		})

	default:
		sendError(w, r, http.StatusMethodNotAllowed, "método no permitido")
	}
}

// chatMaxPhoto caps a picture: a person's, a group's or the owner's (the page sends ~512 px).
const chatMaxPhoto = 2 << 20

// chatPhoto sets (PUT, the raw JPEG) or removes (DELETE) the picture of a
// person, a group or the owner ("me" -> id "o"):
// homes/<owner>/data/chat/avatars/<id>.jpg, its GPS blanked.
func (s *Server) chatPhoto(w http.ResponseWriter, r *http.Request, kind, id string,
	resolve func(func(chatActor)), ownerOnly func(chatActor) bool) {

	h := s.chat
	// A Nayive account's picture: the owner's own, avatars/u-<account>.jpg.
	file := id
	if kind == "users" {
		if !ValidUsername(id) || !contains(h.users.ListUserNames(), id) {
			sendError(w, r, http.StatusNotFound, "no existe ese usuario")
			return
		}
		file = faceKey(id)
	}
	var clean string
	if r.Method == http.MethodPut {
		if r.ContentLength <= 0 || r.ContentLength > chatMaxPhoto {
			sendError(w, r, http.StatusRequestEntityTooLarge, "foto no válida")
			return
		}
		var dir string
		resolve(func(a chatActor) {
			if ownerOnly(a) {
				dir = filepath.Join(a.o.dir, "avatars")
			}
		})
		if dir == "" {
			return
		}
		if err := mkdirInHome(s.cfg.HomesDir, dir); err != nil { // never the home itself (L2)
			sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
		tmp, err := os.CreateTemp(dir, ".up-*")
		if err != nil {
			sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
		defer os.Remove(tmp.Name())
		n, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, r.ContentLength))
		tmp.Close()
		if err != nil || n != r.ContentLength {
			sendError(w, r, http.StatusBadRequest, "el envío llegó cortado")
			return
		}
		if clean, err = cleanPhoto(tmp.Name(), dir, false); err != nil {
			sendError(w, r, http.StatusBadRequest, "no es una foto JPEG")
			return
		}
		defer os.Remove(clean)
	} else if r.Method != http.MethodDelete {
		sendError(w, r, http.StatusMethodNotAllowed, "método no permitido")
		return
	}

	resolve(func(a chatActor) {
		if !ownerOnly(a) {
			return
		}
		var photo *int64
		var face int64 // kind "users": the map's value, put back below
		switch kind {
		case "users":
			if id != a.o.user {
				face = a.o.data.Faces[id]
				photo = &face
			}
		case "me":
			photo = &a.o.data.Me.Photo
		case "contacts":
			if c := a.o.contact(id); c != nil && !c.Deleted {
				photo = &c.Photo
			}
		default:
			if g := a.o.group(id); g != nil && !g.Deleted {
				photo = &g.Photo
			}
		}
		if photo == nil {
			sendError(w, r, http.StatusNotFound, "no existe")
			return
		}
		path := filepath.Join(a.o.dir, "avatars", file+".jpg")
		if clean != "" {
			if err := os.Rename(clean, path); err != nil {
				sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
				return
			}
			*photo = time.Now().UnixMilli()
		} else {
			os.Remove(path)
			*photo = 0
		}
		if kind == "users" {
			if face > 0 {
				if a.o.data.Faces == nil {
					a.o.data.Faces = map[string]int64{}
				}
				a.o.data.Faces[id] = face
			} else {
				delete(a.o.data.Faces, id)
			}
		}
		h.saveData(a.o)
		a.o.changed(true)
		sendJSON(w, r, http.StatusOK, map[string]int64{"photo": *photo})
	})
}

// cleanCardUID is a vCard UID as Chat keeps it: trimmed, one line, not huge.
func cleanCardUID(uid string) string {
	uid = strings.TrimSpace(uid)
	if len(uid) > 200 || strings.ContainsAny(uid, "\r\n") {
		return ""
	}
	return uid
}

// chatCardPhoto makes the raw JPEG or PNG in the body the PHOTO of one card
// of the owner's address book (the Contacts app): a picture chosen in Chat
// for a person picked from there is that card's too (setCardPhoto).
func (s *Server) chatCardPhoto(w http.ResponseWriter, r *http.Request,
	resolve func(func(chatActor)), ownerOnly func(chatActor) bool) {

	uid := cleanCardUID(r.URL.Query().Get("uid"))
	if uid == "" {
		sendError(w, r, http.StatusBadRequest, "falta la tarjeta")
		return
	}
	if r.ContentLength <= 0 || r.ContentLength > cardPhotoMax {
		sendError(w, r, http.StatusRequestEntityTooLarge, "foto no válida")
		return
	}
	img, err := io.ReadAll(http.MaxBytesReader(w, r.Body, r.ContentLength))
	if err != nil || int64(len(img)) != r.ContentLength {
		sendError(w, r, http.StatusBadRequest, "el envío llegó cortado")
		return
	}
	if imageKind(img) == "" {
		sendError(w, r, http.StatusBadRequest, "no es una foto JPEG o PNG")
		return
	}
	user := ""
	resolve(func(a chatActor) {
		if ownerOnly(a) {
			user = a.o.user
		}
	})
	if user == "" {
		return
	}
	switch err := setCardPhoto(filepath.Join(s.cfg.HomesDir, user, "data", "contacts.vcf"), uid, img); {
	case errors.Is(err, errCardNotFound):
		sendError(w, r, http.StatusNotFound, "no existe esa tarjeta")
	case err != nil:
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
	default:
		sendJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
	}
}

// chatAvatar sends a person's or group's picture to whoever may see it.
func (s *Server) chatAvatar(w http.ResponseWriter, r *http.Request, id string, resolve func(func(chatActor))) {
	var file *os.File
	var info os.FileInfo
	resolve(func(a chatActor) {
		if _, ok := a.o.avatarsFor(a.pid)[id]; !ok {
			sendError(w, r, http.StatusNotFound, "no existe")
			return
		}
		f, fi, err := openInside(filepath.Join(a.o.dir, "avatars"), id+".jpg")
		if err != nil {
			sendError(w, r, http.StatusNotFound, "no existe")
			return
		}
		file, info = f, fi
	})
	if file == nil {
		return
	}
	defer file.Close()
	// The URL carries ?v=<version>: a new picture is a new URL.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	serveImage(w, r, file, "image/jpeg", info)
}

// -----------------------------------------------------------------------------
// one conversation
// -----------------------------------------------------------------------------

func (s *Server) chatConvRoute(w http.ResponseWriter, r *http.Request, conv string, rest []string,
	resolve func(func(chatActor)), method func(...string) bool) {

	// in runs `fn` with the conversation, once the asker is known to be in it.
	in := func(fn func(a chatActor, c *chatConv)) {
		resolve(func(a chatActor) {
			if !a.o.isMember(conv, a.pid) {
				sendError(w, r, http.StatusForbidden, "no estás en esta conversación")
				return
			}
			c := s.chat.conv(a.o, conv)
			// A file of this conversation failed to load: it is served as it
			// loaded, and no change is taken - the next write would replace
			// that file from memory, which holds none of it (F5).
			if c.isDamaged() && r.Method != http.MethodGet && r.Method != http.MethodHead {
				sendError(w, r, http.StatusInternalServerError, chatDamagedText)
				return
			}
			fn(a, c)
		})
	}
	msgID := func(seg string) int64 {
		n, _ := strconv.ParseInt(seg, 10, 64)
		return n
	}

	switch {
	case len(rest) == 1 && rest[0] == "messages":
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			in(func(a chatActor, c *chatConv) { s.chatMessages(w, r, a, c) })
		case http.MethodPost:
			s.chatSend(w, r, in)
		default:
			method(http.MethodGet, http.MethodPost)
		}

	case len(rest) == 2 && rest[0] == "messages":
		id := msgID(rest[1])
		switch r.Method {
		case http.MethodPatch:
			var body struct {
				Text string `json:"text"`
			}
			if err := readJSON(w, r, &body); err != nil {
				sendBodyError(w, r, err)
				return
			}
			in(func(a chatActor, c *chatConv) { s.chatEdit(w, r, a, c, id, body.Text) })
		case http.MethodDelete:
			in(func(a chatActor, c *chatConv) { s.chatDelete(w, r, a, c, id) })
		default:
			method(http.MethodPatch, http.MethodDelete)
		}

	case len(rest) == 3 && rest[0] == "messages" && (rest[2] == "react" || rest[2] == "vote"):
		if !method(http.MethodPost) {
			return
		}
		var body struct {
			Emoji string `json:"emoji"`
			Opt   int    `json:"opt"`
		}
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		id := msgID(rest[1])
		in(func(a chatActor, c *chatConv) {
			if rest[2] == "react" {
				s.chatReact(w, r, a, c, id, body.Emoji)
			} else {
				s.chatVote(w, r, a, c, id, body.Opt)
			}
		})

	case len(rest) == 3 && rest[0] == "messages" && rest[2] == "keep":
		if !method(http.MethodPost) {
			return
		}
		var body struct {
			Dir string `json:"dir"`
		}
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		id := msgID(rest[1])
		s.chat.inKept(in, func(a chatActor, c *chatConv) string {
			if a.guest() {
				return ""
			}
			return s.chat.keptWalk(a.o, c, c.byID[id], false)
		}, func(a chatActor, c *chatConv) {
			if a.guest() {
				sendError(w, r, http.StatusForbidden, "no permitido")
				return
			}
			// It writes into the owner's files: never from a page of
			// another account (L5, store_owner.go).
			if !s.saveOwnerOK(w, r, "user", a.o.user) {
				return
			}
			s.chatKeep(w, r, a, c, id, body.Dir)
		})

	case len(rest) == 3 && rest[0] == "messages" && rest[2] == "edited":
		if !method(http.MethodPost) {
			return
		}
		var body chatSendReq
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		id := msgID(rest[1])
		s.chat.inKept(in, func(a chatActor, c *chatConv) string {
			if a.guest() {
				return ""
			}
			return s.chat.keptWalk(a.o, c, c.byID[id], false)
		}, func(a chatActor, c *chatConv) {
			if a.guest() {
				sendError(w, r, http.StatusForbidden, "no permitido")
				return
			}
			if !s.saveOwnerOK(w, r, "user", a.o.user) { // as Copiar: the owner's files
				return
			}
			s.chatEdited(w, r, a, c, id, body)
		})

	case len(rest) == 1 && rest[0] == "upload":
		if method(http.MethodPost) {
			s.chatUpload(w, r, conv, in, resolve)
		}

	case len(rest) == 2 && rest[0] == "media":
		if method(http.MethodGet) {
			s.chatMedia(w, r, msgID(rest[1]), in)
		}

	case len(rest) == 1 && rest[0] == "read":
		if !method(http.MethodPost) {
			return
		}
		var body struct {
			ID int64 `json:"id"`
		}
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		in(func(a chatActor, c *chatConv) {
			last := int64(0)
			if m := c.last(); m != nil {
				last = m.ID
			}
			id := min(body.ID, last)
			if id > c.st.Read[a.pid] {
				c.st.Read[a.pid] = id
				a.o.bump(c, nil)
				s.chat.saveState(c)
			}
			sendJSON(w, r, http.StatusOK, map[string]int64{"read": c.st.Read[a.pid]})
		})

	case len(rest) == 1 && rest[0] == "clear":
		// Delete the chat - for the asker only, as in WhatsApp. It leaves their
		// list until something new arrives; what everybody has deleted is purged.
		if !method(http.MethodPost) {
			return
		}
		in(func(a chatActor, c *chatConv) {
			last := int64(0)
			if m := c.last(); m != nil {
				last = m.ID
			}
			if c.st.Cleared == nil {
				c.st.Cleared = map[string]int64{}
			}
			c.st.Cleared[a.pid] = last
			if last > c.st.Read[a.pid] {
				c.st.Read[a.pid] = last
			}
			s.chat.purge(a.o, c)
			a.o.bump(c, nil)
			s.chat.saveState(c)
			sendJSON(w, r, http.StatusOK, map[string]int64{"cleared": last})
		})

	case rest[0] == "later" && len(rest) <= 3:
		s.chatLater(w, r, rest[1:], in)

	case len(rest) == 1 && rest[0] == "typing":
		if !method(http.MethodPost) {
			return
		}
		in(func(a chatActor, c *chatConv) {
			who := a.o.typing[conv]
			if who == nil {
				who = map[string]time.Time{}
				a.o.typing[conv] = who
			}
			was := who[a.pid].After(time.Now())
			who[a.pid] = time.Now().Add(chatTypingFor)
			if !was {
				s.chat.sweepOnce.Do(func() { go s.chat.sweep() })
				a.o.changed(false)
			}
			w.WriteHeader(http.StatusNoContent)
		})

	case len(rest) == 1 && rest[0] == "prefs":
		if !method(http.MethodPost) {
			return
		}
		var body struct {
			Pin  *bool `json:"pin"`
			Mute *bool `json:"mute"`
		}
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		in(func(a chatActor, c *chatConv) {
			if body.Pin != nil {
				if c.st.Pin == nil {
					c.st.Pin = map[string]bool{}
				}
				setFlag(c.st.Pin, a.pid, *body.Pin)
			}
			if body.Mute != nil {
				if c.st.Mute == nil {
					c.st.Mute = map[string]bool{}
				}
				setFlag(c.st.Mute, a.pid, *body.Mute)
			}
			s.chat.saveState(c)
			a.o.changed(false)
			sendJSON(w, r, http.StatusOK, map[string]bool{"pin": c.st.Pin[a.pid], "mute": c.st.Mute[a.pid]})
		})

	default:
		sendError(w, r, http.StatusNotFound, "no such endpoint")
	}
}

func setFlag(m map[string]bool, k string, on bool) {
	if on {
		m[k] = true
	} else {
		delete(m, k)
	}
}

func (s *Server) chatMessages(w http.ResponseWriter, r *http.Request, a chatActor, c *chatConv) {
	var pick []*ChatMsg
	more := false
	// What the asker deleted the chat past is not theirs any more.
	base := searchID(c.msgs, c.floor(a.pid)+1)
	msgs := c.msgs[base:]
	since, hasSince := int64(0), queryValue(r, "since") != ""
	if hasSince {
		since, _ = strconv.ParseInt(queryValue(r, "since"), 10, 64)
	}
	before, _ := strconv.ParseInt(queryValue(r, "before"), 10, 64)

	switch {
	case queryValue(r, "all") == "1":
		pick = msgs
	case hasSince:
		for _, m := range msgs {
			if m.Rev > since {
				pick = append(pick, m)
			}
		}
	default:
		end := len(msgs)
		if before > 0 {
			end = searchID(msgs, before)
		}
		start := max(0, end-chatPage)
		// Never cut the page inside what the asker has not read yet: the
		// "unread" band must have all of it under it (up to a sane limit).
		if before == 0 {
			seen := c.st.Read[a.pid]
			for start > 0 && end-start < 400 && msgs[start].ID > seen {
				start--
			}
		}
		pick, more = msgs[start:end], start > 0
	}

	out := make([]chatMsgOut, 0, len(pick))
	for _, m := range pick {
		out = append(out, c.out(m))
	}
	sendJSON(w, r, http.StatusOK, map[string]any{
		"rev": c.st.Rev, "msgs": out, "read": c.st.Read, "more": more, "gone": c.st.Gone,
	})
}

// searchID is the index of the first message whose id is >= id.
func searchID(msgs []*ChatMsg, id int64) int {
	lo, hi := 0, len(msgs)
	for lo < hi {
		mid := (lo + hi) / 2
		if msgs[mid].ID < id {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo
}

// chatSendReq is the body of POST conv/<c>/messages.
type chatSendReq struct {
	Kind    string    `json:"kind"`
	Text    string    `json:"text"`
	ReplyTo int64     `json:"replyTo"`
	CID     string    `json:"cid"`
	Loc     *ChatLoc  `json:"loc"`
	Card    *ChatCard `json:"card"`
	Poll    *ChatPoll `json:"poll"`
	FwdConv string    `json:"fwdConv"`
	FwdID   int64     `json:"fwdId"`
	Silent  bool      `json:"silent"` // "Send without sound"
	// Ref: the owner sends a JPEG of their own files ("files/...") as a photo
	// that stays there - no copy (chatLinkPhoto). W, H: its size as shown.
	Ref string `json:"ref"`
	W   int    `json:"w"`
	H   int    `json:"h"`
}

func (s *Server) chatSend(w http.ResponseWriter, r *http.Request, in func(func(chatActor, *chatConv))) {
	var req chatSendReq
	if err := readJSON(w, r, &req); err != nil {
		sendBodyError(w, r, err)
		return
	}
	if len(req.CID) > 40 {
		req.CID = ""
	}
	var fwd *chatFwdFile // a forwarded file, copied before the lock (OL1)
	if req.FwdConv != "" {
		var ok bool
		if fwd, ok = s.chatFwdCopy(w, r, in, req); !ok {
			return
		}
		if fwd != nil {
			defer func() {
				if fwd.tmp != "" { // "": it took its name - never touch a later temp
					os.Remove(fwd.tmp)
				}
			}()
		}
	}
	in(func(a chatActor, c *chatConv) {
		h := s.chat
		if id, dup := c.cids[a.pid+"|"+req.CID]; dup && req.CID != "" {
			if m := c.byID[id]; m != nil {
				sendJSON(w, r, http.StatusOK, c.out(m))
				return
			}
		}
		if fwd == nil && !a.o.allowSend(a.pid) { // a copied forward was counted before its copy
			sendError(w, r, http.StatusTooManyRequests, "demasiados mensajes seguidos")
			return
		}
		m := &ChatMsg{From: a.pid, Kind: req.Kind, CID: req.CID, Silent: req.Silent}
		copied := false                  // a forwarded attachment's copy took its name
		linkRel, linkIno := "", keptID{} // a photo sent from the owner's files
		if req.FwdConv != "" {
			if !a.o.isMember(req.FwdConv, a.pid) {
				sendError(w, r, http.StatusForbidden, "no estás en esa conversación")
				return
			}
			src := h.conv(a.o, req.FwdConv)
			orig := src.byID[req.FwdID]
			if orig == nil || orig.Deleted {
				sendError(w, r, http.StatusNotFound, "ese mensaje ya no existe")
				return
			}
			if orig.Kind == "call" {
				sendError(w, r, http.StatusBadRequest, "una llamada no se reenvía")
				return
			}
			m.Kind, m.Text, m.Fwd = orig.Kind, orig.Text, true
			if orig.Loc != nil {
				l := *orig.Loc
				m.Loc = &l
			}
			if orig.Card != nil {
				cd := *orig.Card
				m.Card = &cd
			}
			if orig.Poll != nil {
				m.Poll = &ChatPoll{Q: orig.Poll.Q, Opts: append([]string(nil), orig.Poll.Opts...), Multi: orig.Poll.Multi}
			}
			if orig.File != nil {
				// Its copy, made before the lock - for this home still (an
				// owner renamed meanwhile has another folder).
				if fwd == nil || fwd.owner != a.o.user || fwd.dir != a.o.dir {
					sendError(w, r, http.StatusGone, "ese fichero ya no está")
					return
				}
				// The owner swapped the photo (chatEdited) during the copy:
				// those bytes are no longer what the message shows.
				if *orig.File != fwd.ref {
					sendError(w, r, http.StatusConflict, "esa foto acaba de cambiar; inténtalo otra vez")
					return
				}
				f := *orig.File
				m.File = &f
			}
		} else if req.Ref != "" {
			if a.guest() {
				sendError(w, r, http.StatusForbidden, "no permitido")
				return
			}
			caption, ok := cleanChatText(req.Text, chatMaxText)
			if !ok {
				sendError(w, r, http.StatusBadRequest, "texto no válido")
				return
			}
			ref, rel, ino, status, msg := s.chatLinkPhoto(a, req)
			if ref == nil {
				sendError(w, r, status, msg)
				return
			}
			m.Kind, m.Text, m.File = "photo", caption, ref
			linkRel, linkIno = rel, ino
		} else if msg, ok := checkSend(req); ok {
			m.Kind, m.Text, m.Loc, m.Card, m.Poll = msg.Kind, msg.Text, msg.Loc, msg.Card, msg.Poll
		} else {
			sendError(w, r, http.StatusBadRequest, "mensaje no válido")
			return
		}
		if req.ReplyTo > 0 && c.byID[req.ReplyTo] != nil {
			m.ReplyTo = req.ReplyTo
		}
		m.ID, m.At = c.st.Next, nowMs()
		if m.File != nil && m.Fwd {
			media := filepath.Join(c.dir, "media")
			final := filepath.Join(media, mediaName(m))
			if err := mkdirInHome(s.cfg.HomesDir, media); err != nil { // never the home itself (L2)
				sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
				return
			}
			if err := os.Rename(fwd.tmp, final); err != nil {
				sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
				return
			}
			if err := syncDir(media); err != nil { // its name durable too (K1)
				os.Remove(final)
				sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
				return
			}
			fwd.tmp, copied = "", true
			m.File.Size = fwd.n // a kept photo may have been edited since
			h.users.AdjustUsage(a.o.user, fwd.n)
		}
		linked := int64(-1) // a photo from the owner's files: what its media/ copy took (0: a hard link)
		if linkRel != "" {
			// The chat's own name for it (J4): binned, renamed or replaced in
			// the owner's files, the message still shows what was sent.
			n, err := h.keepBytes(a.o, c, m, linkRel, linkIno)
			if err != nil {
				sendError(w, r, http.StatusConflict, "esa foto acaba de cambiar; inténtalo otra vez")
				return
			}
			linked = n
			if n > 0 {
				h.users.AdjustUsage(a.o.user, n) // a copy (a disk with no links)
			}
			h.setKept(c, m.ID, linkRel, linkIno)
		}
		if err := s.chatStore(a, c, m); err != nil {
			// Not on disk: never answered "sent" (J5). Its copied file goes too.
			if copied {
				h.dropMediaFile(a.o, c, m)
			}
			if linked >= 0 { // the chat's name only: the owner's file stays
				os.Remove(filepath.Join(c.dir, "media", mediaName(m)))
				if linked > 0 {
					h.users.AdjustUsage(a.o.user, -linked)
				}
			}
			sendError(w, r, http.StatusInternalServerError, chatNotSavedText)
			return
		}
		sendJSON(w, r, http.StatusCreated, c.out(m))
	})
}

// chatNotSavedText answers a message that could not be written to disk.
const chatNotSavedText = "no se pudo guardar el mensaje; inténtalo otra vez"

// chatDamagedText answers a change refused because a file of that chat failed
// to load (chatOwner.damaged, chatConv.damaged).
const chatDamagedText = "un archivo de este chat está dañado: no se puede cambiar nada (avisa al administrador)"

// chatLinkPhoto checks the JPEG the owner sends from their own files (or
// points a message at, chatEdited) and describes it; nil + status + message
// when it cannot be used that way. Caller holds h.mu.
func (s *Server) chatLinkPhoto(a chatActor, req chatSendReq) (*ChatFileRef, string, keptID, int, string) {
	parts := splitPath(req.Ref)
	low := strings.ToLower(req.Ref)
	if len(parts) < 2 || parts[0] != "files" || !(strings.HasSuffix(low, ".jpg") || strings.HasSuffix(low, ".jpeg")) {
		return nil, "", keptID{}, http.StatusBadRequest, "foto no válida"
	}
	rel := strings.Join(parts, "/")
	file, info, err := s.chat.openKept(a.o.user, rel)
	if err != nil {
		return nil, "", keptID{}, http.StatusNotFound, "esa foto no existe"
	}
	defer file.Close()
	meta, err := readJPEGMeta(file, info.Size())
	if err != nil {
		return nil, "", keptID{}, http.StatusBadRequest, "no es una foto JPEG"
	}
	ref := &ChatFileRef{Name: cleanFileName(parts[len(parts)-1]), Size: info.Size(), Ext: "jpg"}
	if req.W > 0 && req.W < 100000 && req.H > 0 && req.H < 100000 {
		ref.W, ref.H = req.W, req.H
	}
	if meta.HasGPS {
		ref.Pos = &ChatLoc{Lat: meta.Lat, Lon: meta.Lon, Acc: meta.Acc}
	}
	return ref, rel, keptIDOf(info), 0, ""
}

// chatStore adds a new message (store). Caller holds h.mu and has set m.ID.
func (s *Server) chatStore(a chatActor, c *chatConv, m *ChatMsg) error {
	return s.chat.store(a.o, c, m)
}

// store adds a new message to one of `o`'s conversations: id, rev, the
// sender's read cursor, disk, notifications. Caller holds h.mu and has set m.ID.
// An error: the message is not stored (see record) and nobody is notified.
func (h *ChatHub) store(o *chatOwner, c *chatConv, m *ChatMsg) error {
	if err := h.record(o, c, m); err != nil {
		return err
	}
	if who := o.typing[c.id]; who != nil {
		delete(who, m.From)
	}
	h.announce(o, c, m)
	return nil
}

// record is store without the notifications: id, rev, the sender's read
// cursor, disk. A call's bubble (endCall) goes in this way - its call already
// rang. Caller holds h.mu and has set m.ID.
//
// A message is only stored once it is ON DISK (J5): when its month or the
// state cannot be written, it is taken out of memory again and the error is
// answered - never "sent" for a message a restart would lose.
func (h *ChatHub) record(o *chatOwner, c *chatConv, m *ChatMsg) error {
	month := monthOf(m.At) + ".json"
	if !c.canWrite(month) || !c.canWrite("state.json") {
		h.forgetKept(c, m.ID)
		return errChatDamaged // a file that failed to load is never written over (F5)
	}
	next := c.st.Next
	read, hadRead := c.st.Read[m.From]
	c.st.Next = m.ID + 1
	c.msgs = append(c.msgs, m)
	c.byID[m.ID] = m
	if m.CID != "" {
		c.cids[m.From+"|"+m.CID] = m.ID
	}
	c.st.Read[m.From] = m.ID
	o.bump(c, m)
	err := h.saveMonth(c, m)
	if err == nil {
		return nil
	}
	// Undo: the message leaves memory, and the month is written again without
	// it - one that did land must not bring it back after a restart.
	c.msgs = c.msgs[:len(c.msgs)-1]
	delete(c.byID, m.ID)
	if m.CID != "" {
		delete(c.cids, m.From+"|"+m.CID)
	}
	c.st.Next = next
	if hadRead {
		c.st.Read[m.From] = read
	} else {
		delete(c.st.Read, m.From)
	}
	h.forgetKept(c, m.ID)
	h.writeMonth(c, monthOf(m.At))
	h.log.Error("chat: a message could not be saved - not sent", "user", o.user, "conv", c.id, "err", err)
	return err
}

// forgetKept drops the link a message that was never stored had to the
// owner's file (setKept before record).
func (h *ChatHub) forgetKept(c *chatConv, id int64) {
	delete(c.st.Kept, id)
	delete(c.st.KeptID, id)
}

// dropMediaFile removes the file under media/ of a message that was never
// stored, and gives its bytes back to the quota. Caller holds h.mu.
func (h *ChatHub) dropMediaFile(o *chatOwner, c *chatConv, m *ChatMsg) {
	if m.File == nil {
		return
	}
	path := filepath.Join(c.dir, "media", mediaName(m))
	if info, err := os.Stat(path); err == nil && os.Remove(path) == nil {
		h.users.AdjustUsage(o.user, -info.Size())
	}
}

// chatLater: texts scheduled for a time to come (chat.go "LATER").
//
//	POST   later             {"text","at","replyTo","cid"} -> 201 the scheduled text
//	DELETE later/<id>        204
//	POST   later/<id>/send   send it now -> 201 the message
func (s *Server) chatLater(w http.ResponseWriter, r *http.Request, rest []string,
	in func(func(chatActor, *chatConv))) {

	h := s.chat
	switch {
	case len(rest) == 0 && r.Method == http.MethodPost:
		var body struct {
			Text    string `json:"text"`
			At      int64  `json:"at"`
			ReplyTo int64  `json:"replyTo"`
			CID     string `json:"cid"`
		}
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		text, ok := cleanChatText(body.Text, chatMaxText)
		now := time.Now()
		switch {
		case !ok || text == "":
			sendError(w, r, http.StatusBadRequest, "mensaje no válido")
			return
		case body.At < now.Add(-time.Minute).UnixMilli() || body.At > now.Add(chatLaterMax).UnixMilli():
			sendError(w, r, http.StatusBadRequest, "hora no válida")
			return
		}
		if len(body.CID) > 40 {
			body.CID = ""
		}
		in(func(a chatActor, c *chatConv) {
			mine := 0
			for _, l := range a.o.data.Later {
				if l.From != a.pid {
					continue
				}
				if body.CID != "" && l.CID == body.CID && l.Conv == c.id {
					sendJSON(w, r, http.StatusOK, l) // a retry
					return
				}
				mine++
			}
			if mine >= chatMaxLater {
				sendError(w, r, http.StatusConflict, "demasiados mensajes programados")
				return
			}
			if !a.o.allowSend(a.pid) {
				sendError(w, r, http.StatusTooManyRequests, "demasiados mensajes seguidos")
				return
			}
			l := &ChatLater{ID: newChatID(), Conv: c.id, From: a.pid, At: body.At, Text: text, CID: body.CID}
			if body.ReplyTo > 0 && c.byID[body.ReplyTo] != nil {
				l.ReplyTo = body.ReplyTo
			}
			a.o.data.Later = append(a.o.data.Later, l)
			if err := h.saveData(a.o); err != nil {
				a.o.data.Later = a.o.data.Later[:len(a.o.data.Later)-1]
				sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
				return
			}
			a.o.changed(true)
			sendJSON(w, r, http.StatusCreated, l)
		})

	case len(rest) == 1 && r.Method == http.MethodDelete,
		len(rest) == 2 && rest[1] == "send" && r.Method == http.MethodPost:
		id := rest[0]
		in(func(a chatActor, c *chatConv) {
			var l *ChatLater
			keep := a.o.data.Later[:0:0]
			for _, x := range a.o.data.Later {
				if x.ID == id && x.Conv == c.id && x.From == a.pid {
					l = x
				} else {
					keep = append(keep, x)
				}
			}
			if l == nil {
				sendError(w, r, http.StatusNotFound, "ese mensaje ya no está programado")
				return
			}
			a.o.data.Later = keep
			var m *ChatMsg
			if len(rest) == 2 {
				var err error
				if _, m, err = h.sendLater(a.o, l); err != nil {
					a.o.data.Later = append(a.o.data.Later, l) // still scheduled (J5)
					sendError(w, r, http.StatusInternalServerError, chatNotSavedText)
					return
				}
			}
			if err := h.saveData(a.o); err != nil && len(rest) == 1 {
				// Not cancelled on disk: a restart would send it. Still
				// scheduled, and said so. (Sent, it is known by its cid, SF3.)
				a.o.data.Later = append(a.o.data.Later, l)
				sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
				return
			}
			a.o.changed(true)
			if m == nil {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			sendJSON(w, r, http.StatusCreated, c.out(m))
		})

	default:
		sendError(w, r, http.StatusMethodNotAllowed, "método no permitido")
	}
}

// checkSend validates a new text, location, contact or poll message.
func checkSend(req chatSendReq) (*ChatMsg, bool) {
	m := &ChatMsg{Kind: req.Kind}
	switch req.Kind {
	case "text":
		t, ok := cleanChatText(req.Text, chatMaxText)
		if !ok || t == "" {
			return nil, false
		}
		m.Text = t
	case "loc":
		l := req.Loc
		if l == nil || !validLatLon(l.Lat, l.Lon) || l.Acc < 0 || l.Acc > 1e6 || math.IsNaN(l.Acc) {
			return nil, false
		}
		m.Loc = &ChatLoc{Lat: l.Lat, Lon: l.Lon, Acc: math.Round(l.Acc), Place: clip(cleanChatName(l.Place), 120)}
	case "card":
		cd := req.Card
		if cd == nil {
			return nil, false
		}
		name := cleanChatName(cd.Name)
		if name == "" || len(cd.Tels) > 6 || len(cd.Emails) > 6 {
			return nil, false
		}
		out := &ChatCard{Name: name}
		for _, t := range cd.Tels {
			if t = strings.TrimSpace(t); t != "" && len(t) <= 40 && strings.Trim(t, "0123456789+-(). ") == "" {
				out.Tels = append(out.Tels, t)
			}
		}
		for _, e := range cd.Emails {
			if e = strings.TrimSpace(e); e != "" && len(e) <= 120 && strings.Contains(e, "@") && !strings.ContainsAny(e, " <>\"") {
				out.Emails = append(out.Emails, e)
			}
		}
		if len(out.Tels) == 0 && len(out.Emails) == 0 {
			return nil, false
		}
		m.Card = out
	case "poll":
		p := req.Poll
		if p == nil || len(p.Opts) < 2 || len(p.Opts) > chatMaxOpts {
			return nil, false
		}
		q, ok := cleanChatText(p.Q, 300)
		if !ok || q == "" {
			return nil, false
		}
		out := &ChatPoll{Q: q, Multi: p.Multi}
		for _, o := range p.Opts {
			o = clip(cleanChatName(o), 100)
			if o == "" || contains(out.Opts, o) {
				return nil, false
			}
			out.Opts = append(out.Opts, o)
		}
		m.Poll = out
	default:
		return nil, false
	}
	return m, true
}

func (s *Server) chatEdit(w http.ResponseWriter, r *http.Request, a chatActor, c *chatConv, id int64, text string) {
	m := c.byID[id]
	if m == nil || m.Deleted || m.From != a.pid {
		sendError(w, r, http.StatusForbidden, "solo puedes editar tus mensajes")
		return
	}
	if m.Kind != "text" && m.Kind != "photo" && m.Kind != "file" {
		sendError(w, r, http.StatusBadRequest, "este mensaje no se puede editar")
		return
	}
	t, ok := cleanChatText(text, chatMaxText)
	if !ok || (t == "" && m.Kind == "text") {
		sendError(w, r, http.StatusBadRequest, "texto no válido")
		return
	}
	if t != m.Text {
		m.Text, m.Edited = t, nowMs()
		a.o.bump(c, m)
		s.chat.saveMonth(c, m)
	}
	sendJSON(w, r, http.StatusOK, c.out(m))
}

func (s *Server) chatDelete(w http.ResponseWriter, r *http.Request, a chatActor, c *chatConv, id int64) {
	m := c.byID[id]
	if m == nil || m.From != a.pid {
		sendError(w, r, http.StatusForbidden, "solo puedes borrar tus mensajes")
		return
	}
	if !m.Deleted {
		s.chat.dropMedia(a.o, c, m) // a kept photo stays in the owner's files
		m.Deleted = true
		m.Text, m.File, m.Loc, m.Card, m.Poll, m.Reacts, m.ReplyTo, m.Edited = "", nil, nil, nil, nil, nil, 0, 0
		a.o.bump(c, m)
		s.chat.saveMonth(c, m)
	}
	sendJSON(w, r, http.StatusOK, c.out(m))
}

func (s *Server) chatReact(w http.ResponseWriter, r *http.Request, a chatActor, c *chatConv, id int64, emoji string) {
	m := c.byID[id]
	if m == nil || m.Deleted {
		sendError(w, r, http.StatusNotFound, "ese mensaje ya no existe")
		return
	}
	emoji = strings.TrimSpace(emoji)
	if len(emoji) > 32 || !utf8.ValidString(emoji) || strings.IndexFunc(emoji, func(r rune) bool {
		return r < 0x80 && r != '#' && r != '*' && !(r >= '0' && r <= '9')
	}) >= 0 {
		sendError(w, r, http.StatusBadRequest, "reacción no válida")
		return
	}
	if emoji == "" {
		delete(m.Reacts, a.pid)
	} else {
		if m.Reacts == nil {
			m.Reacts = map[string]string{}
		}
		m.Reacts[a.pid] = emoji
	}
	if len(m.Reacts) == 0 {
		m.Reacts = nil
	}
	a.o.bump(c, m)
	s.chat.saveMonth(c, m)
	sendJSON(w, r, http.StatusOK, c.out(m))
}

func (s *Server) chatVote(w http.ResponseWriter, r *http.Request, a chatActor, c *chatConv, id int64, opt int) {
	m := c.byID[id]
	if m == nil || m.Deleted || m.Poll == nil || opt < 0 || opt >= len(m.Poll.Opts) {
		sendError(w, r, http.StatusBadRequest, "voto no válido")
		return
	}
	p := m.Poll
	if p.Votes == nil {
		p.Votes = map[string][]int{}
	}
	mine := p.Votes[a.pid]
	had := false
	for _, v := range mine {
		had = had || v == opt
	}
	switch {
	case had:
		var keep []int
		for _, v := range mine {
			if v != opt {
				keep = append(keep, v)
			}
		}
		mine = keep
	case p.Multi:
		mine = append(mine, opt)
	default:
		mine = []int{opt}
	}
	if len(mine) == 0 {
		delete(p.Votes, a.pid)
	} else {
		p.Votes[a.pid] = mine
	}
	a.o.bump(c, m)
	s.chat.saveMonth(c, m)
	sendJSON(w, r, http.StatusOK, c.out(m))
}

// -----------------------------------------------------------------------------
// photos and files
// -----------------------------------------------------------------------------

// chatUpload receives one photo or file as the raw request body. The body is
// read into a temp file BEFORE the lock is taken - a 25 MB upload over a slow
// line must not stop everybody else's chat.
func (s *Server) chatUpload(w http.ResponseWriter, r *http.Request, conv string,
	in func(func(chatActor, *chatConv)), resolve func(func(chatActor))) {

	h := s.chat
	kind := queryValue(r, "kind")
	if kind != "photo" && kind != "file" {
		sendError(w, r, http.StatusBadRequest, "tipo no válido")
		return
	}
	size := r.ContentLength
	if size <= 0 {
		sendError(w, r, http.StatusLengthRequired, "falta el tamaño")
		return
	}
	if size > chatMaxFile {
		w.Header().Set("Connection", "close")
		sendError(w, r, http.StatusRequestEntityTooLarge, "el fichero pasa de 25 MB")
		return
	}
	caption, ok := cleanChatText(queryValue(r, "text"), chatMaxText)
	if !ok {
		sendError(w, r, http.StatusBadRequest, "texto no válido")
		return
	}
	name := cleanFileName(queryValue(r, "name"))
	cid := queryValue(r, "cid")
	if len(cid) > 40 {
		cid = ""
	}
	replyTo, _ := strconv.ParseInt(queryValue(r, "replyTo"), 10, 64)
	width, _ := strconv.Atoi(queryValue(r, "w"))
	height, _ := strconv.Atoi(queryValue(r, "h"))

	// 1. May they, and is there room? (quick, under the lock)
	var mediaDir, owner string
	allowed := false
	in(func(a chatActor, c *chatConv) {
		if id, dup := c.cids[a.pid+"|"+cid]; dup && cid != "" {
			if m := c.byID[id]; m != nil {
				sendJSON(w, r, http.StatusOK, c.out(m))
				return
			}
		}
		if !a.o.allowSend(a.pid) || !a.o.allowBytes(a.pid, size) {
			sendError(w, r, http.StatusTooManyRequests, "demasiados envíos seguidos")
			return
		}
		mediaDir, owner, allowed = filepath.Join(c.dir, "media"), a.o.user, true
	})
	if !allowed {
		return
	}
	// The quota OUTSIDE the lock: past its cache, the usage figure is a walk of
	// the whole home, and every chat would wait on it (S2-#17).
	if left, limited := h.users.QuotaLeft(owner); limited && size > left {
		sendError(w, r, http.StatusInsufficientStorage, "no queda espacio")
		return
	}
	if err := mkdirInHome(s.cfg.HomesDir, mediaDir); err != nil { // never the home itself (L2)
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
		return
	}

	// 2. The bytes, into a temp file (no lock).
	tmp, err := os.CreateTemp(mediaDir, ".up-*")
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	n, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, size))
	tmp.Close()
	if err != nil || n != size {
		sendError(w, r, http.StatusBadRequest, "el envío llegó cortado")
		return
	}
	ext := fileExt(name)
	var pos *ChatLoc
	if kind == "photo" {
		// A photo is a JPEG (the page draws every picture into one) and keeps
		// its Exif - date, camera, and the position (his call, 2026-09-19: a
		// kept photo lands in Photos, whose map and timeline need them).
		// Anything after the image is cut: a phone may append a whole video.
		clean, err := cleanPhoto(tmpPath, mediaDir, true)
		if err != nil {
			sendError(w, r, http.StatusBadRequest, "no es una foto JPEG")
			return
		}
		defer os.Remove(clean)
		tmpPath, ext = clean, "jpg"
		if info, err := os.Stat(clean); err == nil {
			size = info.Size()
		}
		pos = photoPos(clean)
	}

	// The bytes on disk before the file takes its name (J5): the month that
	// will point at it is synced too, and must never point at an empty photo
	// after a power cut. Done here, before the lock.
	if err := syncFile(tmpPath); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
		return
	}

	// 3. The message (under the lock again).
	resolve(func(a chatActor) {
		if a.o.user != owner || !a.o.isMember(conv, a.pid) {
			sendError(w, r, http.StatusForbidden, "no estás en esta conversación")
			return
		}
		c := h.conv(a.o, conv)
		if id, dup := c.cids[a.pid+"|"+cid]; dup && cid != "" {
			if m := c.byID[id]; m != nil {
				sendJSON(w, r, http.StatusOK, c.out(m))
				return
			}
		}
		m := &ChatMsg{ID: c.st.Next, At: nowMs(), From: a.pid, Kind: kind, Text: caption, CID: cid,
			File: &ChatFileRef{Name: name, Size: size, Ext: ext, Pos: pos}}
		if kind == "photo" {
			if width > 0 && width < 100000 && height > 0 && height < 100000 {
				m.File.W, m.File.H = width, height
			}
			if !strings.HasSuffix(strings.ToLower(m.File.Name), ".jpg") &&
				!strings.HasSuffix(strings.ToLower(m.File.Name), ".jpeg") {
				m.File.Name = strings.TrimSuffix(m.File.Name, filepath.Ext(m.File.Name)) + ".jpg"
			}
		}
		if replyTo > 0 && c.byID[replyTo] != nil {
			m.ReplyTo = replyTo
		}
		if err := os.Rename(tmpPath, filepath.Join(mediaDir, mediaName(m))); err != nil {
			sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
		h.users.AdjustUsage(a.o.user, size)
		if err := syncDir(mediaDir); err != nil { // its name durable too (K1)
			h.dropMediaFile(a.o, c, m)
			sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
		if err := s.chatStore(a, c, m); err != nil {
			h.dropMediaFile(a.o, c, m) // not stored: never answered "sent" (J5)
			sendError(w, r, http.StatusInternalServerError, chatNotSavedText)
			return
		}
		sendJSON(w, r, http.StatusCreated, c.out(m))
	})
}

// cleanPhoto writes a copy of the JPEG at `path` next to it, cut at the end of
// the image. keepGPS false (a picture of a person or a group): its position is
// blanked too, the way a public link does it (exifstrip.go). A file that is
// not a JPEG this can walk is refused.
func cleanPhoto(path, dir string, keepGPS bool) (string, error) {
	src, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return "", err
	}
	reader, err := cleanJPEG(path, src, info)
	if err != nil {
		return "", err
	}
	if keepGPS {
		reader.blank = nil // only the tail goes
	}
	out, err := os.CreateTemp(dir, ".jpg-*")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, reader); err != nil {
		out.Close()
		os.Remove(out.Name())
		return "", err
	}
	if err := out.Close(); err != nil {
		os.Remove(out.Name())
		return "", err
	}
	return out.Name(), nil
}

// photoPos is where the JPEG at `path` was taken (its Exif GPS), or nil when
// it does not say.
func photoPos(path string) *ChatLoc {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	meta, err := readJPEGMeta(f, info.Size())
	if err != nil || !meta.HasGPS {
		return nil
	}
	return &ChatLoc{Lat: meta.Lat, Lon: meta.Lon, Acc: meta.Acc}
}

// chatFwdFile is a forwarded attachment copied before the lock (OL1): a temp
// in the owner's chat folder, which takes its name under media/ once the
// message is made.
type chatFwdFile struct {
	tmp   string // the copy, in `dir`
	dir   string // the owner's chat folder (chatOwner.dir)
	owner string
	n     int64
	ref   ChatFileRef // the original's, as copied: chatSend refuses a changed one
}

// chatFwdCopy copies the file of the message `req` forwards, with no lock
// held: past its cache the quota is a walk of the whole home, and the copy is
// up to 25 MB - every chat would wait on both (OL1). nil, true: there is no
// file to copy (or a refusal chatSend gives under the lock); false: answered.
// The caller removes the temp.
func (s *Server) chatFwdCopy(w http.ResponseWriter, r *http.Request, in func(func(chatActor, *chatConv)), req chatSendReq) (*chatFwdFile, bool) {
	h := s.chat
	var file *os.File
	var fwd chatFwdFile
	reached, answered := false, false
	// 1. The file to copy (under the lock; a kept photo moved in the owner's
	// files is looked for outside it, inKept).
	h.inKept(in, func(a chatActor, c *chatConv) string {
		if !a.o.isMember(req.FwdConv, a.pid) {
			return ""
		}
		src := h.conv(a.o, req.FwdConv)
		return h.keptWalk(a.o, src, src.byID[req.FwdID], true)
	}, func(a chatActor, c *chatConv) {
		reached = true
		if _, dup := c.cids[a.pid+"|"+req.CID]; dup && req.CID != "" {
			return // sent already: chatSend answers it
		}
		if !a.o.isMember(req.FwdConv, a.pid) {
			return
		}
		src := h.conv(a.o, req.FwdConv)
		orig := src.byID[req.FwdID]
		if orig == nil || orig.Deleted || orig.Kind == "call" || orig.File == nil {
			return
		}
		// The per-minute count here, as an upload: a sender past it causes
		// no copy (chatSend does not count this message again).
		if !a.o.allowSend(a.pid) {
			answered = true
			sendError(w, r, http.StatusTooManyRequests, "demasiados mensajes seguidos")
			return
		}
		f, info, err := h.openMedia(a.o, src, orig)
		if err != nil {
			answered = true
			sendError(w, r, http.StatusGone, "ese fichero ya no está")
			return
		}
		// A copy is an upload: the same daily allowance and quota.
		if !a.o.allowBytes(a.pid, info.Size()) {
			f.Close()
			answered = true
			sendError(w, r, http.StatusTooManyRequests, "demasiados envíos seguidos")
			return
		}
		file, fwd.dir, fwd.owner, fwd.n, fwd.ref = f, a.o.dir, a.o.user, info.Size(), *orig.File
	})
	if !reached || answered {
		return nil, false
	}
	if file == nil {
		return nil, true
	}
	defer file.Close()
	traced(h, "fwd-copy", int(fwd.n)) // tests: h.mu is free from here

	// 2. The quota and the copy (no lock). The temp goes in the owner's chat
	// folder, there already: no folder is made here for a chat or an owner
	// deleted meanwhile (L2) - chatSend makes media/ under the lock.
	if left, limited := h.users.QuotaLeft(fwd.owner); limited && fwd.n > left {
		sendError(w, r, http.StatusInsufficientStorage, "no queda espacio")
		return nil, false
	}
	tmp, err := os.CreateTemp(fwd.dir, ".fw-*")
	if err != nil {
		sendError(w, r, http.StatusGone, "ese fichero ya no está")
		return nil, false
	}
	fwd.tmp = tmp.Name()
	n, err := io.Copy(tmp, file)
	if err == nil {
		err = tmp.Sync() // on disk before it takes its name (J5)
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(fwd.tmp)
		sendError(w, r, http.StatusGone, "ese fichero ya no está")
		return nil, false
	}
	fwd.n = n
	return &fwd, true
}

// chatKeep makes a photo of the chat one of the owner's own files too - in
// their Photos folder, `dir` - as a hard link of the chat's (J4: no move; the
// chat keeps its own name for it). Deleting the message (by hand, or by age)
// no longer loses the photo. Kept already: where it is now. Caller holds h.mu.
func (s *Server) chatKeep(w http.ResponseWriter, r *http.Request, a chatActor, c *chatConv, id int64, dir string) {
	h := s.chat
	m := c.byID[id]
	if m == nil || m.Deleted || m.Kind != "photo" || m.File == nil {
		sendError(w, r, http.StatusNotFound, "esa foto ya no existe")
		return
	}
	if c.st.Kept[id] != "" {
		// Where it is NOW, checked by its inode: the editor and "Abrir en
		// Fotos" open that path, and it must be this photo - never another
		// file saved at its old path since (J4, J1).
		if rel, file, _ := h.keptFile(a.o, c, id); file != nil {
			file.Close()
			sendJSON(w, r, http.StatusOK, map[string]any{"path": rel, "msg": c.out(m)})
			return
		}
		if _, err := os.Lstat(filepath.Join(c.dir, "media", mediaName(m))); err != nil {
			// Neither in their files nor in the chat (kept by an older
			// server, then binned): the link stays - a restore from the bin
			// brings the photo back.
			sendError(w, r, http.StatusGone, "esa foto ya no está")
			return
		}
		// In none of their files any more (binned, deleted, replaced), but
		// the chat has its own: no longer "kept" - the page offers Copiar
		// again (and asks for the folder).
		h.forgetKept(c, id)
		a.o.bump(c, m)
		h.saveMonth(c, m)
		sendJSON(w, r, http.StatusGone, map[string]any{"error": "esa foto ya no está en tus archivos", "msg": c.out(m)})
		return
	}
	parts := splitPath(dir)
	if len(parts) == 0 || parts[0] != "files" {
		sendError(w, r, http.StatusBadRequest, "carpeta no válida")
		return
	}
	dir = strings.Join(parts, "/")
	folder, ok := h.users.Resolve("user", a.o.user, dir)
	if !ok || !folder.Writable {
		sendError(w, r, http.StatusForbidden, "no permitido")
		return
	}
	if info, err := folder.Stat(); err != nil {
		sendMissing(w, r, err, "esa carpeta no existe") // 503 when the home moved under the request
		return
	} else if !info.IsDir() {
		sendError(w, r, http.StatusNotFound, "esa carpeta no existe")
		return
	}
	src, ok := h.users.Resolve("user", a.o.user, "data/chat/conv/"+c.id+"/media/"+mediaName(m))
	if !ok || !src.Exists() {
		sendError(w, r, http.StatusGone, "esa foto ya no está")
		return
	}
	// Its own name, "(2)" and on when the folder has one already. Never over
	// a file: one saved there between a "free?" look and a plain rename was
	// replaced (D10) - a link refuses a taken name, and the next one is tried.
	name := keptName(m.File.Name)
	base, ext := strings.TrimSuffix(name, filepath.Ext(name)), filepath.Ext(name)
	var dst Resolved
	var copied int64
	name, err := claimName(base, ext, 2, 999, func(name string) error {
		dst = folder.at(filepath.Join(folder.Rel, name))
		n, err := linkNoReplace(src, dst, keptID{})
		if err == nil {
			copied = n
		}
		return err
	})
	if errors.Is(err, fs.ErrExist) {
		sendError(w, r, http.StatusConflict, "demasiadas fotos con ese nombre")
		return
	}
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo copiar")
		return
	}
	if copied > 0 {
		h.users.AdjustUsage(a.o.user, copied) // a copy (a disk with no links)
	}
	// Its new name durable before the message points there (K1). The file is
	// there either way, so the message must know it: a failure is only logged.
	if err := syncDir(filepath.Dir(dst.Abs)); err != nil {
		h.log.Error("chat: a kept photo's folder could not be synced", "file", dst.Abs, "err", err)
	}
	var ino keptID
	if info, err := dst.Stat(); err == nil {
		ino = keptIDOf(info)
	}
	h.setKept(c, id, dir+"/"+name, ino)
	a.o.bump(c, m)
	h.saveMonth(c, m)
	sendJSON(w, r, http.StatusOK, map[string]any{"path": c.st.Kept[id], "msg": c.out(m)})
}

// chatEdited points a kept photo's message at the owner's edit of it - a NEW
// file of theirs, `req.Ref`, that the page saved beside the photo, never over
// a name (J1: "Editar" never writes over the photo, which may be the camera
// original in their library). From now on the message shows the edit, to
// everybody; the photo it showed stays in the owner's files, untouched.
// Caller holds h.mu.
func (s *Server) chatEdited(w http.ResponseWriter, r *http.Request, a chatActor, c *chatConv, id int64, req chatSendReq) {
	h := s.chat
	m := c.byID[id]
	if m == nil || m.Deleted || m.Kind != "photo" || m.File == nil {
		sendError(w, r, http.StatusNotFound, "esa foto ya no existe")
		return
	}
	// The photo shown now must be safe in the owner's files before media/
	// takes the edit - else the edit would replace its only copy.
	was, file, _ := h.keptFile(a.o, c, id)
	if file == nil {
		sendError(w, r, http.StatusConflict, "copia antes la foto a tus archivos")
		return
	}
	file.Close()
	ref, rel, ino, status, msg := s.chatLinkPhoto(a, req)
	if ref == nil {
		sendError(w, r, status, msg)
		return
	}
	if rel != was || ino != c.st.KeptID[id] {
		wasID, wasFile := c.st.KeptID[id], *m.File
		n, err := h.keepBytes(a.o, c, m, rel, ino)
		if err != nil {
			sendError(w, r, http.StatusConflict, "esa foto acaba de cambiar; inténtalo otra vez")
			return
		}
		if n > 0 {
			h.users.AdjustUsage(a.o.user, n) // a copy (a disk with no links)
		}
		h.setKept(c, id, rel, ino)
		m.File.Name, m.File.Size, m.File.W, m.File.H, m.File.Pos = ref.Name, ref.Size, ref.W, ref.H, ref.Pos
		a.o.bump(c, m) // a new rev: every page asks for the photo again
		if err := h.saveMonth(c, m); err != nil {
			// Not on disk: never answered "done" (J5). The message goes back
			// to the photo it showed - safe in their files, checked above -
			// as a restart would bring it back; the edit stays a file of theirs.
			h.log.Error("chat: an edited photo's message could not be saved - not changed", "user", a.o.user, "conv", c.id, "id", id, "err", err)
			*m.File = wasFile
			h.setKept(c, id, was, wasID)
			if _, err := h.keepBytes(a.o, c, m, was, wasID); err != nil {
				h.log.Error("chat: the photo a message showed could not be put back under media/", "user", a.o.user, "conv", c.id, "id", id, "err", err)
			}
			a.o.bump(c, m)
			h.saveState(c) // its kept link as it was, should the state have landed
			sendError(w, r, http.StatusInternalServerError, chatNotSavedText)
			return
		}
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"path": rel, "msg": c.out(m)})
}

// keptName is the name a kept photo gets in the owner's files: the one it was
// sent with, as a .jpg (every chat photo is a JPEG).
func keptName(name string) string {
	name = cleanFileName(name)
	if strings.HasPrefix(name, ".") {
		name = "foto" + name
	}
	low := strings.ToLower(name)
	if !strings.HasSuffix(low, ".jpg") && !strings.HasSuffix(low, ".jpeg") {
		name = strings.TrimSuffix(name, filepath.Ext(name)) + ".jpg"
	}
	return name
}

// inKept runs `fn` like `in`. When a kept photo was moved in the owner's files
// and must be looked for - `walk` (under h.mu) names the home - the walk is
// made with the lock let go (OL2), and `fn` runs under it again on what is
// there then: the person, the chat and the message are all looked up anew.
func (h *ChatHub) inKept(in func(func(chatActor, *chatConv)), walk func(chatActor, *chatConv) string, fn func(chatActor, *chatConv)) {
	home := ""
	in(func(a chatActor, c *chatConv) {
		if home = walk(a, c); home == "" {
			fn(a, c)
		}
	})
	if home != "" {
		traced(h, "kept-walk", 0) // tests: h.mu is free here
		refreshKeptIndex(home)
		in(fn)
	}
}

// chatMedia sends a message's photo (shown in the page) or file (always a
// download: a file sent by a stranger never RUNS on this origin).
func (s *Server) chatMedia(w http.ResponseWriter, r *http.Request, id int64, in func(func(chatActor, *chatConv))) {
	var file *os.File
	var info os.FileInfo
	var ref ChatFileRef
	var kind, owner string
	kept := false
	s.chat.inKept(in, func(a chatActor, c *chatConv) string {
		return s.chat.keptWalk(a.o, c, c.byID[id], true)
	}, func(a chatActor, c *chatConv) {
		m := c.byID[id]
		if m == nil || m.Deleted || m.File == nil {
			sendError(w, r, http.StatusNotFound, "no existe")
			return
		}
		f, fi, err := s.chat.openMedia(a.o, c, m)
		if err != nil {
			sendError(w, r, http.StatusNotFound, "no existe")
			return
		}
		file, info, ref, kind, kept, owner = f, fi, *m.File, m.Kind, c.st.Kept[id] != "", a.o.user
	})
	if file == nil {
		return
	}
	defer file.Close()
	// ?thumb=1, the bubble: a kept photo may be a whole camera original, so
	// the thumbnail Photos made of it goes instead, when there is one.
	if kept && kind == "photo" && queryValue(r, "thumb") == "1" {
		dir := filepath.Join(s.cfg.HomesDir, owner, "data", "photos", "thumbs")
		if t, ti, err := openInside(dir, thumbName(info.Size(), info.ModTime().Unix())); err == nil {
			defer t.Close()
			w.Header().Set("Cache-Control", "private, no-cache")
			serveImage(w, r, t, "image/jpeg", ti)
			return
		}
	}
	// A kept photo is the owner's file: it can be edited, so it is checked
	// again every time (a 304 when it has not changed).
	if kept {
		w.Header().Set("Cache-Control", "private, no-cache")
	} else {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	}
	if kind == "photo" && queryValue(r, "dl") != "1" {
		serveImage(w, r, file, "image/jpeg", info)
		return
	}
	w.Header().Set("Content-Disposition", attachmentHeader(ref.Name))
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", info.ModTime(), file)
}

// attachmentHeader is Content-Disposition for a download named `name`.
func attachmentHeader(name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	return `attachment; filename="` + ascii + `"; filename*=UTF-8''` + url.PathEscape(name)
}

// -----------------------------------------------------------------------------
// the pages behind a link
// -----------------------------------------------------------------------------

func (s *Server) chatGuestRedirect(w http.ResponseWriter, r *http.Request) {
	publicHeaders(w)
	redirect(w, http.StatusFound, "/c/"+url.PathEscape(r.PathValue("token"))+"/")
}

func (s *Server) chatGuestPage(w http.ResponseWriter, r *http.Request) {
	publicHeaders(w)
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		sendText(w, r, http.StatusMethodNotAllowed, "Method not allowed.\n")
		return
	}
	token := r.PathValue("token")
	s.chat.mu.Lock()
	owner, live := "", false
	if o, _ := s.chat.byToken(token); o != nil {
		owner, live = o.data.Me.Name, true
	}
	s.chat.mu.Unlock()

	switch r.PathValue("rest") {
	case "":
		body, err := s.static.read(guestPagePath)
		if err != nil {
			sendText(w, r, http.StatusNotFound, "Not found.\n")
			return
		}
		name := owner
		if name == "" {
			name = "Nayive"
		}
		page := strings.ReplaceAll(string(body), "{{OWNER}}", html.EscapeString(name))
		status := http.StatusOK
		if !live {
			status = http.StatusNotFound // the page still says why, in the visitor's language
		}
		sendBytes(w, r, status, "text/html; charset=utf-8", []byte(page))

	case "manifest.webmanifest":
		if !live {
			sendText(w, r, http.StatusNotFound, "Not found.\n")
			return
		}
		scope := "/c/" + token + "/"
		manifest := map[string]any{
			"id": scope, "start_url": scope, "scope": scope,
			"name": owner, "short_name": owner,
			"display": "standalone", "background_color": "#1E1F23", "theme_color": "#1E1F23",
			"icons": []map[string]string{
				{"src": URLPrefix + "/chat/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
				{"src": URLPrefix + "/chat/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
				{"src": URLPrefix + "/chat/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
			},
		}
		raw, _ := json.Marshal(manifest)
		sendBytes(w, r, http.StatusOK, "application/manifest+json", raw)

	case "sw.js":
		body, err := s.static.read(guestWorkerPath)
		if err != nil || !live {
			sendText(w, r, http.StatusNotFound, "Not found.\n")
			return
		}
		sendBytes(w, r, http.StatusOK, "application/javascript; charset=utf-8", body)

	default:
		sendText(w, r, http.StatusNotFound, "Not found.\n")
	}
}
