package main

// =============================================================================
// Chat - a small private messenger: a Nayive user and the people they invite.
// =============================================================================
//
// WHO TALKS TO WHOM. Every Nayive user owns one Chat (apps/chat). They add a
// person by name and that person gets a secret link, /c/<token>/ - no account,
// no app to install. A person talks with the owner, and in the groups the owner
// makes; never with another person on their own. A star, not a mesh.
//
// ANOTHER NAYIVE USER is a person too, known by their account instead of a
// link (ChatContact.User, no token). The chat lives in the home of whoever
// started it; the other user reads it from their OWN Chat, through
// /api/chat/via/<that home>/... (api_chat.go), and is notified on their
// account's devices. Only one chat per pair: starting it again from the other
// side opens the same one (chatContacts).
//
// ON DISK, all of it inside the OWNER's home, homes/<owner>/data/chat/:
//
//	chat.json                    the owner's display name, the people, the groups
//	conv/<conv>/YYYY-MM.json     that month's messages (UTC month of sending)
//	conv/<conv>/state.json       rev, next id, read cursors, pins and mutes
//	conv/<conv>/media/<id>.<ext> the photo or file of message <id>
//
// A photo the owner KEPT (Copiar, keep in api_chat.go) is ALSO one of the
// owner's own files - files/<their Photos folder>/<name> - and the message
// knows where (state.json "kept"), so deleting the message never takes it.
// A JPEG the owner sends from their own files is kept from the start (POST
// messages {"ref"}). A kept file is followed by its inode ("keptId") when it
// is renamed or moved.
//
// MEDIA/ ALWAYS HOLDS WHAT THE MESSAGE SHOWS (J4). A kept or linked photo is
// a HARD LINK there of the owner's file - the same bytes, no room taken (a
// copy only on a disk that refuses links). Binning, emptying the bin,
// renaming or replacing the owner's file never takes the photo out of the
// conversation, and a NEW file later saved at that path (cameras reuse
// IMG_0001.jpg) never shows in the old message. "Editar" never writes over
// the owner's file: the edit is a new file of theirs, and the message is
// pointed at it (chatEdited).
//
// AUTO-DELETE. With chat.json "deleteAfter" = N days, every message older
// than that is deleted for good - its photo or file too; a kept photo stays
// in the owner's files (expire, run hourly by RunExpiry and at once when N
// changes). Never on a clock that just jumped forward (expiryClockOK, J8).
//
// LATER. A text scheduled for a time to come (the send button held down ->
// "Schedule message") waits in chat.json "later" - only its sender sees it -
// and RunLater sends it, as its sender, once its time has come. "Send without
// sound" is a flag on the message: its notifications arrive silent.
//
// A conversation is "d-<person>" (the owner and one person) or "g-<group>". A
// participant is "o" (the owner) or a person's id. Months, not one file: only
// the current month is rewritten on each message, and "delete for everyone"
// really erases the text (an append-only log would keep it).
//
// REV. Every change to a conversation - a message, an edit, a delete, a
// reaction, a vote, a read cursor - bumps its `rev` and stamps it on what
// changed, so "everything since rev N" is one question with one answer.
//
// LIVE. A page long-polls GET .../wait?v=N. It returns at once when the owner's
// `version` moved (any change in any of their conversations), else after
// chatWaitMax. A participant with a wait open is "online"; pages drop their
// wait when they go to the background. No sockets, no SSE.
//
// PUSH. A new message is pushed to every other participant who is not online
// and has not muted the conversation. One who LOOKED online (an iPhone app
// suspended mid-wait still looks online for a few seconds) is checked again
// after chatPushRecheck: still unread and gone -> pushed then.
//
// ONE LOCK. Every owner and every conversation sits behind ChatHub.mu. A
// personal server has a handful of writers; one lock is the honest size, and
// it makes every rule here true by construction. Nothing slow runs under it:
// a request body is read BEFORE taking it, pushes are sent AFTER releasing it.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	chatMaxText      = 4000             // runes in one message (or caption)
	chatMaxName      = 60               // runes in a person's or a group's name
	chatMaxMotto     = 100              // runes in the owner's motto (the line under "Chat")
	chatMaxFile      = 25 << 20         // one photo or file, bytes
	chatMaxOpts      = 12               // poll options
	chatPage         = 60               // messages per page when a conversation opens
	chatWaitMax      = 25 * time.Second // a long-poll's longest wait
	chatOnlineGrace  = 12 * time.Second // between two waits a page is still online
	chatTypingFor    = 6 * time.Second  // "escribiendo..." lasts this long after the last key
	chatPushRecheck  = 30 * time.Second
	chatPushTTL      = 24 * 60 * 60
	chatMaxSubs      = 5  // devices per person
	chatGuestPerMin  = 30 // messages a person may send per minute
	chatGuestDayByte = 300 << 20
	chatMaxLater     = 100                  // scheduled texts one sender may have waiting in one home
	chatLaterMax     = 366 * 24 * time.Hour // how far ahead a text may be scheduled
	chatLaterTick    = 20 * time.Second     // how often RunLater looks for texts whose time has come
)

// chatPushHosts are the push services a subscription may point at, a guest's
// and a signed-in user's alike (users.go cleanSub): nobody may make this server
// POST to any URL it likes.
// Chrome's newer endpoints, jmt<digits>.google.com, are matched apart
// (googlePushHost): all of .google.com would take in every open redirect there.
var chatPushHosts = []string{
	"fcm.googleapis.com", "android.googleapis.com", // Chrome, Edge on Android, Samsung, Opera
	".push.apple.com",            // Safari, iPhone
	".push.services.mozilla.com", // Firefox
	".notify.windows.com",        // Edge on Windows
}

// -----------------------------------------------------------------------------
// what is stored
// -----------------------------------------------------------------------------

// ChatContact is one person the owner invited.
type ChatContact struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Token   string    `json:"token,omitempty"`
	User    string    `json:"user,omitempty"` // a Nayive account: no link, their own Chat reads it (via)
	Card    string    `json:"card,omitempty"` // the Contacts app's card they were picked from (its UID)
	Created int64     `json:"created"`
	Opened  int64     `json:"opened,omitempty"` // first time their link was used (unix s)
	Photo   int64     `json:"photo,omitempty"`  // their picture's version (avatars/<id>.jpg); 0 = none
	Subs    []PushSub `json:"subs,omitempty"`   // their devices' notifications
	Deleted bool      `json:"deleted,omitempty"`
}

// ChatGroup is a group the owner made. The owner is always in it.
type ChatGroup struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Members []string `json:"members"`
	Created int64    `json:"created"`
	Photo   int64    `json:"photo,omitempty"` // the group's picture's version; 0 = none
	Deleted bool     `json:"deleted,omitempty"`
	// Left: people taken out of the group who may be put back (an Undo, or
	// later). Their history must still be there when they are: purge counts
	// them as members (J6). A deleted person never comes back (a new one gets
	// a new id), so dropContact takes them off.
	Left []string `json:"left,omitempty"`
}

type chatMe struct {
	Name string `json:"name"`
	// Motto: an optional line the owner writes about themselves. Their own
	// page shows it in small print under the app's icon and name.
	Motto string `json:"motto,omitempty"`
	Photo int64  `json:"photo,omitempty"` // the owner's picture's version (avatars/o.jpg); 0 = none
}

// chatData is chat.json.
type chatData struct {
	Me          chatMe         `json:"me"`
	Contacts    []*ChatContact `json:"contacts"`
	Groups      []*ChatGroup   `json:"groups"`
	DeleteAfter int            `json:"deleteAfter,omitempty"` // days a message lives; 0 = for ever
	Later       []*ChatLater   `json:"later,omitempty"`       // texts waiting for their time (sendDue)
	// Faces: the picture the owner chose for another Nayive account (account ->
	// its version; avatars/u-<account>.jpg). Theirs only, and for ever: it
	// shows wherever the two chat - in this home or in the other's - and
	// stays when that chat is deleted.
	Faces map[string]int64 `json:"faces,omitempty"`
}

// faceKey is the avatar id (and file name, + ".jpg") of the owner's picture
// for a Nayive account. Never a contact's id: those are hex.
func faceKey(user string) string { return "u-" + user }

// ChatLater is a text scheduled by its sender for a time to come. It is not a
// message yet: no id, no rev; nobody but its sender sees it until it goes.
type ChatLater struct {
	ID      string `json:"id"`
	Conv    string `json:"conv"`
	From    string `json:"from"`
	At      int64  `json:"at"` // when it goes, unix ms
	Text    string `json:"text"`
	ReplyTo int64  `json:"replyTo,omitempty"`
	CID     string `json:"cid,omitempty"` // the sender's own id for it: a retry is not a second one
}

// ChatFileRef is the attachment of a photo or file message.
type ChatFileRef struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Ext  string `json:"ext,omitempty"` // the stored file's extension
	W    int    `json:"w,omitempty"`
	H    int    `json:"h,omitempty"`
	// Pos: where a photo was taken, read from its Exif GPS when it arrived;
	// the page's hold menu offers "See on the map" with it.
	Pos *ChatLoc `json:"pos,omitempty"`
}

type ChatLoc struct {
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	Acc   float64 `json:"acc,omitempty"`
	Place string  `json:"place,omitempty"`
}

type ChatCard struct {
	Name   string   `json:"name"`
	Tels   []string `json:"tels,omitempty"`
	Emails []string `json:"emails,omitempty"`
}

type ChatPoll struct {
	Q     string           `json:"q"`
	Opts  []string         `json:"opts"`
	Multi bool             `json:"multi,omitempty"`
	Votes map[string][]int `json:"votes,omitempty"` // participant -> chosen options
}

// ChatCallInfo is a call's bubble (chat_call.go): how long it lasted, or how it
// ended without an answer - End is "" (answered), missed, declined, busy, failed.
type ChatCallInfo struct {
	Video bool   `json:"video,omitempty"`
	Secs  int    `json:"secs,omitempty"`
	End   string `json:"end,omitempty"`
}

// ChatMsg is one message. Kind is text | photo | file | loc | card | poll |
// call (written by the server only, when a call ends).
type ChatMsg struct {
	ID      int64             `json:"id"`
	Rev     int64             `json:"rev"`
	At      int64             `json:"at"` // unix ms
	From    string            `json:"from"`
	Kind    string            `json:"kind"`
	Text    string            `json:"text,omitempty"`
	File    *ChatFileRef      `json:"file,omitempty"`
	Loc     *ChatLoc          `json:"loc,omitempty"`
	Card    *ChatCard         `json:"card,omitempty"`
	Poll    *ChatPoll         `json:"poll,omitempty"`
	Call    *ChatCallInfo     `json:"call,omitempty"`
	ReplyTo int64             `json:"replyTo,omitempty"`
	Fwd     bool              `json:"fwd,omitempty"`
	Edited  int64             `json:"edited,omitempty"`
	Deleted bool              `json:"deleted,omitempty"`
	Reacts  map[string]string `json:"reacts,omitempty"` // participant -> emoji
	CID     string            `json:"cid,omitempty"`    // the sender's own id for it: a retry is not a second message
	Silent  bool              `json:"silent,omitempty"` // "Send without sound": its notifications make none
}

// chatState is conv/<conv>/state.json.
type chatState struct {
	Rev  int64            `json:"rev"`
	Next int64            `json:"next"`
	Read map[string]int64 `json:"read"`
	Pin  map[string]bool  `json:"pin,omitempty"`
	Mute map[string]bool  `json:"mute,omitempty"`
	// Cleared: a participant deleted the chat (for them only, as in WhatsApp)
	// when its last message was this id. Nothing up to it is theirs to see; the
	// chat leaves their list until a newer message arrives. Once EVERY member
	// has cleared past a message, it is purged from the disk (purge).
	Cleared map[string]int64 `json:"cleared,omitempty"`
	// Kept: a photo that is also one of the owner's files (copied there, or
	// sent from there) - message id -> "files/...": where it lives in them.
	// The message shows its own copy under media/ (a hard link of that file);
	// one kept before media/ held it (an older server) shows that file.
	Kept map[int64]string `json:"kept,omitempty"`
	// KeptID: the kept file's inode (fileID) and size - message id -> them.
	// Renamed or moved, the file is found again by both (openMedia): the size
	// too, as a freed inode number can come back on another file. Another
	// file at the kept path is never taken for it (J4).
	KeptID map[int64]keptID `json:"keptId,omitempty"`
	// Gone: every message up to this id was deleted for its age (expire). A
	// page still showing one drops it.
	Gone int64 `json:"gone,omitempty"`
}

type keptID struct {
	Ino  uint64 `json:"ino"`
	Size int64  `json:"size"`
}

// keptIDOf is a file's keptID; zero when this system has no inodes.
func keptIDOf(info os.FileInfo) keptID {
	if ino := fileID(info); ino != 0 {
		return keptID{Ino: ino, Size: info.Size()}
	}
	return keptID{}
}

type chatMonth struct {
	Messages []*ChatMsg `json:"messages"`
}

// -----------------------------------------------------------------------------
// in memory
// -----------------------------------------------------------------------------

type chatConv struct {
	id   string
	dir  string
	st   chatState
	msgs []*ChatMsg // by id
	byID map[int64]*ChatMsg
	cids map[string]int64 // from + "|" + cid -> message id
	// missed: a kept file looked for in the whole home and not found - message
	// id -> when. Not looked for again for a while (chatFindAgain): the walk
	// runs under h.mu, and anyone with the link can ask for that photo.
	missed map[int64]time.Time
	// damaged: the files of this conversation that were there but could not
	// be read or parsed - a month ("2026-03.json"), "state.json", or "" for
	// the folder itself (its months could not even be listed). What loaded is
	// served; NOTHING is written over them (F5): memory holds none of their
	// messages, read cursors or kept links, and a rewrite from memory would
	// erase them for good. Until they read whole again, the conversation
	// takes no change (chatConvRoute's `in`).
	damaged map[string]bool
	// retryAt: when a file that could not be READ (EIO, EMFILE - not one
	// that does not parse) is tried again; zero = nothing to retry.
	retryAt time.Time
}

// isDamaged: some file of this conversation failed to load (see damaged).
func (c *chatConv) isDamaged() bool { return len(c.damaged) > 0 }

// canWrite: `file` ("2026-10.json", "state.json") may be written from memory.
func (c *chatConv) canWrite(file string) bool { return !c.damaged[file] && !c.damaged[""] }

type chatOwner struct {
	user    string
	dir     string
	data    chatData
	convs   map[string]*chatConv
	version int64 // any change at all
	meta    int64 // a change to chat.json (names, people, groups)
	wake    chan struct{}

	waits   map[string]int       // participant -> open waits
	lastEnd map[string]time.Time // participant -> when their last wait ended
	online  map[string]bool
	typing  map[string]map[string]time.Time // conv -> participant -> until

	sent map[string][]time.Time // a person's recent messages (rate limit)
	day  map[string]chatDayUse  // a person's upload bytes today

	calls *chatCalls // voice and video calls (chat_call.go); nil until a page with a device id waits

	notify func() // the hub's onChange (the Android app's waits)

	// damaged: chat.json was there but could not be read or parsed. What
	// loaded is served, but it is never written over (F5) - it holds every
	// person, link, group and scheduled text - and no change is taken
	// (chatRoute's resolve) until it reads whole again.
	damaged bool
	// retryAt: when a chat.json that could not be READ (not one that does
	// not parse) is tried again; zero = nothing to retry.
	retryAt time.Time
}

type chatDayUse struct {
	day   string
	bytes int64
}

type chatTokenRef struct {
	owner, contact string
}

// ChatHub is every owner's chat. One per server.
type ChatHub struct {
	mu      sync.Mutex
	cfg     *Config
	users   *Users
	push    *VapidStore
	log     Logger
	owners  map[string]*chatOwner
	tokens  map[string]chatTokenRef   // sha256(token) -> whose
	links   map[string][]chatTokenRef // a Nayive account -> the homes holding them as a contact
	indexed bool

	wordsMu sync.Mutex
	words   *phrasebook

	closing   chan struct{}
	closeOnce sync.Once
	sweepOnce sync.Once

	turnOnce sync.Once
	turn     chatTurn // coturn for calls (chat_call.go), read on first use

	// The Android app's hooks (devices.go), set once at start; nil in tests.
	// Both are called under h.mu and take nothing but their own lock.
	onChange func()                                             // any change: the phones' waits re-check
	onCall   func(account string, ring deviceRing, kind string) // a call to an account: ring | missed | quiet
	skipPush func(account, endpoint string) bool                // that Chrome's phone rings the call itself

	laterRead bool // every home's scheduled texts are in memory (sendDue)

	// The clock auto-delete believes (expiryClockOK, J8): the last pass, the
	// doubt and the last look, as on disk (read once); the last look again
	// with this run's monotonic time (zero: not seen by this run).
	clockRead bool
	clock     chatClockDisk
	clockSeen time.Time
}

func NewChatHub(cfg *Config, users *Users, push *VapidStore, log Logger) *ChatHub {
	return &ChatHub{
		cfg:     cfg,
		users:   users,
		push:    push,
		log:     log,
		owners:  make(map[string]*chatOwner),
		tokens:  make(map[string]chatTokenRef),
		links:   make(map[string][]chatTokenRef),
		words:   newPhrasebook(cfg.AppsDir),
		closing: make(chan struct{}),
	}
}

// Close ends every open wait: a shutdown must not sit out 25-second polls.
func (h *ChatHub) Close() {
	h.closeOnce.Do(func() { close(h.closing) })
}

func (h *ChatHub) resetIndex() {
	h.indexed = false
	h.laterRead = false // a home dropped from memory may hold scheduled texts
	h.tokens = make(map[string]chatTokenRef)
	h.links = make(map[string][]chatTokenRef)
}

// RenameUser follows an account the admin renamed: its own chat is read again
// under the new name, and every other home that holds it as a contact now
// points at the new name - the picture a home chose for it too.
func (h *ChatHub) RenameUser(old, name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.owners, old)
	h.resetIndex()
	h.eachOwner(func(o *chatOwner) {
		moved := false
		for _, c := range o.data.Contacts {
			if c.User == old {
				c.User, moved = name, true
			}
		}
		if v, ok := o.data.Faces[old]; ok { // the picture chosen for them follows
			dir := filepath.Join(o.dir, "avatars")
			os.Rename(filepath.Join(dir, faceKey(old)+".jpg"), filepath.Join(dir, faceKey(name)+".jpg"))
			delete(o.data.Faces, old)
			o.data.Faces[name] = v
			moved = true
		}
		if moved {
			h.saveData(o)
			o.changed(true)
		}
	})
}

// DeleteUser follows an account the admin deleted: every other home that held
// it as a contact deletes that contact, as the owner's "delete person" would,
// and the picture it chose for that account.
func (h *ChatHub) DeleteUser(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.owners, name)
	h.resetIndex()
	h.eachOwner(func(o *chatOwner) {
		moved := false
		for _, c := range o.data.Contacts {
			if c.User == name && !c.Deleted {
				h.dropContact(o, c)
				moved = true
			}
		}
		if _, ok := o.data.Faces[name]; ok {
			os.Remove(filepath.Join(o.dir, "avatars", faceKey(name)+".jpg"))
			delete(o.data.Faces, name)
			moved = true
		}
		if moved {
			h.saveData(o)
			o.changed(true)
		}
	})
}

// eachOwner runs `fn` on every home that has a chat, reading it if needed.
// Caller holds h.mu.
func (h *ChatHub) eachOwner(fn func(o *chatOwner)) {
	entries, err := os.ReadDir(h.cfg.HomesDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !ValidUsername(e.Name()) {
			continue
		}
		if _, err := os.Stat(filepath.Join(h.chatDir(e.Name()), "chat.json")); err != nil {
			continue
		}
		if o := h.owner(e.Name()); o != nil {
			fn(o)
		}
	}
}

// dropContact deletes a person: their link dies, their devices and picture go,
// they leave every group. Their messages stay. Caller holds h.mu and saves.
func (h *ChatHub) dropContact(o *chatOwner, c *ChatContact) {
	h.ensureIndex()
	if c.Token != "" {
		delete(h.tokens, tokenKey(c.Token))
	}
	c.Deleted, c.Token, c.Subs = true, "", nil
	if c.Photo > 0 {
		os.Remove(filepath.Join(o.dir, "avatars", c.ID+".jpg"))
		c.Photo = 0
	}
	for _, g := range o.data.Groups {
		g.Members = without(g.Members, c.ID)
		g.Left = without(g.Left, c.ID) // never back: no history to keep for them (J6)
	}
	if c.User != "" {
		// Their own Chat drops this home at once (its "via" list moved).
		if other := h.owners[c.User]; other != nil {
			other.changed(true)
		}
	}
}

func tokenKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newChatID() string {
	raw := make([]byte, 5)
	rand.Read(raw)
	return hex.EncodeToString(raw)
}

func nowMs() int64 { return time.Now().UnixMilli() }

// -----------------------------------------------------------------------------
// loading and saving (caller holds h.mu)
// -----------------------------------------------------------------------------

func (h *ChatHub) chatDir(user string) string {
	return filepath.Join(h.cfg.HomesDir, user, "data", "chat")
}

// owner is `user`'s chat, read from disk the first time. Nil when the account
// has no home.
func (h *ChatHub) owner(user string) *chatOwner {
	if o, ok := h.owners[user]; ok {
		if !o.retryAt.IsZero() && !time.Now().Before(o.retryAt) {
			h.loadData(o, false) // a read that failed may work now
		}
		return o
	}
	if user == "" || !ValidUsername(user) {
		return nil
	}
	if info, err := os.Stat(filepath.Join(h.cfg.HomesDir, user)); err != nil || !info.IsDir() {
		return nil
	}
	o := &chatOwner{
		user:    user,
		dir:     h.chatDir(user),
		convs:   make(map[string]*chatConv),
		wake:    make(chan struct{}),
		notify:  h.changedHook,
		waits:   make(map[string]int),
		lastEnd: make(map[string]time.Time),
		online:  make(map[string]bool),
		typing:  make(map[string]map[string]time.Time),
		sent:    make(map[string][]time.Time),
		day:     make(map[string]chatDayUse),
	}
	h.loadData(o, true)
	h.owners[user] = o
	return o
}

// loadData reads the owner's chat.json. One that cannot be read or parsed
// marks the owner damaged (F5); on the first read what loaded is kept and
// served. A READ error (EIO, EMFILE...) is tried again after
// damagedRetryEvery - on a retry only a whole read replaces what memory has,
// and the links are indexed again. One that does not parse waits for a
// repair and a restart. Caller holds h.mu.
func (h *ChatHub) loadData(o *chatOwner, first bool) {
	path := filepath.Join(o.dir, "chat.json")
	var data chatData
	_, err := readJSONStrict(path, &data)
	o.damaged, o.retryAt = err != nil, time.Time{}
	if err != nil {
		h.log.Error("chat: chat.json cannot be read - kept as it is, this chat takes no change", "file", path, "err", err)
		if isReadError(err) {
			o.retryAt = time.Now().Add(damagedRetryEvery)
		}
		if !first {
			return
		}
	}
	var live []*ChatContact
	for _, c := range data.Contacts {
		if c != nil && c.ID != "" {
			live = append(live, c)
		}
	}
	data.Contacts = live
	var groups []*ChatGroup
	for _, g := range data.Groups {
		if g != nil && g.ID != "" {
			groups = append(groups, g)
		}
	}
	data.Groups = groups
	if strings.TrimSpace(data.Me.Name) == "" {
		data.Me.Name = titleCase(o.user)
	}
	o.data = data
	if !first { // read whole at last: its links, people and pictures are back
		h.log.Warn("chat: chat.json reads again", "file", path)
		h.resetIndex()
		o.changed(true)
	}
}

func titleCase(s string) string {
	r, n := utf8.DecodeRuneInString(s)
	if n == 0 {
		return s
	}
	return string(unicode.ToUpper(r)) + s[n:]
}

// errChatDamaged: a write refused because the file it would replace failed
// to load (chatOwner.damaged, chatConv.damaged).
var errChatDamaged = errors.New("chat: that file cannot be read; it is not written over")

// saveData writes chat.json - never over one that failed to load (F5).
func (h *ChatHub) saveData(o *chatOwner) error {
	if o.damaged {
		return errChatDamaged
	}
	// Never the home itself (mkdirInHome): an owner the admin renamed or
	// deleted a moment ago must not come back as a ghost homes/<old>/ (L2).
	if err := mkdirInHome(h.cfg.HomesDir, o.dir); err != nil {
		return err
	}
	if o.data.Contacts == nil {
		o.data.Contacts = []*ChatContact{}
	}
	if o.data.Groups == nil {
		o.data.Groups = []*ChatGroup{}
	}
	return atomicWriteJSON(filepath.Join(o.dir, "chat.json"), o.data, 2)
}

// ensureIndex reads every home's chat.json once for its tokens and its
// Nayive-user contacts.
func (h *ChatHub) ensureIndex() {
	if h.indexed {
		return
	}
	h.indexed = true
	entries, err := os.ReadDir(h.cfg.HomesDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !ValidUsername(e.Name()) {
			continue
		}
		var data chatData
		if o, ok := h.owners[e.Name()]; ok {
			data = o.data
		} else if !loadJSONFile(filepath.Join(h.chatDir(e.Name()), "chat.json"), &data) {
			continue
		}
		for _, c := range data.Contacts {
			if c != nil && !c.Deleted && len(c.Token) >= 32 {
				h.tokens[tokenKey(c.Token)] = chatTokenRef{owner: e.Name(), contact: c.ID}
			}
			if c != nil && !c.Deleted && c.User != "" {
				h.links[c.User] = append(h.links[c.User], chatTokenRef{owner: e.Name(), contact: c.ID})
			}
		}
	}
}

// viaOf are the homes that hold `user` as a contact, each with that contact:
// the chats `user` reads through /api/chat/via/<home>. Caller holds h.mu.
func (h *ChatHub) viaOf(user string) []chatTokenRef {
	h.ensureIndex()
	out := []chatTokenRef{}
	seen := map[string]bool{}
	for _, ref := range h.links[user] {
		if seen[ref.owner] || ref.owner == user {
			continue
		}
		o := h.owner(ref.owner)
		if o == nil {
			continue
		}
		if c := o.userContact(user); c != nil {
			seen[ref.owner] = true
			out = append(out, chatTokenRef{owner: ref.owner, contact: c.ID})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].owner < out[j].owner })
	return out
}

// userContact is the live contact for the Nayive account `user`, or nil.
func (o *chatOwner) userContact(user string) *ChatContact {
	for _, c := range o.data.Contacts {
		if c.User == user && !c.Deleted {
			return c
		}
	}
	return nil
}

// byToken is the owner and person behind a link, or nils.
func (h *ChatHub) byToken(token string) (*chatOwner, *ChatContact) {
	if len(token) < 32 || len(token) > 128 {
		return nil, nil
	}
	h.ensureIndex()
	ref, ok := h.tokens[tokenKey(token)]
	if !ok {
		return nil, nil
	}
	o := h.owner(ref.owner)
	if o == nil {
		return nil, nil
	}
	c := o.contact(ref.contact)
	if c == nil || c.Deleted || subtle.ConstantTimeCompare([]byte(c.Token), []byte(token)) != 1 {
		return nil, nil
	}
	return o, c
}

func (o *chatOwner) contact(id string) *ChatContact {
	for _, c := range o.data.Contacts {
		if c.ID == id {
			return c
		}
	}
	return nil
}

func (o *chatOwner) group(id string) *ChatGroup {
	for _, g := range o.data.Groups {
		if g.ID == id {
			return g
		}
	}
	return nil
}

// members are the participants of a conversation, the owner first; nil when it
// does not exist (or no longer does).
func (o *chatOwner) members(conv string) []string {
	switch {
	case strings.HasPrefix(conv, "d-"):
		if c := o.contact(conv[2:]); c != nil && !c.Deleted {
			return []string{"o", c.ID}
		}
	case strings.HasPrefix(conv, "g-"):
		if g := o.group(conv[2:]); g != nil && !g.Deleted {
			out := []string{"o"}
			for _, m := range g.Members {
				if c := o.contact(m); c != nil && !c.Deleted {
					out = append(out, m)
				}
			}
			return out
		}
	}
	return nil
}

func (o *chatOwner) isMember(conv, pid string) bool {
	return contains(o.members(conv), pid)
}

// avatarsFor are the pictures `pid` may see, id -> version: the owner sees
// every person's and group's; a person sees their own, their groups' and
// those of the people in their groups. Everybody sees the owner's ("o").
func (o *chatOwner) avatarsFor(pid string) map[string]int64 {
	out := map[string]int64{}
	if o.data.Me.Photo > 0 {
		out["o"] = o.data.Me.Photo
	}
	for _, g := range o.data.Groups {
		if g.Deleted || (pid != "o" && !contains(g.Members, pid)) {
			continue
		}
		if g.Photo > 0 {
			out[g.ID] = g.Photo
		}
		for _, m := range g.Members {
			if c := o.contact(m); c != nil && !c.Deleted && c.Photo > 0 {
				out[m] = c.Photo
			}
		}
	}
	for _, c := range o.data.Contacts {
		if !c.Deleted && c.Photo > 0 && (pid == "o" || pid == c.ID) {
			out[c.ID] = c.Photo
		}
	}
	if pid == "o" { // the owner's own pictures of other accounts: nobody else's
		for u, v := range o.data.Faces {
			out[faceKey(u)] = v
		}
	}
	return out
}

// visible are the conversations `pid` takes part in.
func (o *chatOwner) visible(pid string) []string {
	var out []string
	for _, c := range o.data.Contacts {
		if !c.Deleted && (pid == "o" || pid == c.ID) {
			out = append(out, "d-"+c.ID)
		}
	}
	for _, g := range o.data.Groups {
		if !g.Deleted && (pid == "o" || contains(g.Members, pid)) {
			out = append(out, "g-"+g.ID)
		}
	}
	return out
}

// conv is a conversation, read from disk the first time.
func (h *ChatHub) conv(o *chatOwner, id string) *chatConv {
	if c, ok := o.convs[id]; ok {
		if !c.retryAt.IsZero() && !time.Now().Before(c.retryAt) {
			// A file that could not be read may read now. Read again in
			// place: nothing was written while it was damaged, so the disk
			// is all there is to know.
			rev, next := c.st.Rev, c.st.Next
			h.loadConv(c)
			c.st.Rev, c.st.Next = max(c.st.Rev, rev), max(c.st.Next, next) // never backwards for a page
			if !c.isDamaged() {
				h.log.Warn("chat: a conversation reads again", "dir", c.dir)
				o.changed(false)
			}
		}
		return c
	}
	c := &chatConv{id: id, dir: filepath.Join(o.dir, "conv", id)}
	h.loadConv(c)
	o.convs[id] = c
	return c
}

// loadConv reads a conversation from disk into c: its state, every month. A
// file that cannot be read or parsed is marked (c.damaged) and what loaded is
// kept; one that could not be READ is tried again after damagedRetryEvery.
// Caller holds h.mu.
func (h *ChatHub) loadConv(c *chatConv) {
	c.st, c.msgs, c.missed = chatState{}, nil, nil
	c.byID, c.cids = make(map[int64]*ChatMsg), make(map[string]int64)
	c.damaged, c.retryAt = nil, time.Time{}
	damaged := func(file string, err error) {
		if c.damaged == nil {
			c.damaged = map[string]bool{}
		}
		c.damaged[file] = true
		if isReadError(err) {
			c.retryAt = time.Now().Add(damagedRetryEvery)
		}
		h.log.Error("chat: a conversation file cannot be read - kept as it is, the conversation takes no change",
			"file", filepath.Join(c.dir, file), "err", err)
	}
	if _, err := readJSONStrict(filepath.Join(c.dir, "state.json"), &c.st); err != nil {
		damaged("state.json", err)
	}
	if c.st.Read == nil {
		c.st.Read = map[string]int64{}
	}
	entries, err := os.ReadDir(c.dir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		damaged("", err) // its months cannot be listed: none may be written
	}
	if err == nil {
		var months []string
		for _, e := range entries {
			n := e.Name()
			if len(n) == len("2006-01.json") && strings.HasSuffix(n, ".json") && n[4] == '-' {
				months = append(months, n)
			}
		}
		sort.Strings(months)
		for _, n := range months {
			var m chatMonth
			if _, err := readJSONStrict(filepath.Join(c.dir, n), &m); err != nil {
				damaged(n, err)
			}
			for _, msg := range m.Messages {
				if msg == nil || msg.ID <= 0 || c.byID[msg.ID] != nil {
					continue
				}
				c.msgs = append(c.msgs, msg)
				c.byID[msg.ID] = msg
				if msg.CID != "" {
					c.cids[msg.From+"|"+msg.CID] = msg.ID
				}
				if msg.ID >= c.st.Next {
					c.st.Next = msg.ID + 1 // a state.json older than the messages
				}
				if msg.Rev > c.st.Rev {
					c.st.Rev = msg.Rev
				}
			}
		}
	}
	sort.Slice(c.msgs, func(i, j int) bool { return c.msgs[i].ID < c.msgs[j].ID })
	if c.st.Next < 1 {
		c.st.Next = 1
	}
	// A link made for media/ but never renamed into place (the server stopped
	// between the two, keepBytes) is nobody's: it goes. Links are only made
	// under h.mu, which the caller holds, so none is half-way now.
	tmps, _ := filepath.Glob(filepath.Join(c.dir, "media", ".ln-*"))
	for _, p := range tmps {
		os.Remove(p)
	}
}

func monthOf(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01") }

// saveMonth rewrites the month file that holds `m`, and the state. The first
// error is answered.
func (h *ChatHub) saveMonth(c *chatConv, m *ChatMsg) error {
	err := h.writeMonth(c, monthOf(m.At))
	if serr := h.saveState(c); err == nil {
		err = serr
	}
	return err
}

// writeMonth rewrites one month file from memory - or removes it when that
// month has no message left. Never one that failed to load (F5).
func (h *ChatHub) writeMonth(c *chatConv, month string) error {
	if !c.canWrite(month + ".json") {
		return errChatDamaged
	}
	if err := mkdirInHome(h.cfg.HomesDir, c.dir); err != nil { // never the home itself (L2)
		h.log.Error("chat: cannot create a conversation folder", "err", err)
		return err
	}
	out := chatMonth{Messages: []*ChatMsg{}}
	for _, x := range c.msgs {
		if monthOf(x.At) == month {
			out.Messages = append(out.Messages, x)
		}
	}
	path := filepath.Join(c.dir, month+".json")
	if len(out.Messages) == 0 {
		os.Remove(path)
		return nil
	}
	if err := atomicWriteJSON(path, out, 1); err != nil {
		h.log.Error("chat: cannot save messages", "err", err)
		return err
	}
	return nil
}

// purge drops from memory and disk every message that all its members have
// deleted the chat past - its photo or file too. Caller holds h.mu.
//
// The members include the people taken out of a group who may be put back
// (ChatGroup.Left): one removed by mistake, then re-added with the Undo, never
// cleared that history, and must find it there (J6).
func (h *ChatHub) purge(o *chatOwner, c *chatConv) {
	who := o.members(c.id)
	if strings.HasPrefix(c.id, "g-") && len(who) > 0 { // members: the group is there
		for _, p := range o.group(c.id[2:]).Left {
			if ct := o.contact(p); ct != nil && !ct.Deleted && !contains(who, p) {
				who = append(who, p)
			}
		}
	}
	floor := int64(-1)
	for _, p := range who {
		f, ok := c.st.Cleared[p]
		if !ok {
			return // somebody still has it all
		}
		if floor < 0 || f < floor {
			floor = f
		}
	}
	if floor <= 0 {
		return
	}
	h.dropMessages(o, c, func(m *ChatMsg) bool { return m.ID <= floor })
}

// dropMessages removes every message `gone` picks, from memory and from its
// month file - its photo or file too - and answers the highest id it removed.
// Caller holds h.mu.
func (h *ChatHub) dropMessages(o *chatOwner, c *chatConv, gone func(*ChatMsg) bool) int64 {
	months := map[string]bool{}
	var top int64
	keep := c.msgs[:0]
	for _, m := range c.msgs {
		if !gone(m) {
			keep = append(keep, m)
			continue
		}
		months[monthOf(m.At)] = true
		delete(c.byID, m.ID)
		if m.CID != "" {
			delete(c.cids, m.From+"|"+m.CID)
		}
		h.dropMedia(o, c, m)
		top = max(top, m.ID)
	}
	clear(c.msgs[len(keep):]) // the dropped tail must not pin the old messages
	c.msgs = keep
	for month := range months {
		h.writeMonth(c, month)
	}
	return top
}

// dropMedia deletes the photo or file of a message that is going away. A
// KEPT photo is the owner's file too: only the chat's own name for it goes
// (its media/ hard link) and the link to it - the owner's file stays. Caller
// holds h.mu.
func (h *ChatHub) dropMedia(o *chatOwner, c *chatConv, m *ChatMsg) {
	_, kept := c.st.Kept[m.ID]
	delete(c.st.Kept, m.ID)
	delete(c.st.KeptID, m.ID)
	if m.File == nil {
		return
	}
	path := filepath.Join(c.dir, "media", mediaName(m))
	if info, err := os.Lstat(path); err == nil && os.Remove(path) == nil && !kept {
		// A kept one's bytes are still the owner's file's: nothing freed
		// (a copy, on a disk with no links, is seen by the next measure).
		h.users.AdjustUsage(o.user, -info.Size())
	}
}

// openMedia opens a message's photo or file: the chat's own, under media/
// (J4: a kept photo too - a hard link of the owner's file). A kept photo
// from before media/ held it is the owner's file, through the file API's
// sandbox - only while it is still THAT file (KeptID): renamed or moved, it
// is found again by its inode and the new path saved; ANOTHER file saved at
// its path (a new photo of the same name) is never shown in the old message.
// Found, it is linked under media/ there and then. Caller holds h.mu.
func (h *ChatHub) openMedia(o *chatOwner, c *chatConv, m *ChatMsg) (*os.File, os.FileInfo, error) {
	file, info, err := openInside(filepath.Join(c.dir, "media"), mediaName(m))
	kept := c.st.Kept[m.ID]
	if err == nil || kept == "" {
		return file, info, err
	}
	want := c.st.KeptID[m.ID]
	if want.Ino == 0 {
		return h.openKept(o.user, kept) // no inodes on this system: the path is all there is
	}
	rel, file, info := h.keptFile(o, c, m.ID)
	if file == nil {
		return nil, nil, os.ErrNotExist
	}
	// From now on the chat holds these bytes itself (best effort: the photo
	// shows either way, and the next look tries again).
	if c.canWrite("state.json") {
		if n, err := h.keepBytes(o, c, m, rel, want); err != nil {
			h.log.Warn("chat: a kept photo could not be linked under media/", "user", o.user, "conv", c.id, "id", m.ID, "err", err)
		} else if n > 0 {
			h.users.AdjustUsage(o.user, n)
		}
	}
	return file, info, nil
}

// keptFile opens the owner's file that message `id` is kept as - at its kept
// path while that is still the file known by KeptID, else found again by its
// inode (the new path saved) - and answers its path; nils when it is in none
// of their files any more (binned, deleted, or replaced by another file).
// Not looked for again for chatFindAgain after a miss. Caller holds h.mu.
func (h *ChatHub) keptFile(o *chatOwner, c *chatConv, id int64) (string, *os.File, os.FileInfo) {
	kept, want := c.st.Kept[id], c.st.KeptID[id]
	if kept == "" {
		return "", nil, nil
	}
	file, info, err := h.openKept(o.user, kept)
	if err == nil && (want.Ino == 0 || keptIDOf(info) == want) {
		return kept, file, info
	}
	if file != nil {
		file.Close()
	}
	if want.Ino == 0 || time.Since(c.missed[id]) <= chatFindAgain {
		return "", nil, nil
	}
	rel := h.findKept(o.user, want)
	if rel != "" {
		if f2, i2, err := h.openKept(o.user, rel); err == nil && keptIDOf(i2) == want {
			c.st.Kept[id] = rel
			h.saveState(c)
			return rel, f2, i2
		} else if f2 != nil {
			f2.Close()
		}
	}
	if c.missed == nil {
		c.missed = map[int64]time.Time{}
	}
	c.missed[id] = time.Now()
	return "", nil, nil
}

// keepBytes puts the owner's file `rel` (known by `want`; zero: by its path)
// under media/ as message m's photo: a hard link - the same bytes, no room
// taken - or a copy where no link can be made (another disk). A file already
// there is replaced (an edit, chatEdited): media/<id> is only ever this
// message's. Answers the bytes a copy took (0 for a link). Caller holds h.mu.
func (h *ChatHub) keepBytes(o *chatOwner, c *chatConv, m *ChatMsg, rel string, want keptID) (int64, error) {
	src, ok := h.users.Resolve("user", o.user, rel)
	if !ok {
		return 0, os.ErrNotExist
	}
	media := filepath.Join(c.dir, "media")
	if err := mkdirInHome(h.cfg.HomesDir, media); err != nil { // never the home itself (L2)
		return 0, err
	}
	dir := "data/chat/conv/" + c.id + "/media/"
	tmp, ok1 := h.users.Resolve("user", o.user, dir+".ln-"+newChatID())
	final, ok2 := h.users.Resolve("user", o.user, dir+mediaName(m))
	if !ok1 || !ok2 {
		return 0, os.ErrNotExist
	}
	n, err := linkNoReplace(src, tmp, want)
	if err != nil {
		return 0, err
	}
	if err := os.Rename(tmp.Abs, final.Abs); err != nil {
		os.Remove(tmp.Abs)
		return 0, err
	}
	if err := syncDir(media); err != nil { // its name durable before anyone relies on it (K1)
		h.log.Warn("chat: media folder not synced", "dir", media, "err", err)
	}
	return n, nil
}

// linkNoReplace gives the file `src` a second name, `dst` (both in the same
// home): a hard link, or - on a disk that refuses one - a copy made only
// where no file is. Never over a file: a taken name answers fs.ErrExist (a
// plain rename or a "free?" look first would replace one saved meanwhile,
// D10). `want` non-zero: the file linked must be that one (the path may
// have been given to another file since it was checked) - else nothing is
// left at `dst` and fs.ErrNotExist is answered. Answers the bytes a copy
// took (0 for a link).
func linkNoReplace(src, dst Resolved, want keptID) (int64, error) {
	if src.Root != dst.Root {
		return 0, errCrossRoot
	}
	root, err := src.open()
	if err != nil {
		return 0, err
	}
	defer root.Close()
	if hook := testPlaceHook.Load(); hook != nil {
		(*hook)(root, src.Rel, dst.Rel, false) // a test puts a file at `dst` now
	}
	err = root.Link(src.Rel, dst.Rel)
	if err == nil {
		if info, err := root.Lstat(dst.Rel); err == nil && info.Mode().IsRegular() && (want.Ino == 0 || keptIDOf(info) == want) {
			return 0, nil
		}
		root.Remove(dst.Rel) // another file (or a link) at that path now: not it
		return 0, fs.ErrNotExist
	}
	if errors.Is(err, fs.ErrExist) {
		return 0, err
	}
	// No hard links here: a copy, from the file checked to be the one.
	in, err := root.Open(src.Rel)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	if info, err := in.Stat(); err != nil || !info.Mode().IsRegular() || (want.Ino != 0 && keptIDOf(info) != want) {
		return 0, fs.ErrNotExist
	}
	out, err := root.OpenFile(dst.Rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, in)
	if err == nil {
		err = out.Sync() // on disk before anything points at it (J5)
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		root.Remove(dst.Rel)
		return 0, err
	}
	return n, nil
}

// setKept links message `id` to the owner's file `rel`, known by `id2`.
func (h *ChatHub) setKept(c *chatConv, id int64, rel string, id2 keptID) {
	if c.st.Kept == nil {
		c.st.Kept = map[int64]string{}
	}
	c.st.Kept[id] = rel
	if id2.Ino == 0 {
		delete(c.st.KeptID, id)
		return
	}
	if c.st.KeptID == nil {
		c.st.KeptID = map[int64]keptID{}
	}
	c.st.KeptID[id] = id2
}

// openKept opens the owner's file `rel` ("files/...") through the sandbox,
// only when it is a regular file.
func (h *ChatHub) openKept(user, rel string) (*os.File, os.FileInfo, error) {
	target, ok := h.users.Resolve("user", user, rel)
	if !ok {
		return nil, nil, os.ErrNotExist
	}
	if info, err := target.Stat(); err != nil || !info.Mode().IsRegular() {
		return nil, nil, os.ErrNotExist
	}
	file, err := target.Open()
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, nil, os.ErrNotExist
	}
	return file, info, nil
}

// chatFindMax caps the walk of findKept: a home is a few thousand files.
const chatFindMax = 200000

// chatFindAgain: how long a kept file not found is not looked for again.
const chatFindAgain = 10 * time.Minute

// findKept is the owner's file known by `id`, as "files/...", or "".
// The bin is not looked in: a binned photo is gone until it is restored.
// One walk of the home answers a burst of lookups (keptindex.go, S2-#16).
func (h *ChatHub) findKept(user string, id keptID) string {
	return findKeptIndexed(filepath.Join(h.cfg.HomesDir, user), id)
}

// -----------------------------------------------------------------------------
// auto-delete
// -----------------------------------------------------------------------------

// chatMaxDeleteAfter is the longest "delete after N days" (ten years).
const chatMaxDeleteAfter = 3650

// expire deletes, for good, every message of `o` older than their
// "deleteAfter" days, in every conversation on disk (a deleted person's too).
// Nothing while the clock is not believed (expiryClockOK, J8). Caller holds h.mu.
func (h *ChatHub) expire(o *chatOwner, now time.Time) {
	if o.data.DeleteAfter <= 0 || !h.expiryClockOK(now) {
		return
	}
	h.expireOwner(o, now)
	h.expiryRan(now)
}

// expireOwner is expire once the clock is believed. Caller holds h.mu.
func (h *ChatHub) expireOwner(o *chatOwner, now time.Time) {
	days := o.data.DeleteAfter
	if days <= 0 {
		return
	}
	cutoff := now.Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
	h.eachConvOnDisk(o, func(c *chatConv) { h.expireConv(o, c, cutoff) })
}

// eachConvOnDisk runs `fn` on every conversation of `o` on disk - a deleted
// person's or group's too. Caller holds h.mu.
func (h *ChatHub) eachConvOnDisk(o *chatOwner, fn func(c *chatConv)) {
	entries, err := os.ReadDir(filepath.Join(o.dir, "conv"))
	if err != nil {
		return
	}
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() && (strings.HasPrefix(n, "d-") || strings.HasPrefix(n, "g-")) {
			fn(h.conv(o, n))
		}
	}
}

// countExpiring is how many messages of `o` an auto-delete of `days` would
// delete now, in every conversation - what the page shows BEFORE it is set
// (J7: a typo, 1 for 10, reads "deletes 12 345 messages"). Messages already
// deleted for everyone do not count. Caller holds h.mu.
func (h *ChatHub) countExpiring(o *chatOwner, days int, now time.Time) int {
	if days <= 0 {
		return 0
	}
	cutoff := now.Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
	n := 0
	h.eachConvOnDisk(o, func(c *chatConv) {
		for _, m := range c.msgs { // all of them, as expireConv looks at all
			if m.At < cutoff && !m.Deleted {
				n++
			}
		}
	})
	return n
}

// -----------------------------------------------------------------------------
// the clock auto-delete believes (J8)
// -----------------------------------------------------------------------------
//
// Auto-delete measures age against the server's clock, and deletes for good.
// A clock that jumps forward at boot (no clock battery, NTP late, a VPS
// restored with a wrong date) would delete every message "older than N days"
// of the wrong date. So the time of every pass is kept on disk
// (config/chat-autodelete.json), and a clock more than chatClockJump ahead of
// it is doubted: nothing is deleted, and it is logged. It is believed again
// once chatClockTrust has gone by on it since the doubt began, the clock
// running steady all along - which gives a late NTP a day to put it right,
// and after a real day off delays auto-delete by one day only. A clock put
// right in the meantime (back near the last pass) is believed at once.
//
// "Steady" is checked at every look (hourly): within one run of the server,
// its wall time must have moved as the process's own monotonic time did;
// across a restart, the gap since the last look must be a reboot's (forward,
// under chatClockJump). Anything else is a new jump, and the doubt starts
// over. The doubt and the last look are kept on disk with the pass's time,
// so a server restarted every day still comes out of a doubt.

// chatClockJump: how far past the last pass a clock may be before it is doubted.
const chatClockJump = 24 * time.Hour

// chatClockTrust: how long a doubted clock must run steady to be believed.
// A var: the tests shorten it.
var chatClockTrust = 24 * time.Hour

// chatClockDrift: what "steady" forgives between wall and monotonic time.
const chatClockDrift = time.Minute

// chatClockDisk is config/chat-autodelete.json (unix ms; 0 = none).
type chatClockDisk struct {
	Ran   int64 `json:"ran"`             // the last auto-delete pass
	Doubt int64 `json:"doubt,omitempty"` // when the clock began to be doubted
	Seen  int64 `json:"seen,omitempty"`  // the last look at a doubted clock
}

// expiryClockFile is where the time of the last auto-delete pass is kept
// ("" with no config folder: memory only).
func (h *ChatHub) expiryClockFile() string {
	if h.cfg.ConfigDir == "" {
		return ""
	}
	return filepath.Join(h.cfg.ConfigDir, "chat-autodelete.json")
}

// expiryClockOK: auto-delete may believe `now`. Caller holds h.mu.
func (h *ChatHub) expiryClockOK(now time.Time) bool {
	if !h.clockRead {
		h.clockRead, h.clock, h.clockSeen = true, chatClockDisk{}, time.Time{} // no look seen by this run yet
		if path := h.expiryClockFile(); path != "" {
			loadJSONFile(path, &h.clock)
		}
	}
	ms := now.UnixMilli()
	if h.clock.Ran == 0 || time.Duration(ms-h.clock.Ran)*time.Millisecond <= chatClockJump {
		// No pass known, or close to the last one (a clock put back: fine).
		h.clock.Doubt, h.clock.Seen, h.clockSeen = 0, 0, time.Time{}
		return true
	}
	steady := h.clock.Doubt != 0
	if steady && !h.clockSeen.IsZero() {
		// Seen by this run: wall and monotonic time moved alike since.
		mono := now.Sub(h.clockSeen)                   // monotonic: both carry it
		wall := now.Round(0).Sub(h.clockSeen.Round(0)) // wall: Round(0) drops it
		steady = wall-mono <= chatClockDrift && mono-wall <= chatClockDrift
	} else if steady {
		// Seen before a restart: the gap is a reboot's, not a jump.
		gap := time.Duration(ms-h.clock.Seen) * time.Millisecond
		steady = gap >= -chatClockDrift && gap <= chatClockJump
	}
	if !steady {
		h.clock.Doubt = ms // a doubt begins (again)
	}
	h.clock.Seen, h.clockSeen = ms, now
	if time.Duration(ms-h.clock.Doubt)*time.Millisecond >= chatClockTrust {
		h.log.Warn("chat: auto-delete believes the clock again - it ran steady since it jumped",
			"lastPass", time.UnixMilli(h.clock.Ran).UTC().Format(time.RFC3339), "now", now.UTC().Format(time.RFC3339))
		h.clock.Doubt, h.clock.Seen, h.clockSeen = 0, 0, time.Time{}
		return true // the caller keeps the pass (expiryRan)
	}
	h.saveExpiryClock()
	h.log.Warn("chat: the clock is more than a day past the last auto-delete pass - nothing deleted until it has run steady for a while",
		"lastPass", time.UnixMilli(h.clock.Ran).UTC().Format(time.RFC3339), "now", now.UTC().Format(time.RFC3339),
		"believedAfter", time.UnixMilli(h.clock.Doubt).Add(chatClockTrust).UTC().Format(time.RFC3339))
	return false
}

// expiryRan keeps `now` as the time of the last pass, on disk. Caller holds h.mu.
func (h *ChatHub) expiryRan(now time.Time) {
	h.clock = chatClockDisk{Ran: now.UnixMilli()}
	h.clockSeen = time.Time{}
	h.saveExpiryClock()
}

// saveExpiryClock writes config/chat-autodelete.json. Caller holds h.mu.
func (h *ChatHub) saveExpiryClock() {
	if path := h.expiryClockFile(); path != "" {
		if err := atomicWriteJSON(path, h.clock, 1); err != nil {
			h.log.Error("chat: cannot keep the time of the auto-delete pass", "file", path, "err", err)
		}
	}
}

// expireConv drops the messages sent before `cutoff` (unix ms). Caller holds h.mu.
func (h *ChatHub) expireConv(o *chatOwner, c *chatConv, cutoff int64) {
	n := len(c.msgs)
	top := h.dropMessages(o, c, func(m *ChatMsg) bool { return m.At < cutoff })
	if len(c.msgs) == n {
		return
	}
	c.st.Gone = max(c.st.Gone, top)
	o.bump(c, nil)
	h.saveState(c)
}

// RunExpiry applies every owner's auto-delete a minute after the start, then
// every hour, until `ctx` ends or the hub closes.
func (h *ChatHub) RunExpiry(ctx context.Context) {
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.closing:
			return
		case <-timer.C:
		}
		h.expireAll(time.Now())
		timer.Reset(time.Hour)
	}
}

// expireAll runs expire for every account whose chat.json asks for it - read
// from disk for an owner nobody has opened since the start. The clock is
// checked once for all (J8), and the pass is kept on disk even when no
// account asks: the reference an account switching auto-delete on later needs.
func (h *ChatHub) expireAll(now time.Time) {
	h.mu.Lock()
	ok := h.expiryClockOK(now)
	h.mu.Unlock()
	if !ok {
		return
	}
	defer func() {
		h.mu.Lock()
		h.expiryRan(now)
		h.mu.Unlock()
	}()
	entries, err := os.ReadDir(h.cfg.HomesDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		user := e.Name()
		if !e.IsDir() || !ValidUsername(user) {
			continue
		}
		h.mu.Lock()
		days := 0
		if o, ok := h.owners[user]; ok {
			days = o.data.DeleteAfter
		} else {
			var data chatData
			if loadJSONFile(filepath.Join(h.chatDir(user), "chat.json"), &data) {
				days = data.DeleteAfter
			}
		}
		if days > 0 {
			if o := h.owner(user); o != nil {
				h.expireOwner(o, now)
			}
		}
		h.mu.Unlock()
	}
}

// -----------------------------------------------------------------------------
// later: texts scheduled for a time to come
// -----------------------------------------------------------------------------

// RunLater sends the scheduled texts whose time has come: at the start, then
// every chatLaterTick, until `ctx` ends or the hub closes.
func (h *ChatHub) RunLater(ctx context.Context) {
	tick := time.NewTicker(chatLaterTick)
	defer tick.Stop()
	for {
		h.sendDue(time.Now())
		select {
		case <-ctx.Done():
			return
		case <-h.closing:
			return
		case <-tick.C:
		}
	}
}

// sendDue sends every scheduled text due by `now`, in every home in memory.
// The first run (and the first after an account change dropped the homes)
// reads every home's chat.json, so a text waiting through a restart still goes.
func (h *ChatHub) sendDue(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.laterRead {
		h.laterRead = true
		if entries, err := os.ReadDir(h.cfg.HomesDir); err == nil {
			for _, e := range entries {
				user := e.Name()
				if _, ok := h.owners[user]; ok || !e.IsDir() || !ValidUsername(user) {
					continue
				}
				var data chatData
				if loadJSONFile(filepath.Join(h.chatDir(user), "chat.json"), &data) && len(data.Later) > 0 {
					h.owner(user)
				}
			}
		}
	}
	for _, o := range h.owners {
		h.sendDueIn(o, now.UnixMilli())
	}
}

// sendDueIn sends `o`'s texts due by `now` (unix ms), oldest first. Caller holds h.mu.
func (h *ChatHub) sendDueIn(o *chatOwner, now int64) {
	// chat.json failed to load: a text sent now could not be taken out of its
	// "later" list on disk, and would go again after every restart (F5).
	if o.damaged {
		return
	}
	var due, keep []*ChatLater
	for _, l := range o.data.Later {
		if l.At <= now {
			due = append(due, l)
		} else {
			keep = append(keep, l)
		}
	}
	if len(due) == 0 {
		return
	}
	sort.SliceStable(due, func(i, j int) bool { return due[i].At < due[j].At })
	for _, l := range due {
		if _, _, err := h.sendLater(o, l); err != nil {
			// Not on disk: it stays scheduled and goes at the next tick (J5).
			h.log.Error("chat: a scheduled text could not be sent", "user", o.user, "conv", l.Conv, "err", err)
			keep = append(keep, l)
		}
	}
	o.data.Later = keep
	h.saveData(o)
	o.changed(true)
}

// sendLater turns `l` into a message from its sender, now - nothing when they
// are no longer in that chat (a person deleted, a group gone). The caller has
// taken it out of o.data.Later and saves; on an error the message was not
// stored, and the caller keeps `l`. Caller holds h.mu.
func (h *ChatHub) sendLater(o *chatOwner, l *ChatLater) (*chatConv, *ChatMsg, error) {
	if !o.isMember(l.Conv, l.From) {
		return nil, nil, nil
	}
	c := h.conv(o, l.Conv)
	m := &ChatMsg{From: l.From, Kind: "text", Text: l.Text, CID: "later-" + l.ID}
	if l.ReplyTo > 0 && c.byID[l.ReplyTo] != nil {
		m.ReplyTo = l.ReplyTo
	}
	m.ID, m.At = c.st.Next, nowMs()
	if err := h.store(o, c, m); err != nil {
		return c, nil, err
	}
	return c, m, nil
}

// laterOf are `pid`'s texts waiting in `conv`, soonest first. Caller holds h.mu.
func (o *chatOwner) laterOf(conv, pid string) []*ChatLater {
	var out []*ChatLater
	for _, l := range o.data.Later {
		if l.Conv == conv && l.From == pid {
			out = append(out, l)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At < out[j].At })
	return out
}

// saveState writes the conversation's state.json - never over one that
// failed to load (F5).
func (h *ChatHub) saveState(c *chatConv) error {
	if !c.canWrite("state.json") {
		return errChatDamaged
	}
	if err := mkdirInHome(h.cfg.HomesDir, c.dir); err != nil { // never the home itself (L2)
		return err
	}
	if err := atomicWriteJSON(filepath.Join(c.dir, "state.json"), c.st, 1); err != nil {
		h.log.Error("chat: cannot save a conversation's state", "err", err)
		return err
	}
	return nil
}

// changed wakes every wait of this owner. meta: chat.json changed too.
func (o *chatOwner) changed(meta bool) {
	o.version++
	if meta {
		o.meta++
	}
	close(o.wake)
	o.wake = make(chan struct{})
	if o.notify != nil {
		o.notify()
	}
}

// changedHook passes a change on to the Android app's waits (devices.go).
func (h *ChatHub) changedHook() {
	if h.onChange != nil {
		h.onChange()
	}
}

// Hook connects the Android app (devices.go). Call once, before serving.
func (h *ChatHub) Hook(d *Devices) {
	h.onChange = d.Kick
	h.onCall = d.OnCall
	h.skipPush = d.SkipCallPush
}

// bump gives `c` a new rev and stamps it on `m` (when there is one).
func (o *chatOwner) bump(c *chatConv, m *ChatMsg) int64 {
	c.st.Rev++
	if m != nil {
		m.Rev = c.st.Rev
	}
	o.changed(false)
	return c.st.Rev
}

// -----------------------------------------------------------------------------
// reading
// -----------------------------------------------------------------------------

// chatQuote is what a reply shows of the message it answers - built when it
// goes out, so a later edit or delete of the original shows too.
type chatQuote struct {
	ID      int64  `json:"id"`
	From    string `json:"from"`
	Kind    string `json:"kind"`
	Text    string `json:"text,omitempty"`
	Deleted bool   `json:"deleted,omitempty"`
}

type chatMsgOut struct {
	*ChatMsg
	Quote *chatQuote `json:"quote,omitempty"`
	Kept  bool       `json:"kept,omitempty"` // its photo lives in the owner's files (never the path: a person sees this too)
}

func (c *chatConv) out(m *ChatMsg) chatMsgOut {
	o := chatMsgOut{ChatMsg: m, Kept: c.st.Kept[m.ID] != ""}
	if m.ReplyTo > 0 {
		if q := c.byID[m.ReplyTo]; q != nil {
			o.Quote = &chatQuote{ID: q.ID, From: q.From, Kind: q.Kind, Text: quoteText(q), Deleted: q.Deleted}
		}
	}
	return o
}

// quoteText is the short line a quote or a notification shows.
func quoteText(m *ChatMsg) string {
	if m.Deleted {
		return ""
	}
	t := m.Text
	switch m.Kind {
	case "file":
		if t == "" && m.File != nil {
			t = m.File.Name
		}
	case "loc":
		if m.Loc != nil {
			t = m.Loc.Place
		}
	case "card":
		if m.Card != nil {
			t = m.Card.Name
		}
	case "poll":
		if m.Poll != nil {
			t = m.Poll.Q
		}
	case "call":
		t = "" // the page words it ("Voice call", "Missed video call"...)
	}
	return clip(t, 140)
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

// floor is the last message `pid` deleted the chat at (0: never).
func (c *chatConv) floor(pid string) int64 { return c.st.Cleared[pid] }

// hiddenFor: `pid` deleted this chat and nothing came in since.
func (c *chatConv) hiddenFor(pid string) bool {
	f, ok := c.st.Cleared[pid]
	if !ok {
		return false
	}
	m := c.last()
	return m == nil || m.ID <= f
}

// lastFor is the last message `pid` may still see, or nil.
func (c *chatConv) lastFor(pid string) *ChatMsg {
	if m := c.last(); m != nil && m.ID > c.floor(pid) {
		return m
	}
	return nil
}

// unread are the messages `pid` has not read, from anybody else.
func (c *chatConv) unread(pid string) int {
	seen := max(c.st.Read[pid], c.floor(pid))
	n := 0
	for i := len(c.msgs) - 1; i >= 0 && c.msgs[i].ID > seen; i-- {
		if m := c.msgs[i]; m.From != pid && !m.Deleted {
			n++
		}
	}
	return n
}

func (c *chatConv) last() *ChatMsg {
	if len(c.msgs) == 0 {
		return nil
	}
	return c.msgs[len(c.msgs)-1]
}

// convName is the conversation as `pid` sees it named.
func (o *chatOwner) convName(conv, pid string) string {
	if strings.HasPrefix(conv, "d-") {
		if pid != "o" {
			return o.data.Me.Name
		}
		if c := o.contact(conv[2:]); c != nil {
			return c.Name
		}
		return ""
	}
	if g := o.group(conv[2:]); g != nil {
		return g.Name
	}
	return ""
}

// onlineFor are the participants `pid` may see online: the owner sees their
// people, a person sees the owner.
func (o *chatOwner) onlineFor(pid string) []string {
	out := []string{}
	for p, on := range o.online {
		if on && p != pid && (pid == "o" || p == "o") {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// typingFor are, per conversation `pid` takes part in, who is typing there.
func (o *chatOwner) typingFor(pid string) map[string][]string {
	out := map[string][]string{}
	now := time.Now()
	for conv, who := range o.typing {
		if !o.isMember(conv, pid) {
			continue
		}
		for p, until := range who {
			if p != pid && until.After(now) {
				out[conv] = append(out[conv], p)
			}
		}
		sort.Strings(out[conv])
	}
	return out
}

// -----------------------------------------------------------------------------
// presence (caller holds h.mu)
// -----------------------------------------------------------------------------

func (h *ChatHub) waitStart(o *chatOwner, pid string) {
	h.sweepOnce.Do(func() { go h.sweep() })
	o.waits[pid]++
	if !o.online[pid] {
		o.online[pid] = true
		o.changed(false)
	}
}

func (h *ChatHub) waitEnd(o *chatOwner, pid string) {
	if o.waits[pid] > 0 {
		o.waits[pid]--
	}
	o.lastEnd[pid] = time.Now()
}

// isOnline: a wait is open, or one ended moments ago (the page is between two).
func (o *chatOwner) isOnline(pid string) bool {
	return o.waits[pid] > 0 || time.Since(o.lastEnd[pid]) < chatOnlineGrace
}

// sweep turns off "online" and "escribiendo..." once they run out.
func (h *ChatHub) sweep() {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-h.closing:
			return
		case <-tick.C:
		}
		h.mu.Lock()
		now := time.Now()
		var calls []chatCallPush // a call that timed out: its pushes go out after the lock
		for _, o := range h.owners {
			calls = append(calls, h.callTick(o, now)...)
			moved := false
			for p, on := range o.online {
				if on && !o.isOnline(p) {
					o.online[p] = false
					moved = true
				}
			}
			for conv, who := range o.typing {
				for p, until := range who {
					if !until.After(now) {
						delete(who, p)
						moved = true
					}
				}
				if len(who) == 0 {
					delete(o.typing, conv)
				}
			}
			if moved {
				o.changed(false)
			}
		}
		h.mu.Unlock()
		if len(calls) > 0 {
			go h.sendCallPushes(calls)
		}
	}
}

// -----------------------------------------------------------------------------
// checking what comes in
// -----------------------------------------------------------------------------

// cleanChatName is a person's or a group's name: one line, trimmed, capped.
func cleanChatName(s string) string { return cleanOneLine(s, chatMaxName) }

// cleanChatMotto is the owner's motto: the same one line, with more room.
func cleanChatMotto(s string) string { return cleanOneLine(s, chatMaxMotto) }

// cleanOneLine folds every run of spaces (and control characters) into one
// blank, trims the ends and caps the result at `max` runes.
func cleanOneLine(s string, max int) string {
	s = strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}), " ")
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return strings.TrimSpace(s)
}

// cleanChatText keeps line breaks, drops every other control character.
func cleanChatText(s string, max int) (string, bool) {
	if !utf8.ValidString(s) {
		return "", false
	}
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r == '\r' || unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max {
		return "", false
	}
	return s, true
}

// chatPushHostOK: a person's device may only be reached at a real push service.
//
// Only by NAME: an IP literal, bracketed or not, and a zone ("%...") never
// pass - "[::ffff:127.0.0.1%25.google.com]" ends in ".google.com" and dials
// 127.0.0.1. What a name resolves to is checked again when the push is sent
// (webpush.go pushDialControl).
func chatPushHostOK(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if strings.HasPrefix(u.Host, "[") || strings.ContainsAny(host, ":%") || net.ParseIP(host) != nil {
		return false
	}
	if googlePushHost(host) {
		return true
	}
	for _, h := range chatPushHosts {
		if strings.HasPrefix(h, ".") {
			if strings.HasSuffix(host, h) {
				return true
			}
		} else if host == h {
			return true
		}
	}
	return false
}

// googlePushHost is Chrome's newer push endpoint host, jmt<digits>.google.com
// (jmt17 is the one seen in the wild), and nothing else under google.com.
func googlePushHost(host string) bool {
	d, ok := strings.CutSuffix(host, ".google.com")
	if !ok {
		return false
	}
	d, ok = strings.CutPrefix(d, "jmt")
	if !ok || d == "" || len(d) > 4 {
		return false
	}
	for _, c := range d {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// fileExt is the extension a stored attachment keeps: letters and digits only.
func fileExt(name string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	if len(ext) == 0 || len(ext) > 8 {
		return ""
	}
	for _, r := range ext {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9') {
			return ""
		}
	}
	return ext
}

// cleanFileName is an attachment's name as shown: no path, no control chars.
func cleanFileName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = cleanChatName(name)
	if len([]rune(name)) > 120 {
		name = string([]rune(name)[:120])
	}
	if name == "" || name == "." || name == ".." {
		name = "file"
	}
	return name
}

func mediaName(m *ChatMsg) string {
	if m.File == nil {
		return ""
	}
	if m.File.Ext == "" {
		return itoa64(m.ID)
	}
	return itoa64(m.ID) + "." + m.File.Ext
}

// allowSend is the per-person rate limit (the owner has none).
func (o *chatOwner) allowSend(pid string) bool {
	return allowIn(o.sent, pid, chatGuestPerMin, time.Now())
}

// allowBytes is the per-person daily upload allowance.
func (o *chatOwner) allowBytes(pid string, n int64) bool {
	if pid == "o" {
		return true
	}
	today := time.Now().Format("2006-01-02")
	use := o.day[pid]
	if use.day != today {
		use = chatDayUse{day: today}
	}
	if use.bytes+n > chatGuestDayByte {
		return false
	}
	use.bytes += n
	o.day[pid] = use
	return true
}

// -----------------------------------------------------------------------------
// notifications
// -----------------------------------------------------------------------------

type chatPushJob struct {
	sub    PushSub
	owner  string // the account, when the device is a Nayive user's (the owner, or a contact with User)
	person string // the person's id, when it is theirs
	token  string // ...and their link, for the URL
	title  string
	from   string // the sender's name, for a group line
	msg    ChatMsg
	conv   string
	group  bool
}

// pushTargets collects the devices to notify of `m`. Caller holds h.mu.
func (h *ChatHub) pushTargets(o *chatOwner, c *chatConv, m *ChatMsg, only string) []chatPushJob {
	var jobs []chatPushJob
	group := strings.HasPrefix(c.id, "g-")
	from := h.nameOf(o, m.From)
	for _, p := range o.members(c.id) {
		if p == m.From || c.st.Mute[p] || (only != "" && p != only) {
			continue
		}
		if c.st.Read[p] >= m.ID {
			continue
		}
		base := chatPushJob{title: o.convName(c.id, p), from: from, msg: *m, conv: c.id, group: group}
		if p == "o" {
			for _, sub := range h.users.UserPush(o.user).Subs {
				j := base
				j.sub, j.owner = sub, o.user
				jobs = append(jobs, j)
			}
			continue
		}
		if ct := o.contact(p); ct != nil && ct.User != "" {
			// A Nayive user: their account's devices, opening their own Chat.
			for _, sub := range h.users.UserPush(ct.User).Subs {
				j := base
				j.sub, j.owner = sub, ct.User
				jobs = append(jobs, j)
			}
		} else if ct != nil {
			for _, sub := range ct.Subs {
				j := base
				j.sub, j.person, j.token = sub, ct.ID, ct.Token
				jobs = append(jobs, j)
			}
		}
	}
	return jobs
}

func (h *ChatHub) nameOf(o *chatOwner, pid string) string {
	if pid == "o" {
		return o.data.Me.Name
	}
	if c := o.contact(pid); c != nil {
		return c.Name
	}
	return ""
}

// testHook is for tests only (server 75): it hears what a request decided to
// do after its answer - pushes, a photo's position - so a test can prove that
// NOTHING was sent without sleeping first. `who` is the *ChatHub or *Server it
// happened in, `ev` the event, `n` how many. Nil in production: one atomic load.
var testHook atomic.Pointer[func(who any, ev string, n int)]

func traced(who any, ev string, n int) {
	if f := testHook.Load(); f != nil {
		(*f)(who, ev, n)
	}
}

// announce pushes a new message to whoever is away, and re-checks the ones who
// looked present. Caller holds h.mu; the sending happens on its own goroutine.
func (h *ChatHub) announce(o *chatOwner, c *chatConv, m *ChatMsg) {
	var now, later []string
	for _, p := range o.members(c.id) {
		if p == m.From || c.st.Mute[p] {
			continue
		}
		if o.isOnline(p) {
			later = append(later, p)
		} else {
			now = append(now, p)
		}
	}
	var jobs []chatPushJob
	for _, p := range now {
		jobs = append(jobs, h.pushTargets(o, c, m, p)...)
	}
	traced(h, "push-now", len(jobs))
	traced(h, "push-later", len(later))
	if len(jobs) > 0 {
		go h.sendPushes(o.user, jobs)
	}
	for _, p := range later {
		p := p
		user, conv, id := o.user, c.id, m.ID
		time.AfterFunc(chatPushRecheck, func() {
			h.mu.Lock()
			o := h.owners[user]
			var jobs []chatPushJob
			if o != nil && o.isMember(conv, p) && !o.isOnline(p) {
				c := h.conv(o, conv)
				if msg := c.byID[id]; msg != nil && !msg.Deleted {
					jobs = h.pushTargets(o, c, msg, p)
				}
			}
			h.mu.Unlock()
			if len(jobs) > 0 {
				h.sendPushes(user, jobs)
			}
		})
	}
}

func (h *ChatHub) phrase(lang, key, builtin string) string {
	h.wordsMu.Lock()
	defer h.wordsMu.Unlock()
	return h.words.phrase(lang, key, builtin)
}

// pushBody is the notification's text, in the device's language.
func (h *ChatHub) pushBody(j chatPushJob) string {
	m := j.msg
	var line string
	switch m.Kind {
	case "photo":
		line = "📷 " + firstNonEmpty(clip(m.Text, 120), h.phrase(j.sub.Lang, "chat.photo", "Foto"))
	case "file":
		line = "📄 " + quoteText(&m)
	case "loc":
		line = "📍 " + h.phrase(j.sub.Lang, "chat.location", "Ubicación")
	case "card":
		line = "👤 " + quoteText(&m)
	case "poll":
		line = "📊 " + quoteText(&m)
	default:
		line = clip(m.Text, 180)
	}
	if j.group && j.from != "" {
		return j.from + ": " + line
	}
	return line
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// pushPayload is what one device is sent about a message.
func (h *ChatHub) pushPayload(j chatPushJob) map[string]any {
	link := URLPrefix + "/chat/?c=" + j.conv
	if j.person != "" {
		link = "/c/" + j.token + "/?c=" + j.conv
	}
	payload := map[string]any{
		"title": j.title,
		"body":  h.pushBody(j),
		"url":   link,
		"tag":   "chat-" + j.conv,
	}
	if j.msg.Silent {
		payload["quiet"] = true // sw.js, guest-sw.js: shown, but without a sound
	}
	return payload
}

func (h *ChatHub) sendPushes(owner string, jobs []chatPushJob) {
	for _, j := range jobs {
		payload := h.pushPayload(j)
		if j.owner != "" {
			deliverPush(h.push, h.users, h.log, j.owner, j.sub, payload, chatPushTTL)
			continue
		}
		deliverPushTo(h.push, h.log, j.sub, payload, chatPushTTL, h.forgetGuestSub(owner, j.person, j.sub.Endpoint))
	}
	traced(h, "pushed", len(jobs)) // every device asked, the dead ones forgotten
}

// forgetGuestSub is what a push to a person's device does when that device is
// gone for good: the subscription leaves their contact in `owner`'s chat.
func (h *ChatHub) forgetGuestSub(owner, person, endpoint string) func() {
	return func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if o := h.owners[owner]; o != nil {
			if c := o.contact(person); c != nil && removeSub(c, endpoint) {
				h.saveData(o)
				o.changed(true)
			}
		}
	}
}

func removeSub(c *ChatContact, endpoint string) bool {
	for i, s := range c.Subs {
		if s.Endpoint == endpoint {
			c.Subs = append(c.Subs[:i], c.Subs[i+1:]...)
			return true
		}
	}
	return false
}
