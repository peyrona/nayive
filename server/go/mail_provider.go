package main

// =============================================================================
// eMail: the common model every mail provider speaks (docs/email-app-plan.md).
// =============================================================================
//
// The app never sees IMAP, JMAP or any other protocol: it sees five TRAYS by
// role (inbox, drafts, sent, spam, trash), pages of message summaries, one
// message at a time and its parts. A provider maps its own world onto that -
// mail_imap.go is the first one; JMAP will be another file with the same
// methods and no change above it.
//
// A message is addressed by a MailRef: its tray, and the provider's own address
// of it - for IMAP the tray's UIDVALIDITY and the UID ("inbox.7.1234"), for
// JMAP the Email id ("inbox.j.M3fa9"). The app never looks inside: it is an
// opaque string to it. An IMAP ref from before a UIDVALIDITY change points at
// nothing and says so (errMailGone), never at another message.

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"
)

type MailRole string

const (
	RoleInbox  MailRole = "inbox"
	RoleDrafts MailRole = "drafts"
	RoleSent   MailRole = "sent"
	RoleSpam   MailRole = "spam"
	RoleTrash  MailRole = "trash"
)

// mailRoles is the trays, in the order the app shows them.
var mailRoles = []MailRole{RoleInbox, RoleDrafts, RoleSent, RoleSpam, RoleTrash}

func validRole(s string) (MailRole, bool) {
	for _, r := range mailRoles {
		if string(r) == s {
			return r, true
		}
	}
	return "", false
}

var (
	errMailAuth   = errors.New("mail: wrong user or password")
	errMailGone   = errors.New("mail: that message is not there any more")
	errMailNoTray = errors.New("mail: the server has no such tray")
	// the job is done, but a leftover stayed (SaveDraft: the old draft)
	errMailLeftover = errors.New("mail: done, but the old copy stayed")
	errMailRejected = errors.New("mail: the server refused it")
	// in none of the five trays, but still on the server (archived on the
	// phone, moved to a folder of its own): its labels stay (I3)
	errMailElsewhere = errors.New("mail: that message is in another folder")
	// the message was handed over and the line died before the server said
	// it took it: it MAY have gone - never "not sent" (I6)
	errMailUnsure = errors.New("mail: no answer once the message was handed over: it may have gone")
)

// mailRejectError: the mail server REFUSED (an unknown recipient, too big, a
// daily sending limit, over quota...) - it answered, so it is never "no
// answer". Text is its own words, shown to the user; errors.Is(err,
// errMailRejected) finds it.
type mailRejectError struct{ Text string }

func (e *mailRejectError) Error() string        { return "mail: refused: " + e.Text }
func (e *mailRejectError) Is(target error) bool { return target == errMailRejected }

// mailPartialError: some of the messages were done, these (refs, as
// strings) were not - the server refused them one by one. What Nayive keeps
// about a message (labels, the Trash clock) is dropped only for those done.
type mailPartialError struct{ Failed map[string]bool }

func (e *mailPartialError) Error() string {
	return "mail: " + strconv.Itoa(len(e.Failed)) + " message(s) were refused"
}

// mailFailed is the refs an error says were NOT done (nil: all or nothing).
func mailFailed(err error) map[string]bool {
	var pe *mailPartialError
	if errors.As(err, &pe) {
		return pe.Failed
	}
	return nil
}

// MailPoll is the Inbox as the poller sees it: the unread count (the badge),
// and a Mark that moves when mail ARRIVES - IMAP's UIDVALIDITY.UIDNEXT, JMAP's
// newest arrival - so "new mail" never depends on the count going up (one
// read + one new = the same count). Arrived is how many came since the mark
// given: 0 for "" or for a mark of another epoch.
type MailPoll struct {
	Unread  int
	Mark    string
	Arrived int
}

// MailChange is what Set does to some messages: any of the three.
type MailChange struct {
	Seen    *bool    `json:"seen,omitempty"`
	Flagged *bool    `json:"flagged,omitempty"`
	Move    MailRole `json:"tray,omitempty"` // to that tray
}

// MailTray is one of the five, with its counts. Missing: the server has no
// such folder (the app shows it empty).
type MailTray struct {
	Role    MailRole `json:"role"`
	Unread  int      `json:"unread"`
	Total   int      `json:"total"`
	Missing bool     `json:"missing,omitempty"`
}

type MailAddr struct {
	Name string `json:"name,omitempty"`
	Addr string `json:"addr"`
}

// MailSummary is one row of a list.
type MailSummary struct {
	Ref       string     `json:"ref"`
	MessageID string     `json:"mid,omitempty"`
	From      []MailAddr `json:"from"`
	To        []MailAddr `json:"to,omitempty"`
	Subject   string     `json:"subject"`
	Date      time.Time  `json:"date"`
	Snippet   string     `json:"snippet,omitempty"`
	Seen      bool       `json:"seen"`
	Flagged   bool       `json:"flagged"`
	Attach    bool       `json:"attach,omitempty"`
	Size      int64      `json:"size"`
	Labels    []string   `json:"labels,omitempty"` // Nayive's own (mail_labels.go), not the provider's
	Account   string     `json:"acct,omitempty"`   // set only where rows of several accounts mix (a label)
}

// MailPage is a list page, newest first. Next is the cursor of the page after
// it ("" = that was the last one).
type MailPage struct {
	Items []MailSummary `json:"items"`
	Next  string        `json:"next,omitempty"`
}

// MailPart is an attachment, or an inline picture the HTML shows (CID).
// Size is the FILE's size (decoded): estimated from the encoded size where
// the server gives only that (IMAP's BODYSTRUCTURE counts base64).
type MailPart struct {
	ID     string `json:"id"` // the part's path, "2" or "1.2"
	Name   string `json:"name"`
	Type   string `json:"type"`
	Size   int64  `json:"size"`
	CID    string `json:"cid,omitempty"`
	Inline bool   `json:"inline,omitempty"`
}

// MailMessage is one message, opened. HTML is as the sender wrote it: the API
// cleans it (mail_mime.go) before it leaves the server.
type MailMessage struct {
	MailSummary
	Cc      []MailAddr `json:"cc,omitempty"`
	Bcc     []MailAddr `json:"bcc,omitempty"` // only a draft has it
	ReplyTo []MailAddr `json:"replyTo,omitempty"`
	// a draft's To, Cc and Bcc as typed, when some of it was not an address
	// yet ("juan"): the writer shows these instead (mail_compose.go draftAddrs)
	ToText  string `json:"toText,omitempty"`
	CcText  string `json:"ccText,omitempty"`
	BccText string `json:"bccText,omitempty"`
	// the thread so far (its References header), for a reply to carry on
	References []string   `json:"references,omitempty"`
	Text       string     `json:"text,omitempty"`
	HTML       string     `json:"html,omitempty"`
	Parts      []MailPart `json:"parts,omitempty"`
	// Cut: the text or the HTML was too long and only its start is here
	Cut bool `json:"cut,omitempty"`
}

// MailRef is where one message is: "<role>.<uidvalidity>.<uid>".
type MailRef struct {
	Role        MailRole
	UIDValidity uint32 // IMAP
	UID         uint32 // IMAP
	ID          string // JMAP: the Email id (then the two above are 0)
}

func (r MailRef) String() string {
	if r.ID != "" {
		return string(r.Role) + ".j." + r.ID
	}
	return string(r.Role) + "." + strconv.FormatUint(uint64(r.UIDValidity), 10) + "." +
		strconv.FormatUint(uint64(r.UID), 10)
}

// jmapIDOK: JMAP ids are 1-255 of A-Z a-z 0-9 - _ (RFC 8620 1.2).
func jmapIDOK(id string) bool {
	if id == "" || len(id) > 255 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func parseMailRef(s string) (MailRef, bool) {
	p := strings.Split(s, ".")
	if len(p) != 3 {
		return MailRef{}, false
	}
	role, ok := validRole(p[0])
	if !ok {
		return MailRef{}, false
	}
	if p[1] == "j" {
		if !jmapIDOK(p[2]) {
			return MailRef{}, false
		}
		return MailRef{Role: role, ID: p[2]}, true
	}
	v, err1 := strconv.ParseUint(p[1], 10, 32)
	u, err2 := strconv.ParseUint(p[2], 10, 32)
	if err1 != nil || err2 != nil || u == 0 {
		return MailRef{}, false
	}
	return MailRef{Role: role, UIDValidity: uint32(v), UID: uint32(u)}, true
}

// MailProvider is one account's mail server. Every method may be called from
// several goroutines; a provider serialises its own connection.
type MailProvider interface {
	// Trays is the five, with their counts.
	Trays(ctx context.Context) ([]MailTray, error)
	// List is one page of a tray, newest first; `query` searches the tray
	// (headers and text), `cursor` is a MailPage.Next.
	List(ctx context.Context, role MailRole, query, cursor string) (MailPage, error)
	// Message opens one message and marks it read.
	Message(ctx context.Context, ref MailRef) (MailMessage, error)
	// Attachment is one part, decoded.
	Attachment(ctx context.Context, ref MailRef, part string) (MailPart, []byte, error)
	// Poll is the Inbox's unread count (the launcher's badge) and whether mail
	// arrived since `mark` (a MailPoll.Mark of an earlier Poll, or "").
	Poll(ctx context.Context, mark string) (MailPoll, error)
	// LatestUnseen is the Inbox's newest unread message (the push's text);
	// false when there is none.
	LatestUnseen(ctx context.Context) (MailSummary, bool, error)

	// Set changes messages, which may lie in several trays. A move answers
	// each message's new ref, old -> new, where the server tells it (UIDPLUS).
	// Some refused one by one: a *mailPartialError naming them.
	Set(ctx context.Context, refs []MailRef, change MailChange) (map[string]MailRef, error)
	// Expunge deletes messages for good - only where the ref says they are
	// (a message that moved since is left alone, never another one). Some
	// refused one by one: a *mailPartialError naming them.
	Expunge(ctx context.Context, refs []MailRef) error
	// Summaries is the rows of some messages (no snippets), in no set order;
	// one that is gone is simply left out.
	Summaries(ctx context.Context, refs []MailRef) ([]MailSummary, error)
	// Find is where a message is now, by its Message-ID - exactly that one,
	// never a partial match - looking in `roles` (all five when nil);
	// errMailGone when nowhere.
	Find(ctx context.Context, messageID string, roles []MailRole) (MailSummary, error)
	// Scan is every message of a tray (no snippets): the Trash purge.
	Scan(ctx context.Context, role MailRole) ([]MailSummary, error)

	// Send hands a built message to the server for `rcpts` (and keeps a
	// copy in Sent: `copy`, which may differ from raw - it keeps the Bcc).
	// Once the server took it, a failure after that is errMailNoCopy, never
	// "not sent". A refusal is a *mailRejectError.
	Send(ctx context.Context, raw, copy []byte, from string, rcpts []string) error
	// SaveDraft stores a built message in Drafts, replacing `old`. Its parts
	// as the provider names them - nil: the files are parts 2, 3... in order
	// (mailDraftParts), as an IMAP server keeps what it is given. Stored but
	// the old one not removed: the new ref WITH errMailLeftover.
	SaveDraft(ctx context.Context, raw []byte, mid string, old *MailRef) (MailRef, []MailPart, error)

	// Close drops the connection, if any.
	Close()
}

// mailAnywhere: a provider that can tell whether a Message-ID is anywhere at
// all on the server - not only in the five trays (Find). A label's tag is
// dropped only when it is nowhere (data-safety I3). A name it cannot search
// for ("h:") answers true: the safe side.
type mailAnywhere interface {
	Anywhere(ctx context.Context, messageID string) (bool, error)
}

// mailFinderAll: a provider that can name EVERY copy of a Message-ID in a
// tray (Find gives only the newest): a mail to yourself deleted from the
// Inbox and from Sent sits in the Trash twice (data-safety I9).
type mailFinderAll interface {
	FindAll(ctx context.Context, messageID string, role MailRole) ([]MailSummary, error)
}

// mailTrashGuess: a provider whose Trash may be a guess by its name (IMAP
// with no SPECIAL-USE): the purge deletes for good only from the folder it
// first took for the Trash (data-safety I7).
type mailTrashGuess interface {
	trashFolder(ctx context.Context) (folder string, marked bool, err error)
}

// mailSendChecker: a provider that can check, before an account is kept,
// that it will be able to SEND (SMTP: connect + log in; JMAP: submission
// offered). The hub asks it when adding an account.
type mailSendChecker interface {
	CheckSend(ctx context.Context) error
}
