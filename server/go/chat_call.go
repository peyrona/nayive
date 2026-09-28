package main

// =============================================================================
// Chat calls - voice and video between the owner and ONE person.
// =============================================================================
//
// The sound and the picture go browser to browser (WebRTC, always encrypted).
// This server only carries the setup - the caller's offer, the answer, a
// mute state: "signals" - and hands out short-lived passwords for coturn, the
// relay that carries the (still encrypted) packets when the two browsers
// cannot reach each other directly, which on mobile data is most of the time.
//
// A call lives in memory only: ringing -> active -> ended.
//
//	POST conv/d-<person>/call  rings every open page of the other side (their
//	                           wait says so) and every device with notifications
//	POST call/<id>/answer      the first page to answer binds the call; the
//	                           others see "active, not mine" and stop ringing
//	POST call/<id>/sig         one signal to the other side's bound page
//	POST call/<id>/end         hangup | decline | cancel | fail
//
// Nobody answers in chatCallRing, the caller's page vanishes while it rings, or
// a side's page is not seen for chatCallLost while talking: callTick ends it.
// An ended call stays chatCallKeep, so a late page can still say why (Declined,
// Busy...). The chat keeps a "call" bubble (ChatMsg.Call): how long it lasted,
// or missed / declined / busy / failed.
//
// DEVICES. A page makes up an id when it loads (dev) and sends it on every
// wait. Signals are addressed to a device, so the owner's second tab never
// reads the answer meant for the first one. A device is "seen" while its wait
// is open, and until chatCallLost after its last one.
//
// TURN. coturn runs with use-auth-secret: the password for user
// "<expiry>:<name>" is base64(HMAC-SHA1(secret, user)) - what every TURN server
// calls "REST API credentials". The secret is config/turn_secret, beside
// vapid.json; the servers are server.json's turn_uris. Either one missing: no
// calls, and the pages show no call buttons.
//
// Only 1:1 chats (d-<person>): a group call needs a media server.

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Timeouts are vars, not consts, so the tests can shorten them.
var (
	chatCallRing = 45 * time.Second // ringing with no answer: missed
	chatCallLost = 60 * time.Second // a side's page not seen this long: the call is over
	chatCallKeep = 60 * time.Second // an ended call stays visible this long
	chatCallSigs = 60 * time.Second // a signal nobody picked up is dropped after this
)

const (
	chatCallTurnTTL   = 12 * 60 * 60 // seconds a TURN password lasts
	chatCallSigMax    = 16 << 10     // bytes in one signal (an offer is ~3-6 KB)
	chatCallSigQueue  = 50           // signals waiting for one call
	chatCallStartsMin = 3            // calls a person may start per minute
	chatCallSigsMin   = 60           // signals a person may send per minute
)

type chatCall struct {
	ID       string
	Conv     string
	From, To string // participants: who calls, who is called
	Video    bool
	State    string // ringing | active | ended
	Reason   string // how it ended: hangup | decline | cancel | noanswer | busy | fail | lost
	FromDev  string // the caller's page
	ToDev    string // the page that answered
	Rang     time.Time
	Answered time.Time
	Ended    time.Time
}

type chatSig struct {
	Seq  int64           `json:"seq"`
	Call string          `json:"call"`
	Data json.RawMessage `json:"data"`
	to   string          // the device it is for
	at   time.Time
}

// chatCalls is one owner's calls, signals and devices. Caller holds h.mu.
type chatCalls struct {
	byID   map[string]*chatCall
	sigs   []*chatSig
	seq    int64
	waits  map[string]int         // device -> open waits
	seen   map[string]time.Time   // device -> last seen
	starts map[string][]time.Time // a person's recent calls (rate limit)
	sent   map[string][]time.Time // a person's recent signals (rate limit)
}

func (o *chatOwner) cs() *chatCalls {
	if o.calls == nil {
		o.calls = &chatCalls{
			byID:   make(map[string]*chatCall),
			waits:  make(map[string]int),
			seen:   make(map[string]time.Time),
			starts: make(map[string][]time.Time),
			sent:   make(map[string][]time.Time),
		}
	}
	return o.calls
}

// validDev: a page's made-up id - short, URL-safe.
func validDev(d string) bool {
	if len(d) < 8 || len(d) > 40 {
		return false
	}
	for _, r := range d {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func (cs *chatCalls) touch(dev string, now time.Time) { cs.seen[dev] = now }

func (cs *chatCalls) waitStart(dev string) { cs.waits[dev]++ }

func (cs *chatCalls) waitEnd(dev string, now time.Time) {
	if cs.waits[dev] > 0 {
		cs.waits[dev]--
	}
	cs.seen[dev] = now
}

func (cs *chatCalls) alive(dev string, now time.Time) bool {
	return cs.waits[dev] > 0 || now.Sub(cs.seen[dev]) < chatCallLost
}

// live is `pid`'s call that is ringing or talking, or nil.
func (cs *chatCalls) live(pid string) *chatCall {
	for _, c := range cs.byID {
		if c.State != "ended" && (c.From == pid || c.To == pid) {
			return c
		}
	}
	return nil
}

// allow is a sliding one-minute window; the owner is never limited.
func allowIn(m map[string][]time.Time, pid string, per int, now time.Time) bool {
	if pid == "o" {
		return true
	}
	keep := m[pid][:0]
	for _, t := range m[pid] {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	if len(keep) >= per {
		m[pid] = keep
		return false
	}
	m[pid] = append(keep, now)
	return true
}

// pending: a signal for `dev` newer than `s` is waiting (the wait must not block).
func (cs *chatCalls) pending(dev string, s int64) bool {
	for _, g := range cs.sigs {
		if g.to == dev && g.Seq > s {
			return true
		}
	}
	return false
}

// ack drops what `dev` says it has already read.
func (cs *chatCalls) ack(dev string, s int64) {
	keep := cs.sigs[:0]
	for _, g := range cs.sigs {
		if !(g.to == dev && g.Seq <= s) {
			keep = append(keep, g)
		}
	}
	cs.sigs = keep
}

func (cs *chatCalls) sigsFor(dev string, s int64) []*chatSig {
	out := []*chatSig{}
	for _, g := range cs.sigs {
		if g.to == dev && g.Seq > s {
			out = append(out, g)
		}
	}
	return out
}

type chatCallOut struct {
	ID       string `json:"id"`
	Conv     string `json:"conv"`
	From     string `json:"from"`
	To       string `json:"to"`
	Video    bool   `json:"video,omitempty"`
	State    string `json:"state"`
	Reason   string `json:"reason,omitempty"`
	Mine     bool   `json:"mine,omitempty"` // this page is the one talking (or calling)
	Answered int64  `json:"answered,omitempty"`
}

// callsFor are the calls `pid` is a side of, as page `dev` sees them.
func (cs *chatCalls) callsFor(pid, dev string) []chatCallOut {
	out := []chatCallOut{}
	for _, c := range cs.byID {
		if c.From != pid && c.To != pid {
			continue
		}
		o := chatCallOut{ID: c.ID, Conv: c.Conv, From: c.From, To: c.To, Video: c.Video, State: c.State, Reason: c.Reason}
		o.Mine = dev != "" && ((c.From == pid && c.FromDev == dev) || (c.To == pid && c.ToDev == dev))
		if !c.Answered.IsZero() {
			o.Answered = c.Answered.UnixMilli()
		}
		out = append(out, o)
	}
	return out
}

// -----------------------------------------------------------------------------
// TURN
// -----------------------------------------------------------------------------

type chatTurn struct {
	stun   []string
	turn   []string
	secret []byte
}

// turnConf reads turn_uris and config/turn_secret once.
func (h *ChatHub) turnConf() *chatTurn {
	h.turnOnce.Do(func() {
		var uris []string
		h.cfg.Read(func(c *ServerConfig) { uris = append([]string(nil), c.TurnURIs...) })
		if len(uris) == 0 {
			return
		}
		raw, err := os.ReadFile(filepath.Join(h.cfg.ConfigDir, "turn_secret"))
		secret := strings.TrimSpace(string(raw))
		if err != nil || secret == "" {
			h.log.Error("chat calls OFF: turn_uris is set but config/turn_secret cannot be read", "err", err)
			return
		}
		t := chatTurn{secret: []byte(secret)}
		for _, u := range uris {
			switch {
			case strings.HasPrefix(u, "stun:"):
				t.stun = append(t.stun, u)
			case strings.HasPrefix(u, "turn:"), strings.HasPrefix(u, "turns:"):
				t.turn = append(t.turn, u)
			}
		}
		if len(t.turn) == 0 {
			h.log.Error("chat calls OFF: turn_uris has no turn: address")
			return
		}
		h.turn = t
	})
	return &h.turn
}

func (h *ChatHub) callsOn() bool { return len(h.turnConf().turn) > 0 }

// turnPassword is coturn's use-auth-secret password for `user`.
func turnPassword(secret []byte, user string) string {
	mac := hmac.New(sha1.New, secret)
	mac.Write([]byte(user))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// iceFor is what RTCPeerConnection takes as iceServers - a fresh password for
// every call, so a long call never outlives it.
func (h *ChatHub) iceFor(now time.Time) []map[string]any {
	t := h.turnConf()
	user := strconv.FormatInt(now.Unix()+chatCallTurnTTL, 10) + ":nayive"
	out := []map[string]any{}
	if len(t.stun) > 0 {
		out = append(out, map[string]any{"urls": t.stun})
	}
	out = append(out, map[string]any{"urls": t.turn, "username": user, "credential": turnPassword(t.secret, user)})
	return out
}

// -----------------------------------------------------------------------------
// the routes
// -----------------------------------------------------------------------------

// chatCallStart: POST conv/<c>/call {"video","dev"}.
func (s *Server) chatCallStart(w http.ResponseWriter, r *http.Request, conv string, resolve func(func(chatActor))) {
	var body struct {
		Video bool   `json:"video"`
		Dev   string `json:"dev"`
	}
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}
	if !validDev(body.Dev) {
		sendError(w, r, http.StatusBadRequest, "falta el dispositivo")
		return
	}
	h := s.chat
	var jobs []chatCallPush
	resolve(func(a chatActor) {
		if !h.callsOn() {
			sendError(w, r, http.StatusNotFound, "las llamadas no están activadas")
			return
		}
		if !a.o.isMember(conv, a.pid) {
			sendError(w, r, http.StatusForbidden, "no estás en esta conversación")
			return
		}
		if !strings.HasPrefix(conv, "d-") {
			sendError(w, r, http.StatusBadRequest, "solo llamadas de uno a uno")
			return
		}
		peer := "o"
		if a.pid == "o" {
			peer = conv[2:]
		}
		now := time.Now()
		cs := a.o.cs()
		cs.touch(body.Dev, now)
		h.sweepOnce.Do(func() { go h.sweep() })

		// Both called at the same moment: the one already ringing me wins,
		// and this page answers it instead of ringing back.
		for _, c := range cs.byID {
			if c.State == "ringing" && c.Conv == conv && c.From == peer && c.To == a.pid {
				sendJSON(w, r, http.StatusOK, map[string]any{"id": c.ID, "video": c.Video, "incoming": true, "ice": h.iceFor(now)})
				return
			}
		}
		if !allowIn(cs.starts, a.pid, chatCallStartsMin, now) {
			sendError(w, r, http.StatusTooManyRequests, "demasiadas llamadas seguidas")
			return
		}
		if cs.live(a.pid) != nil {
			sendError(w, r, http.StatusConflict, "ya estás en una llamada")
			return
		}
		call := &chatCall{ID: newChatID(), Conv: conv, From: a.pid, To: peer, Video: body.Video,
			State: "ringing", FromDev: body.Dev, Rang: now}
		if cs.live(peer) != nil {
			// They are talking to someone else: the caller hears "busy", the
			// chat keeps a bubble, nothing rings.
			cs.byID[call.ID] = call
			jobs = h.endCall(a.o, call, "busy", now)
			sendJSON(w, r, http.StatusConflict, map[string]any{"error": "ocupado", "id": call.ID, "busy": true})
			return
		}
		cs.byID[call.ID] = call
		a.o.changed(false)
		jobs = h.callPushes(a.o, call, "ring")
		sendJSON(w, r, http.StatusCreated, map[string]any{"id": call.ID, "ice": h.iceFor(now)})
	})
	if len(jobs) > 0 {
		go h.sendCallPushes(jobs)
	}
}

// chatCallAct: POST call/<id>/answer | end | sig.
func (s *Server) chatCallAct(w http.ResponseWriter, r *http.Request, id, act string, resolve func(func(chatActor))) {
	var body struct {
		Dev    string          `json:"dev"`
		Reason string          `json:"reason"`
		Data   json.RawMessage `json:"data"`
	}
	if r.ContentLength > chatCallSigMax+1024 {
		sendError(w, r, http.StatusRequestEntityTooLarge, "señal demasiado grande")
		return
	}
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}
	if act != "answer" && act != "end" && act != "sig" {
		sendError(w, r, http.StatusNotFound, "no such endpoint")
		return
	}
	h := s.chat
	var jobs []chatCallPush
	resolve(func(a chatActor) {
		cs := a.o.cs()
		c := cs.byID[id]
		if c == nil || (c.From != a.pid && c.To != a.pid) {
			sendError(w, r, http.StatusNotFound, "esa llamada ya no existe")
			return
		}
		now := time.Now()
		if validDev(body.Dev) {
			cs.touch(body.Dev, now)
		}
		switch act {
		case "answer":
			if !validDev(body.Dev) {
				sendError(w, r, http.StatusBadRequest, "falta el dispositivo")
				return
			}
			if c.To != a.pid {
				sendError(w, r, http.StatusForbidden, "esta llamada no es para ti")
				return
			}
			if c.State != "ringing" {
				sendJSON(w, r, http.StatusConflict, map[string]any{"error": "la llamada ya no está sonando", "state": c.State, "reason": c.Reason})
				return
			}
			c.State, c.ToDev, c.Answered = "active", body.Dev, now
			a.o.changed(false)
			jobs = h.callPushes(a.o, c, "quiet") // the ringing notification on the other devices
			sendJSON(w, r, http.StatusOK, map[string]any{"id": c.ID, "ice": h.iceFor(now)})

		case "end":
			if c.State == "ended" {
				sendJSON(w, r, http.StatusOK, map[string]any{"state": c.State, "reason": c.Reason})
				return
			}
			reason := "hangup"
			switch {
			case body.Reason == "fail":
				reason = "fail"
			case c.State == "ringing" && a.pid == c.From:
				reason = "cancel"
			case c.State == "ringing":
				reason = "decline"
			}
			jobs = h.endCall(a.o, c, reason, now)
			sendJSON(w, r, http.StatusOK, map[string]any{"state": c.State, "reason": c.Reason})

		case "sig":
			var to string
			switch {
			case c.State != "active":
			case a.pid == c.From && body.Dev == c.FromDev:
				to = c.ToDev
			case a.pid == c.To && body.Dev == c.ToDev:
				to = c.FromDev
			}
			if to == "" {
				sendError(w, r, http.StatusConflict, "esta página no está en la llamada")
				return
			}
			if len(body.Data) == 0 || len(body.Data) > chatCallSigMax {
				sendError(w, r, http.StatusBadRequest, "señal no válida")
				return
			}
			if !allowIn(cs.sent, a.pid, chatCallSigsMin, now) {
				sendError(w, r, http.StatusTooManyRequests, "demasiadas señales seguidas")
				return
			}
			n := 0
			for _, g := range cs.sigs {
				if g.Call == c.ID {
					n++
				}
			}
			if n >= chatCallSigQueue {
				sendError(w, r, http.StatusTooManyRequests, "demasiadas señales sin leer")
				return
			}
			cs.seq++
			cs.sigs = append(cs.sigs, &chatSig{Seq: cs.seq, Call: c.ID, Data: body.Data, to: to, at: now})
			a.o.changed(false)
			w.WriteHeader(http.StatusNoContent)
		}
	})
	traced(h, "call-push", len(jobs)) // tests only (chat.go testHook)
	if len(jobs) > 0 {
		go h.sendCallPushes(jobs)
	}
}

// -----------------------------------------------------------------------------
// ending, timing out, the bubble
// -----------------------------------------------------------------------------

// endCall ends `c`, writes its bubble and returns the pushes to send (after
// the lock). Caller holds h.mu.
func (h *ChatHub) endCall(o *chatOwner, c *chatCall, reason string, now time.Time) []chatCallPush {
	was := c.State
	c.State, c.Reason, c.Ended = "ended", reason, now

	info := &ChatCallInfo{Video: c.Video}
	switch {
	case was == "active":
		info.Secs = max(1, int(now.Sub(c.Answered).Round(time.Second)/time.Second))
	case reason == "decline":
		info.End = "declined"
	case reason == "busy":
		info.End = "busy"
	case reason == "fail":
		info.End = "failed"
	default: // cancel, noanswer, lost - while it rang
		info.End = "missed"
	}
	if o.isMember(c.Conv, c.From) {
		cv := h.conv(o, c.Conv)
		var before int64
		if last := cv.last(); last != nil {
			before = last.ID
		}
		m := &ChatMsg{ID: cv.st.Next, At: nowMs(), From: c.From, Kind: "call", Call: info}
		cv.st.Next = m.ID + 1
		cv.msgs = append(cv.msgs, m)
		cv.byID[m.ID] = m
		cv.st.Read[c.From] = m.ID
		// A call both of them had is not news to either: it must not light
		// the unread badge. A missed one is exactly the news.
		if was == "active" && cv.st.Read[c.To] >= before {
			cv.st.Read[c.To] = m.ID
		}
		o.bump(cv, m)
		h.saveMonth(cv, m)
	}

	keep := o.cs().sigs[:0]
	for _, g := range o.cs().sigs {
		if g.Call != c.ID {
			keep = append(keep, g)
		}
	}
	o.cs().sigs = keep
	o.changed(false)

	if was != "ringing" || reason == "busy" {
		return nil
	}
	if reason == "decline" {
		return h.callPushes(o, c, "quiet")
	}
	return h.callPushes(o, c, "missed")
}

// DeclineCall is "Rechazar" pressed in the Android app (devices.go): the call
// `id` of `owner`'s chat, ringing for `pid`. False when it no longer rings.
func (h *ChatHub) DeclineCall(owner, id, pid string) bool {
	h.mu.Lock()
	o := h.owners[owner]
	if o == nil || o.calls == nil {
		h.mu.Unlock()
		return false
	}
	c := o.cs().byID[id]
	if c == nil || c.State != "ringing" || c.To != pid {
		h.mu.Unlock()
		return false
	}
	jobs := h.endCall(o, c, "decline", time.Now())
	h.mu.Unlock()
	if len(jobs) > 0 {
		go h.sendCallPushes(jobs)
	}
	return true
}

// callTick ends what timed out, forgets old calls and signals. Called by
// sweep under h.mu; returns the pushes to send after the lock.
func (h *ChatHub) callTick(o *chatOwner, now time.Time) []chatCallPush {
	cs := o.calls
	if cs == nil {
		return nil
	}
	var jobs []chatCallPush
	for id, c := range cs.byID {
		switch c.State {
		case "ringing":
			if now.Sub(c.Rang) > chatCallRing {
				jobs = append(jobs, h.endCall(o, c, "noanswer", now)...)
			} else if !cs.alive(c.FromDev, now) {
				jobs = append(jobs, h.endCall(o, c, "cancel", now)...)
			}
		case "active":
			if !cs.alive(c.FromDev, now) || !cs.alive(c.ToDev, now) {
				jobs = append(jobs, h.endCall(o, c, "lost", now)...)
			}
		case "ended":
			if now.Sub(c.Ended) > chatCallKeep {
				delete(cs.byID, id)
				o.changed(false)
			}
		}
	}
	keep := cs.sigs[:0]
	for _, g := range cs.sigs {
		if now.Sub(g.at) < chatCallSigs {
			keep = append(keep, g)
		}
	}
	cs.sigs = keep
	for dev, t := range cs.seen {
		if cs.waits[dev] == 0 && now.Sub(t) > 10*time.Minute {
			delete(cs.seen, dev)
			delete(cs.waits, dev)
		}
	}
	return jobs
}

// -----------------------------------------------------------------------------
// notifications
// -----------------------------------------------------------------------------

type chatCallPush struct {
	user    string // mine: that account; else the owner's (a person's device is pruned from their contact)
	sub     PushSub
	mine    bool   // the device is an account's own (push.json): the owner's, or a Nayive user's
	person  string // else: the person's id
	payload map[string]any
	ttl     int
}

// callPushes are the notifications for the CALLED side's devices. kind: ring
// (it rings), missed (it rang, nobody answered), quiet (it stopped ringing:
// answered or declined - replaces the ringing one without a sound). Mute is
// ignored on purpose: a muted chat still rings, as in WhatsApp. Caller holds h.mu.
func (h *ChatHub) callPushes(o *chatOwner, c *chatCall, kind string) []chatCallPush {
	title := h.nameOf(o, c.From)
	video := map[bool]string{false: "Voice", true: "Video"}[c.Video]
	words := map[string]struct{ key, builtin string }{
		"ringVoice":   {"chat.incomingVoice", "Llamada de voz entrante"},
		"ringVideo":   {"chat.incomingVideo", "Videollamada entrante"},
		"missedVoice": {"chat.missedVoice", "Llamada de voz perdida"},
		"missedVideo": {"chat.missedVideo", "Videollamada perdida"},
		"quietVoice":  {"chat.voiceCall", "Llamada de voz"},
		"quietVideo":  {"chat.videoCall", "Videollamada"},
	}
	var subs []PushSub
	acct := "" // the called side's account: the owner, or a Nayive user
	var ct *ChatContact
	if c.To == "o" {
		acct = o.user
	} else if ct = o.contact(c.To); ct != nil && ct.User != "" {
		acct = ct.User
	} else if ct != nil {
		subs = ct.Subs
	}
	mine := acct != ""
	if mine {
		subs = h.users.UserPush(acct).Subs
	}
	link := URLPrefix + "/chat/?c=" + c.Conv
	if !mine && ct != nil {
		link = "/c/" + ct.Token + "/?c=" + c.Conv
	}
	if mine && h.onCall != nil {
		// The Android app rings a call to an account itself (devices.go)...
		h.onCall(acct, deviceRing{ID: c.ID, Owner: o.user, Pid: c.To, From: title, Video: c.Video,
			URL: link, Until: c.Rang.Add(chatCallRing).UnixMilli()}, kind)
		// ...so the Chrome inside that phone's app must not ring it again. A
		// missed call still goes through: the app shows no "missed" of its own.
		if kind != "missed" && h.skipPush != nil {
			kept := subs[:0:0]
			for _, sub := range subs {
				if !h.skipPush(acct, sub.Endpoint) {
					kept = append(kept, sub)
				}
			}
			subs = kept
		}
	}
	var jobs []chatCallPush
	for _, sub := range subs {
		say := func(k string) string { w := words[k+video]; return h.phrase(sub.Lang, w.key, w.builtin) }
		p := map[string]any{"title": title, "url": link, "tag": "call-" + c.ID, "kind": "call"}
		ttl := chatPushTTL
		switch kind {
		case "ring":
			p["body"] = say("ring")
			p["late"] = say("missed") // shown instead when it arrives after `until`
			p["until"] = c.Rang.Add(chatCallRing).UnixMilli()
			ttl = int(chatCallRing / time.Second)
		case "missed":
			p["body"] = say("missed")
		default:
			p["body"] = say("quiet")
			p["quiet"] = true
			ttl = int(chatCallRing/time.Second) * 2
		}
		j := chatCallPush{user: o.user, sub: sub, mine: mine, payload: p, ttl: ttl}
		if mine {
			j.user = acct
		} else if ct != nil {
			j.person = ct.ID
		}
		jobs = append(jobs, j)
	}
	return jobs
}

func (h *ChatHub) sendCallPushes(jobs []chatCallPush) {
	for _, j := range jobs {
		if j.mine {
			deliverPush(h.push, h.users, h.log, j.user, j.sub, j.payload, j.ttl)
			continue
		}
		owner, person, endpoint := j.user, j.person, j.sub.Endpoint
		deliverPushTo(h.push, h.log, j.sub, j.payload, j.ttl, func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			if o := h.owners[owner]; o != nil {
				if c := o.contact(person); c != nil && removeSub(c, endpoint) {
					h.saveData(o)
					o.changed(true)
				}
			}
		})
	}
}
