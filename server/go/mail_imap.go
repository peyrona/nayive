package main

// =============================================================================
// eMail: the IMAP provider (reading). SMTP (sending) joins it in phase 3.
// =============================================================================
//
// One connection per account, opened on first use and kept: the unread poll
// (mail.go) touches it every couple of minutes, which is also what keeps a
// server like Gmail from dropping it. Every command runs holding p.lock - IMAP
// has ONE selected folder per connection, so two requests must never
// interleave. A waiter gives up with its own context. A command that fails
// because the connection died is retried once on a fresh one; an IMAP
// "NO"/"BAD" is an answer, not a dead line, and is not retried. Big transfers
// (an attachment, a big draft or Sent copy) go over a SECOND, short-lived
// connection, so the list and the badge never queue behind them.
//
// Trays: SPECIAL-USE attributes first (\Sent \Drafts \Junk \Trash - Gmail's
// "[Gmail]/Sent Mail" and friends carry them), then the usual names. Every
// other folder (Gmail's own labels, All Mail, Starred) is simply not shown.
//
// Paging is newest first, by sequence number, and the cursor is the LOWEST
// UID shown: the next page starts under wherever that message is now, so new
// mail arriving while one scrolls never shifts or repeats a page.

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"mime"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message/charset"
)

const (
	mailPageSize    = 50
	mailSnippetLen  = 2048             // bytes of a text part read for the row's snippet
	mailSnippetHTML = 16 << 10         // ... of an HTML one: its <head> and <style> come first
	mailBodyMax     = 2 << 20          // bytes of one body part read to show it (more: Message.Cut)
	mailCmdTimeout  = 90 * time.Second // one provider call, all its commands
	mailDialTime    = 20 * time.Second
	mailBigAppend   = 1 << 20 // an APPEND bigger than this goes over its own connection
	mailSideMax     = 2       // side connections of one account at a time (Gmail allows 15 in all)
)

// mailScanChunk is how many envelopes one FETCH of a whole tray asks for
// (a var: the tests make it small).
var mailScanChunk = 500

// mailLoginTime bounds the whole opening of a connection - TLS, greeting,
// STARTTLS, LOGIN: go-imap waits for a reply with no deadline, so a server
// that stops answering half-way would otherwise hold the account for good.
var mailLoginTime = 45 * time.Second

type imapProvider struct {
	acct MailAccount

	lock    chan struct{}       // held (full) while a call uses c; see do
	slots   chan struct{}       // side connections open now (at most mailSideMax)
	c       *imapclient.Client  // the shared connection; only while holding lock
	folders map[MailRole]string // role -> real folder name, found once per connection
	marked  map[MailRole]bool   // ...and those the server marked itself (SPECIAL-USE), not guessed
	sel     string              // the folder selected on c ("" = none)
	selData *imap.SelectData

	dial      func(MailAccount) (*imapclient.Client, error) // tests reach an in-memory server
	smtp      func(ctx context.Context, a MailAccount, from string, rcpts []string, raw []byte) error
	smtpCheck func(ctx context.Context, a MailAccount) error
}

func newIMAPProvider(a MailAccount) *imapProvider {
	return &imapProvider{acct: a, lock: make(chan struct{}, 1), slots: make(chan struct{}, mailSideMax),
		dial: dialIMAP, smtp: smtpSend, smtpCheck: smtpCheck}
}

var mailWordDecoder = &mime.WordDecoder{CharsetReader: charset.Reader}

var errMailSlow = errors.New("mail: the IMAP server stopped answering")

// dialIMAP opens and logs in: TLS on 993, STARTTLS anywhere else - never plain.
// The whole of it runs on one clock (mailLoginTime): past it, the socket is
// closed under whatever step is waiting.
func dialIMAP(a MailAccount) (*imapclient.Client, error) {
	addr := net.JoinHostPort(a.IMAPHost, strconv.Itoa(a.IMAPPort))
	tlsCfg := &tls.Config{ServerName: a.IMAPHost, MinVersion: tls.VersionTLS12, RootCAs: mailTLSRoots}
	opts := &imapclient.Options{WordDecoder: mailWordDecoder, Dialer: mailDialer(), TLSConfig: tlsCfg}
	raw, err := mailDialer().Dial("tcp", addr)
	if err != nil {
		return nil, err
	}
	late := time.AfterFunc(mailLoginTime, func() { raw.Close() })
	defer late.Stop()
	var c *imapclient.Client
	if a.IMAPPort == 993 {
		tc := tls.Client(raw, tlsCfg)
		if err := tc.Handshake(); err != nil {
			raw.Close()
			return nil, err
		}
		c = imapclient.New(tc, opts)
	} else if c, err = imapclient.NewStartTLS(raw, opts); err != nil {
		raw.Close()
		return nil, err
	}
	err = c.Login(a.User, a.Pass).Wait()
	if !late.Stop() { // the clock ran out: the socket is closed already
		c.Close()
		return nil, errMailSlow
	}
	if err != nil {
		c.Close()
		return nil, imapLoginError(err)
	}
	return c, nil
}

// imapLoginError: only a refused login is "wrong password". Gmail's "IMAP is
// off for this account" or "too many connections" come as [ALERT]s: the
// server's own words go to the user (mailRejectError); a server that is
// down for a while ([UNAVAILABLE]) is "no answer".
func imapLoginError(err error) error {
	var ie *imap.Error
	if !errors.As(err, &ie) {
		return err
	}
	switch ie.Code {
	case "", imap.ResponseCodeAuthenticationFailed, imap.ResponseCodeAuthorizationFailed:
		return errMailAuth
	case imap.ResponseCodeUnavailable:
		return err
	}
	text := strings.TrimSpace(ie.Text)
	if text == "" {
		text = string(ie.Code)
	}
	return &mailRejectError{Text: text}
}

// acquire takes the connection's lock - or gives up with ctx.
func (p *imapProvider) acquire(ctx context.Context) error {
	select {
	case p.lock <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *imapProvider) release() { <-p.lock }

func (p *imapProvider) Close() {
	p.lock <- struct{}{}
	defer p.release()
	p.dropLocked()
}

func (p *imapProvider) dropLocked() {
	if p.c != nil {
		p.c.Close()
	}
	p.c, p.folders, p.marked, p.sel, p.selData = nil, nil, nil, "", nil
}

// do runs fn on the live, logged-in shared connection, retried once on a
// fresh one when the line died.
func (p *imapProvider) do(ctx context.Context, fn func(c *imapclient.Client) error) error {
	return p.run(ctx, fn, true)
}

// doOnce is do without the retry: for a command that must never run twice
// (an APPEND the server may have stored before the line died).
func (p *imapProvider) doOnce(ctx context.Context, fn func(c *imapclient.Client) error) error {
	return p.run(ctx, fn, false)
}

// run: a caller that has left already (ctx done) gets nothing started. Once
// started, a command runs on its own clock (mailCmdTimeout, not the
// caller's context): a phone locking mid-request must not cut the shared
// connection in the middle of a command - that would cost everyone a new
// TLS + LOGIN. Past the clock the connection is closed under it: a hung
// server never keeps the lock.
func (p *imapProvider) run(ctx context.Context, fn func(c *imapclient.Client) error, retry bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	wait, stop := context.WithTimeout(ctx, mailCmdTimeout)
	err := p.acquire(wait)
	stop()
	if err != nil {
		return err
	}
	defer p.release()
	if err := ctx.Err(); err != nil { // left while waiting in line
		return err
	}

	clock, cancel := context.WithTimeout(context.WithoutCancel(ctx), mailCmdTimeout)
	defer cancel()
	for attempt := 0; ; attempt++ {
		if p.c != nil {
			select {
			case <-p.c.Closed():
				p.dropLocked()
			default:
			}
		}
		used, err := p.attempt(clock, p.c, fn)
		if used == nil { // the dial failed, or the clock ran out (and closed it)
			p.dropLocked()
			return err
		}
		if p.c == nil {
			p.c = used
		}
		if err == nil {
			return nil
		}
		var ie *imap.Error
		if errors.As(err, &ie) || errors.Is(err, errMailGone) || errors.Is(err, errMailNoTray) ||
			errors.Is(err, errMailLeftover) || attempt > 0 || !retry {
			return err
		}
		p.dropLocked() // the line died: once more, on a new one
	}
}

// attempt runs fn on c - or, c nil, on a connection dialed for it - on the
// clock. Past it, the connection is closed under fn (a dial still under way
// closes what it gets) and attempt waits for the goroutine to end: nothing
// of fn runs on after it returns. It answers the connection fn ran on (nil:
// the dial failed, or the clock ran out).
func (p *imapProvider) attempt(clock context.Context, c *imapclient.Client, fn func(*imapclient.Client) error) (*imapclient.Client, error) {
	var mu sync.Mutex
	used, dead := c, false
	done := make(chan error, 1)
	go func() {
		cc := c
		if cc == nil {
			var err error
			if cc, err = p.dial(p.acct); err != nil {
				done <- err
				return
			}
			mu.Lock()
			if dead {
				mu.Unlock()
				cc.Close()
				done <- errMailSlow
				return
			}
			used = cc
			mu.Unlock()
		}
		done <- fn(cc)
	}()
	select {
	case err := <-done:
		mu.Lock()
		defer mu.Unlock()
		return used, err
	case <-clock.Done():
		mu.Lock()
		dead = true
		if used != nil {
			used.Close()
		}
		mu.Unlock()
		<-done
		return nil, clock.Err()
	}
}

// side runs fn on a connection of its own, opened for it and closed after:
// big transfers, so the shared one stays free for the list and the badge.
// fn must not touch p's shared state (folders, the selected folder).
func (p *imapProvider) side(ctx context.Context, fn func(c *imapclient.Client) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	wait, stop := context.WithTimeout(ctx, mailCmdTimeout)
	defer stop()
	select {
	case p.slots <- struct{}{}:
	case <-wait.Done():
		return wait.Err()
	}
	defer func() { <-p.slots }()
	clock, cancel := context.WithTimeout(context.WithoutCancel(ctx), mailCmdTimeout)
	defer cancel()
	used, err := p.attempt(clock, nil, fn)
	if used != nil {
		used.Close()
	}
	return err
}

// folderOf is the real folder of a role, from the shared connection's list.
func (p *imapProvider) folderOf(ctx context.Context, role MailRole) (string, error) {
	folder := ""
	err := p.do(ctx, func(c *imapclient.Client) error {
		var err error
		folder, err = p.folderFor(c, role)
		return err
	})
	return folder, err
}

// folderFor is the real folder of a role, "" when the server has none.
func (p *imapProvider) folderFor(c *imapclient.Client, role MailRole) (string, error) {
	if p.folders == nil {
		// Most servers (Gmail too) put the \Sent... marks on a plain LIST as
		// well; asking for them is the standard way, where it is offered.
		var opts *imap.ListOptions
		if caps := c.Caps(); caps.Has(imap.CapSpecialUse) && caps.Has(imap.CapListExtended) {
			opts = &imap.ListOptions{ReturnSpecialUse: true}
		}
		list, err := c.List("", "*", opts).Collect()
		if err != nil {
			return "", err
		}
		p.folders, p.marked = mapIMAPFoldersMarked(list)
	}
	return p.folders[role], nil
}

// trashFolder (mailTrashGuess): the Trash's real folder, and whether the
// server marked it \Trash itself - false: a guess by its name (I7).
func (p *imapProvider) trashFolder(ctx context.Context) (string, bool, error) {
	folder, marked := "", false
	err := p.do(ctx, func(c *imapclient.Client) error {
		var err error
		folder, err = p.folderFor(c, RoleTrash)
		marked = p.marked[RoleTrash]
		return err
	})
	return folder, marked, err
}

var mailFolderNames = map[MailRole][]string{
	RoleSent:   {"sent", "sent items", "sent messages", "sent mail", "enviados", "elementos enviados"},
	RoleDrafts: {"drafts", "draft", "borradores"},
	RoleSpam:   {"spam", "junk", "junk e-mail", "junk email", "bulk mail", "correo no deseado"},
	RoleTrash:  {"trash", "deleted items", "deleted messages", "bin", "papelera", "elementos eliminados"},
}

func mapIMAPFolders(list []*imap.ListData) map[MailRole]string {
	out, _ := mapIMAPFoldersMarked(list)
	return out
}

// mapIMAPFoldersMarked is mapIMAPFolders, and the roles the server itself
// marked (SPECIAL-USE) - the others are guesses by name.
func mapIMAPFoldersMarked(list []*imap.ListData) (map[MailRole]string, map[MailRole]bool) {
	out, marked := map[MailRole]string{}, map[MailRole]bool{}
	byAttr := map[imap.MailboxAttr]MailRole{
		imap.MailboxAttrSent: RoleSent, imap.MailboxAttrDrafts: RoleDrafts,
		imap.MailboxAttrJunk: RoleSpam, imap.MailboxAttrTrash: RoleTrash,
	}
	selectable := list[:0:0]
	for _, m := range list {
		noSelect := false
		for _, a := range m.Attrs {
			if a == imap.MailboxAttrNoSelect || a == imap.MailboxAttrNonExistent {
				noSelect = true
			}
		}
		if noSelect {
			continue
		}
		selectable = append(selectable, m)
		if strings.EqualFold(m.Mailbox, "INBOX") {
			out[RoleInbox] = m.Mailbox
		}
		for _, a := range m.Attrs {
			if r, ok := byAttr[a]; ok && out[r] == "" {
				out[r], marked[r] = m.Mailbox, true
			}
		}
	}
	for role, names := range mailFolderNames {
		if out[role] != "" {
			continue
		}
		for _, m := range selectable {
			leaf, parent := m.Mailbox, ""
			if m.Delim != 0 {
				if i := strings.LastIndexByte(leaf, byte(m.Delim)); i >= 0 {
					leaf, parent = leaf[i+1:], leaf[:i]
				}
			}
			// The Trash and Spam (whose mail Nayive deletes for good) are
			// guessed only at the top, or right under INBOX (Courier's and
			// cPanel's "INBOX.Trash") - never inside a folder of the user's
			// own: "Archive/Bin" or "Clientes/Papelera" taken as THE Trash
			// got Inbox mail moved into it, and the purge deleted what the
			// user keeps there (data-safety I7, mail-chat #6).
			if (role == RoleTrash || role == RoleSpam) && parent != "" && !strings.EqualFold(parent, "INBOX") {
				continue
			}
			if contains(names, strings.ToLower(leaf)) {
				out[role] = m.Mailbox
				break
			}
		}
	}
	return out, marked
}

// selectFolder selects `folder` read-write (opening a message marks it read).
// fresh: select again even when it already is, for up-to-date counts.
func (p *imapProvider) selectFolder(c *imapclient.Client, folder string, fresh bool) (*imap.SelectData, error) {
	if !fresh && p.sel == folder && p.selData != nil {
		return p.selData, nil
	}
	p.sel, p.selData = "", nil
	d, err := c.Select(folder, nil).Wait()
	if err != nil {
		return nil, err
	}
	p.sel, p.selData = folder, d
	return d, nil
}

// Poll: one STATUS - the unread count, and UIDVALIDITY.UIDNEXT as the mark
// (UIDNEXT grows by one for each message that arrives in the Inbox).
func (p *imapProvider) Poll(ctx context.Context, mark string) (MailPoll, error) {
	var out MailPoll
	err := p.do(ctx, func(c *imapclient.Client) error {
		inbox, err := p.folderFor(c, RoleInbox)
		if err != nil || inbox == "" {
			return err
		}
		st, err := c.Status(inbox, &imap.StatusOptions{NumUnseen: true, UIDNext: true, UIDValidity: true}).Wait()
		if err != nil {
			return err
		}
		if st.NumUnseen != nil {
			out.Unread = int(*st.NumUnseen)
		}
		if st.UIDNext != 0 {
			out.Mark = strconv.FormatUint(uint64(st.UIDValidity), 10) + "." + strconv.FormatUint(uint64(st.UIDNext), 10)
			if v, n, ok := strings.Cut(mark, "."); ok && v == strconv.FormatUint(uint64(st.UIDValidity), 10) {
				if before, err := strconv.ParseUint(n, 10, 32); err == nil && uint64(st.UIDNext) > before {
					out.Arrived = int(uint64(st.UIDNext) - before)
				}
			}
		}
		return nil
	})
	return out, err
}

func (p *imapProvider) Trays(ctx context.Context) ([]MailTray, error) {
	var out []MailTray
	err := p.do(ctx, func(c *imapclient.Client) error {
		out = out[:0]
		for _, role := range mailRoles {
			folder, err := p.folderFor(c, role)
			if err != nil {
				return err
			}
			t := MailTray{Role: role}
			if folder == "" {
				t.Missing = true
				out = append(out, t)
				continue
			}
			st, err := c.Status(folder, &imap.StatusOptions{NumMessages: true, NumUnseen: true}).Wait()
			if err != nil {
				return err
			}
			if st.NumMessages != nil {
				t.Total = int(*st.NumMessages)
			}
			if st.NumUnseen != nil {
				t.Unread = int(*st.NumUnseen)
			}
			out = append(out, t)
		}
		return nil
	})
	return out, err
}

var mailListFetch = &imap.FetchOptions{
	UID: true, Flags: true, Envelope: true, RFC822Size: true, InternalDate: true,
	BodyStructure: &imap.FetchItemBodyStructure{Extended: true},
}

func (p *imapProvider) List(ctx context.Context, role MailRole, query, cursor string) (MailPage, error) {
	page := MailPage{Items: []MailSummary{}}
	err := p.do(ctx, func(c *imapclient.Client) error {
		page = MailPage{Items: []MailSummary{}}
		folder, err := p.folderFor(c, role)
		if err != nil || folder == "" {
			return err
		}
		sel, err := p.selectFolder(c, folder, true)
		if err != nil {
			return err
		}
		uidv := sel.UIDValidity

		// the cursor: "<uidvalidity>.<lowest uid shown>"; another uidvalidity = start over
		var below imap.UID
		if v, u, ok := strings.Cut(cursor, "."); ok {
			vv, _ := strconv.ParseUint(v, 10, 32)
			uu, _ := strconv.ParseUint(u, 10, 32)
			if uint32(vv) == uidv {
				below = imap.UID(uu)
			}
		}

		var msgs []*imapclient.FetchMessageBuffer
		more := false
		if query == "" && sel.NumMessages > 0 {
			hi := sel.NumMessages
			if below > 0 {
				hi = 0
				got, err := c.Fetch(imap.UIDSetNum(below), &imap.FetchOptions{UID: true}).Collect()
				if err != nil {
					return err
				}
				if len(got) > 0 { // (an unsolicited flag update for it may come too: same number)
					hi = got[0].SeqNum - 1
				} else {
					// that message went away meanwhile: find its neighbours by UID
					return p.listByUIDs(c, &imap.SearchCriteria{}, below, uidv, role, &page)
				}
			}
			if hi == 0 {
				return nil
			}
			lo := uint32(1)
			if hi > mailPageSize {
				lo = hi - mailPageSize + 1
			}
			var set imap.SeqSet
			set.AddRange(lo, hi)
			if msgs, err = c.Fetch(set, mailListFetch).Collect(); err != nil {
				return err
			}
			msgs = withEnvelope(msgs)
			more = lo > 1
		} else if query != "" {
			return p.listByUIDs(c, &imap.SearchCriteria{Text: mailSearchWords(query)}, below, uidv, role, &page)
		}
		p.fillPage(c, msgs, more, uidv, role, &page)
		return nil
	})
	return page, err
}

// mailSearchWords splits a search into its words - each its own TEXT key,
// which IMAP ANDs: "factura enero" finds mails holding both, anywhere. A
// "quoted phrase" stays one key.
func mailSearchWords(q string) []string {
	var out []string
	for q = strings.TrimSpace(q); q != ""; q = strings.TrimSpace(q) {
		if q[0] == '"' {
			if end := strings.IndexByte(q[1:], '"'); end >= 0 {
				if w := strings.TrimSpace(q[1 : end+1]); w != "" {
					out = append(out, w)
				}
				q = q[end+2:]
				continue
			}
			q = q[1:]
			continue
		}
		w := q
		if i := strings.IndexAny(q, " \t\""); i >= 0 {
			w, q = q[:i], q[i:]
		} else {
			q = ""
		}
		out = append(out, w)
	}
	return out
}

// listByUIDs is a page out of a SEARCH: its newest mailPageSize UIDs under `below`.
func (p *imapProvider) listByUIDs(c *imapclient.Client, crit *imap.SearchCriteria, below imap.UID,
	uidv uint32, role MailRole, page *MailPage) error {
	if below > 0 {
		if below == 1 {
			return nil
		}
		var set imap.UIDSet
		set.AddRange(1, below-1)
		crit.UID = []imap.UIDSet{set}
	}
	res, err := c.UIDSearch(crit, nil).Wait()
	if err != nil {
		return err
	}
	uids := res.AllUIDs()
	if len(uids) == 0 {
		return nil
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })
	more := len(uids) > mailPageSize
	if more {
		uids = uids[len(uids)-mailPageSize:]
	}
	msgs, err := c.Fetch(imap.UIDSetNum(uids...), mailListFetch).Collect()
	if err != nil {
		return err
	}
	p.fillPage(c, withEnvelope(msgs), more, uidv, role, page)
	return nil
}

// fillPage turns fetched messages into rows, newest first, with their
// snippets: the first 2 KB of each one's text part, all asked for at once
// (pipelined) and decoded here. A snippet that fails is just left out.
func (p *imapProvider) fillPage(c *imapclient.Client, msgs []*imapclient.FetchMessageBuffer,
	more bool, uidv uint32, role MailRole, page *MailPage) {
	sort.Slice(msgs, func(i, j int) bool { return msgs[i].UID > msgs[j].UID })

	type snip struct {
		leaf mailLeaf
		sec  *imap.FetchItemBodySection
		cmd  *imapclient.FetchCommand
	}
	snips := make([]*snip, len(msgs))
	for i, m := range msgs {
		body, _, _ := splitMailParts(m.BodyStructure)
		var leaf *mailLeaf
		size := int64(mailSnippetLen)
		if len(body.text) > 0 {
			leaf = body.text[0]
		} else if len(body.html) > 0 {
			leaf, size = body.html[0], mailSnippetHTML // its <head> and <style> come first
		}
		if leaf == nil {
			continue
		}
		sec := &imap.FetchItemBodySection{Part: leaf.path, Peek: true,
			Partial: &imap.SectionPartial{Offset: 0, Size: size}}
		snips[i] = &snip{leaf: *leaf, sec: sec,
			cmd: c.Fetch(imap.UIDSetNum(m.UID), &imap.FetchOptions{UID: true, BodySection: []*imap.FetchItemBodySection{sec}})}
	}

	for i, m := range msgs {
		row := imapSummary(m, uidv, role)
		if s := snips[i]; s != nil {
			if got, err := s.cmd.Collect(); err == nil && withSection(got, s.sec) != nil {
				raw := withSection(got, s.sec).FindBodySection(s.sec)
				row.Snippet = mailSnippet(mailLeafText(raw, s.leaf.part, true), s.leaf.part.MediaType() == "text/html")
			}
		}
		page.Items = append(page.Items, row)
	}
	if more && len(msgs) > 0 {
		page.Next = strconv.FormatUint(uint64(uidv), 10) + "." + strconv.FormatUint(uint64(msgs[len(msgs)-1].UID), 10)
	}
}

func imapSummary(m *imapclient.FetchMessageBuffer, uidv uint32, role MailRole) MailSummary {
	s := MailSummary{
		Ref:  MailRef{Role: role, UIDValidity: uidv, UID: uint32(m.UID)}.String(),
		From: []MailAddr{},
		Size: m.RFC822Size,
		Date: m.InternalDate,
	}
	for _, f := range m.Flags {
		switch f {
		case imap.FlagSeen:
			s.Seen = true
		case imap.FlagFlagged:
			s.Flagged = true
		}
	}
	if e := m.Envelope; e != nil {
		s.Subject = e.Subject
		s.MessageID = e.MessageID
		s.From = imapAddrs(e.From)
		s.To = imapAddrs(e.To)
		if !e.Date.IsZero() {
			s.Date = e.Date
		}
	}
	if s.MessageID == "" {
		s.MessageID = mailHashID(s) // labels and the Trash need SOME name for it
	}
	if m.BodyStructure != nil {
		_, parts, _ := splitMailParts(m.BodyStructure)
		for _, pt := range parts {
			if !pt.Inline {
				s.Attach = true
				break
			}
		}
	}
	return s
}

func imapAddrs(list []imap.Address) []MailAddr {
	out := []MailAddr{}
	for _, a := range list {
		if a.IsGroupStart() || a.IsGroupEnd() {
			continue
		}
		out = append(out, MailAddr{Name: a.Name, Addr: a.Addr()})
	}
	return out
}

// the message itself -------------------------------------------------------

// selectRef selects the ref's folder and checks its UIDVALIDITY.
func (p *imapProvider) selectRef(c *imapclient.Client, ref MailRef) error {
	folder, err := p.folderFor(c, ref.Role)
	if err != nil {
		return err
	}
	if folder == "" {
		return errMailGone
	}
	sel, err := p.selectFolder(c, folder, false)
	if err != nil {
		return err
	}
	if sel.UIDValidity != ref.UIDValidity {
		return errMailGone
	}
	return nil
}

// Message opens one: its row, the thread headers (with the row, one FETCH),
// then every body leaf - each read up to mailBodyMax (more: msg.Cut) - and
// marks it read.
func (p *imapProvider) Message(ctx context.Context, ref MailRef) (MailMessage, error) {
	var msg MailMessage
	err := p.do(ctx, func(c *imapclient.Client) error {
		if err := p.selectRef(c, ref); err != nil {
			return err
		}
		uid := imap.UIDSetNum(imap.UID(ref.UID))
		thread := &imap.FetchItemBodySection{Specifier: imap.PartSpecifierHeader,
			HeaderFields: []string{"References", "In-Reply-To", mailTypedTo, mailTypedCc, mailTypedBcc}, Peek: true}
		opts := *mailListFetch
		opts.BodySection = []*imap.FetchItemBodySection{thread}
		got, err := c.Fetch(uid, &opts).Collect()
		if err != nil {
			return err
		}
		if got = withEnvelope(got); len(got) != 1 {
			return errMailGone
		}
		m := got[0]
		msg = MailMessage{MailSummary: imapSummary(m, ref.UIDValidity, ref.Role)}
		if e := m.Envelope; e != nil {
			msg.Cc = imapAddrs(e.Cc)
			msg.Bcc = imapAddrs(e.Bcc)
			msg.ReplyTo = imapAddrs(e.ReplyTo)
		}
		// the thread so far: its References - or, a parent with none, its
		// In-Reply-To (RFC 5322 3.6.4)
		head := m.FindBodySection(thread)
		if msg.References = parseMsgIDs(head, "References"); len(msg.References) == 0 {
			if irt := parseMsgIDs(head, "In-Reply-To"); len(irt) == 1 {
				msg.References = irt
			}
		}
		if ref.Role == RoleDrafts {
			msg.keepTyped(headerText(head, mailTypedTo), headerText(head, mailTypedCc), headerText(head, mailTypedBcc))
		}

		body, parts, _ := splitMailParts(m.BodyStructure)
		msg.Parts = parts
		var secs []*imap.FetchItemBodySection
		var leaves []*mailLeaf
		for _, l := range append(append([]*mailLeaf{}, body.text...), body.html...) {
			sec := &imap.FetchItemBodySection{Part: l.path, Peek: true}
			if int64(l.part.Size) > mailBodyMax {
				sec.Partial = &imap.SectionPartial{Offset: 0, Size: mailBodyMax}
				msg.Cut = true
			}
			secs = append(secs, sec)
			leaves = append(leaves, l)
		}
		if len(secs) > 0 {
			got, err := c.Fetch(uid, &imap.FetchOptions{UID: true, BodySection: secs}).Collect()
			if err != nil {
				return err
			}
			if b := withSection(got, secs[0]); b != nil {
				var text, html []string
				for i, l := range leaves {
					t := mailLeafText(b.FindBodySection(secs[i]), l.part, secs[i].Partial != nil)
					if l.part.MediaType() == "text/html" {
						html = append(html, t)
					} else {
						text = append(text, t)
					}
				}
				msg.Text = strings.Join(text, "\n")
				msg.HTML = strings.Join(html, "\n")
			}
		}

		if !msg.Seen {
			err := c.Store(uid, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true,
				Flags: []imap.Flag{imap.FlagSeen}}, nil).Close()
			if err == nil {
				msg.Seen = true
			}
		}
		return nil
	})
	return msg, err
}

// mailSideMin: a part at least this big (encoded) is fetched over a
// connection of its own; the small ones (a message's inline pictures, often
// many) stay on the shared one - a connection per picture would soon pass
// Gmail's 15 at a time.
const mailSideMin = 1 << 20

// Attachment is one part, decoded. A big one comes over a connection of its
// own (side), read-only, so the list and the badge never wait behind it.
func (p *imapProvider) Attachment(ctx context.Context, ref MailRef, part string) (MailPart, []byte, error) {
	var info MailPart
	var data []byte
	var leaf *mailLeaf
	folder := ""
	find := func(c *imapclient.Client) error {
		uid := imap.UIDSetNum(imap.UID(ref.UID))
		got, err := c.Fetch(uid, &imap.FetchOptions{UID: true,
			BodyStructure: &imap.FetchItemBodyStructure{Extended: true}}).Collect()
		if err != nil {
			return err
		}
		var bs imap.BodyStructure
		for _, m := range got { // (not an unsolicited flag update)
			if m.BodyStructure != nil {
				bs = m.BodyStructure
			}
		}
		if bs == nil {
			return errMailGone
		}
		_, parts, leaves := splitMailParts(bs)
		leaf = nil
		for i := range parts {
			if parts[i].ID == part {
				info, leaf = parts[i], leaves[i]
			}
		}
		if leaf == nil {
			return errMailGone
		}
		return nil
	}
	read := func(c *imapclient.Client) error {
		sec := &imap.FetchItemBodySection{Part: leaf.path, Peek: true}
		got, err := c.Fetch(imap.UIDSetNum(imap.UID(ref.UID)), &imap.FetchOptions{UID: true,
			BodySection: []*imap.FetchItemBodySection{sec}}).Collect()
		if err != nil {
			return err
		}
		b := withSection(got, sec)
		if b == nil {
			return errMailGone
		}
		data = decodeTransfer(b.FindBodySection(sec), leaf.part.Encoding, false)
		return nil
	}
	big := false
	err := p.do(ctx, func(c *imapclient.Client) error {
		if err := p.selectRef(c, ref); err != nil {
			return err
		}
		folder = p.sel
		if err := find(c); err != nil {
			return err
		}
		if big = int64(leaf.part.Size) >= mailSideMin; big {
			return nil
		}
		return read(c)
	})
	if err != nil || !big {
		return info, data, err
	}
	err = p.side(ctx, func(c *imapclient.Client) error {
		sel, err := c.Select(folder, &imap.SelectOptions{ReadOnly: true}).Wait()
		if err != nil {
			return err
		}
		if sel.UIDValidity != ref.UIDValidity {
			return errMailGone
		}
		return read(c)
	})
	return info, data, err
}

// the body structure ---------------------------------------------------------

type mailLeaf struct {
	path []int
	part *imap.BodyStructureSinglePart
}

// mailBody is a message's body: its plain-text leaves and its HTML ones -
// usually one of each, but Apple Mail splits a body around an inline file
// (multipart/mixed [html, file, html]): the pieces are joined, in order.
type mailBody struct{ text, html []*mailLeaf }

// splitMailParts sorts a message's leaves into its body (every plain text
// and HTML leaf that is not an attachment: no file name, not "attachment")
// and its parts (everything else: files, inline pictures, forwarded
// messages - whose own insides are not walked). leaves[i] is parts[i]'s leaf.
func splitMailParts(bs imap.BodyStructure) (mailBody, []MailPart, []*mailLeaf) {
	var body mailBody
	parts := []MailPart{}
	var leaves []*mailLeaf
	if bs == nil {
		return body, parts, leaves
	}
	bs.Walk(func(path []int, b imap.BodyStructure) bool {
		sp, ok := b.(*imap.BodyStructureSinglePart)
		if !ok {
			return true
		}
		leaf := &mailLeaf{path: append([]int(nil), path...), part: sp}
		disp := ""
		if d := sp.Disposition(); d != nil {
			disp = strings.ToLower(d.Value)
		}
		name := mailPartName(sp)
		mt := sp.MediaType()
		if disp != "attachment" && name == "" {
			if mt == "text/plain" {
				body.text = append(body.text, leaf)
				return true
			}
			if mt == "text/html" {
				body.html = append(body.html, leaf)
				return true
			}
		}
		cid := strings.Trim(sp.ID, "<>")
		inline := cid != "" && strings.HasPrefix(mt, "image/") && disp != "attachment"
		if name == "" {
			if mt == "message/rfc822" {
				name = "message.eml"
				if sp.MessageRFC822 != nil && sp.MessageRFC822.Envelope != nil && sp.MessageRFC822.Envelope.Subject != "" {
					name = sp.MessageRFC822.Envelope.Subject + ".eml"
				}
			} else {
				name = "file"
				if exts, _ := mime.ExtensionsByType(mt); len(exts) > 0 {
					name += exts[0]
				}
			}
		}
		parts = append(parts, MailPart{ID: joinPartPath(leaf.path), Name: name, Type: mt,
			Size: mailDecodedSize(sp), CID: cid, Inline: inline})
		leaves = append(leaves, leaf)
		return true
	})
	return body, parts, leaves
}

// mailDecodedSize is a part's FILE size: BODYSTRUCTURE counts the encoded
// bytes, and base64 is 4 characters per 3 bytes plus a line break every 76.
func mailDecodedSize(sp *imap.BodyStructureSinglePart) int64 {
	n := int64(sp.Size)
	if strings.EqualFold(strings.TrimSpace(sp.Encoding), "base64") {
		return n * 57 / 78
	}
	return n
}

// mailPartName is a part's file name: the Content-Disposition's filename,
// else the Content-Type's name - either the plain kind (RFC 2047 "=?...?="
// words) or RFC 2231's (filename*=utf-8”%C3%A9..., and its pieces
// filename*0*, filename*1... that long names are cut into).
func mailPartName(sp *imap.BodyStructureSinglePart) string {
	if d := sp.Disposition(); d != nil {
		if n := rfc2231Param(d.Params, "filename"); n != "" {
			return n
		}
	}
	return rfc2231Param(sp.Params, "name")
}

func rfc2231Param(m map[string]string, key string) string {
	if len(m) == 0 {
		return ""
	}
	if v := m[key]; v != "" {
		if dec, err := mailWordDecoder.DecodeHeader(v); err == nil {
			return dec
		}
		return v
	}
	if v, ok := m[key+"*"]; ok {
		cs, text := rfc2231Split(v)
		return rfc2231Text(percentDecode(text), cs)
	}
	var b []byte
	cs := ""
	for i := 0; ; i++ {
		k := key + "*" + strconv.Itoa(i)
		if v, ok := m[k+"*"]; ok { // an encoded piece
			if i == 0 {
				cs, v = rfc2231Split(v)
			}
			b = append(b, percentDecode(v)...)
		} else if v, ok := m[k]; ok {
			b = append(b, v...)
		} else {
			break
		}
	}
	if len(b) == 0 {
		return ""
	}
	return rfc2231Text(b, cs)
}

// rfc2231Split: "utf-8'es'caf%C3%A9" -> "utf-8", "caf%C3%A9".
func rfc2231Split(v string) (string, string) {
	parts := strings.SplitN(v, "'", 3)
	if len(parts) != 3 {
		return "", v
	}
	return strings.ToLower(parts[0]), parts[2]
}

func percentDecode(s string) []byte {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if b, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				out = append(out, byte(b))
				i += 2
				continue
			}
		}
		out = append(out, s[i])
	}
	return out
}

func rfc2231Text(b []byte, cs string) string {
	if cs != "" && cs != "utf-8" && cs != "us-ascii" {
		if r, err := charset.Reader(cs, bytes.NewReader(b)); err == nil {
			if out, err := io.ReadAll(r); err == nil {
				b = out
			}
		}
	}
	return strings.ToValidUTF8(string(b), "\uFFFD")
}

func joinPartPath(path []int) string {
	s := make([]string, len(path))
	for i, n := range path {
		s[i] = strconv.Itoa(n)
	}
	return strings.Join(s, ".")
}

// -----------------------------------------------------------------------------
// changing messages (phase 2)
// -----------------------------------------------------------------------------

// foldersOf is the real folder of each tray the refs are in ("" = none).
func (p *imapProvider) foldersOf(c *imapclient.Client, refs []MailRef) (map[MailRole]string, error) {
	out := map[MailRole]string{}
	for _, r := range refs {
		if _, seen := out[r.Role]; seen {
			continue
		}
		f, err := p.folderFor(c, r.Role)
		if err != nil {
			return nil, err
		}
		out[r.Role] = f
	}
	return out, nil
}

// selectGroup selects a tray and keeps the uids whose refs match its
// UIDVALIDITY; nil when none does.
func (p *imapProvider) selectGroup(c *imapclient.Client, folder string, role MailRole, refs []MailRef) (imap.UIDSet, uint32, error) {
	sel, err := p.selectFolder(c, folder, false)
	if err != nil {
		return nil, 0, err
	}
	var set imap.UIDSet
	for _, r := range refs {
		if r.Role == role && r.UIDValidity == sel.UIDValidity {
			set.AddNum(imap.UID(r.UID))
		}
	}
	return set, sel.UIDValidity, nil
}

func storeFlag(c *imapclient.Client, set imap.UIDSet, flag imap.Flag, on bool) error {
	op := imap.StoreFlagsAdd
	if !on {
		op = imap.StoreFlagsDel
	}
	return c.Store(set, &imap.StoreFlags{Op: op, Silent: true, Flags: []imap.Flag{flag}}, nil).Close()
}

func (p *imapProvider) Set(ctx context.Context, refs []MailRef, ch MailChange) (map[string]MailRef, error) {
	moved := map[string]MailRef{}
	err := p.do(ctx, func(c *imapclient.Client) error {
		folders, err := p.foldersOf(c, refs)
		if err != nil {
			return err
		}
		dest := ""
		if ch.Move != "" {
			if dest, err = p.folderFor(c, ch.Move); err != nil {
				return err
			}
			if dest == "" {
				return errMailNoTray
			}
		}
		for role, folder := range folders {
			if folder == "" {
				continue
			}
			set, uidv, err := p.selectGroup(c, folder, role, refs)
			if err != nil {
				return err
			}
			if len(set) == 0 {
				continue
			}
			if ch.Seen != nil {
				if err := storeFlag(c, set, imap.FlagSeen, *ch.Seen); err != nil {
					return err
				}
			}
			if ch.Flagged != nil {
				if err := storeFlag(c, set, imap.FlagFlagged, *ch.Flagged); err != nil {
					return err
				}
			}
			if dest == "" || dest == folder {
				continue
			}
			destV, src, dst, err := moveUIDs(c, set, dest)
			p.sel, p.selData = "", nil // counts changed under it
			if err != nil {
				return err
			}
			a, _ := src.Nums()
			b, _ := dst.Nums()
			for i := range a {
				if i < len(b) {
					old := MailRef{Role: role, UIDValidity: uidv, UID: uint32(a[i])}
					moved[old.String()] = MailRef{Role: ch.Move, UIDValidity: destV, UID: uint32(b[i])}
				}
			}
		}
		return nil
	})
	return moved, err
}

// moveUIDs moves messages of the selected folder to `dest`, answering the
// new UIDs where the server tells them (UIDPLUS). With MOVE it is one
// command. Without it, go-imap would PIPELINE COPY + STORE \Deleted +
// EXPUNGE, and a COPY that fails (the folder renamed meanwhile, over quota)
// would still delete the originals: so COPY first, and only on its OK the
// originals go (expungeUIDs).
func moveUIDs(c *imapclient.Client, set imap.UIDSet, dest string) (uint32, imap.UIDSet, imap.UIDSet, error) {
	if c.Caps().Has(imap.CapMove) {
		md, err := c.Move(set, dest).Wait()
		if err != nil || md == nil {
			return 0, nil, nil, err
		}
		src, _ := md.SourceUIDs.(imap.UIDSet)
		dst, _ := md.DestUIDs.(imap.UIDSet)
		return md.UIDValidity, src, dst, nil
	}
	cd, err := c.Copy(set, dest).Wait()
	if err != nil {
		return 0, nil, nil, err
	}
	if err := expungeUIDs(c, set); err != nil {
		return 0, nil, nil, err
	}
	if cd == nil {
		return 0, nil, nil, nil
	}
	return cd.UIDValidity, cd.SourceUIDs, cd.DestUIDs, nil
}

// expungeUIDs deletes for good `set` of the selected folder - and ONLY it.
// With UIDPLUS that is UID EXPUNGE. Without, EXPUNGE takes every \Deleted
// message of the folder, also ones another client only MARKED (Thunderbird's
// "mark as deleted" mode): those are unmarked first and marked again after.
func expungeUIDs(c *imapclient.Client, set imap.UIDSet) error {
	if err := storeFlag(c, set, imap.FlagDeleted, true); err != nil {
		return err
	}
	if c.Caps().Has(imap.CapUIDPlus) {
		return c.UIDExpunge(set).Close()
	}
	res, err := c.UIDSearch(&imap.SearchCriteria{Flag: []imap.Flag{imap.FlagDeleted}}, nil).Wait()
	if err != nil {
		return err
	}
	var others imap.UIDSet
	for _, u := range res.AllUIDs() {
		if !set.Contains(u) {
			others.AddNum(u)
		}
	}
	if len(others) > 0 {
		if err := storeFlag(c, others, imap.FlagDeleted, false); err != nil {
			return err
		}
	}
	err = c.Expunge().Close()
	if len(others) > 0 {
		if err2 := storeFlag(c, others, imap.FlagDeleted, true); err == nil {
			err = err2
		}
	}
	return err
}

func (p *imapProvider) Expunge(ctx context.Context, refs []MailRef) error {
	return p.do(ctx, func(c *imapclient.Client) error {
		folders, err := p.foldersOf(c, refs)
		if err != nil {
			return err
		}
		for role, folder := range folders {
			if folder == "" {
				continue
			}
			set, _, err := p.selectGroup(c, folder, role, refs)
			if err != nil {
				return err
			}
			if len(set) == 0 {
				continue
			}
			err = expungeUIDs(c, set)
			p.sel, p.selData = "", nil
			if err != nil {
				return err
			}
		}
		return nil
	})
}

var mailRowFetch = &imap.FetchOptions{UID: true, Flags: true, Envelope: true, RFC822Size: true, InternalDate: true}

func (p *imapProvider) Summaries(ctx context.Context, refs []MailRef) ([]MailSummary, error) {
	out := []MailSummary{}
	err := p.do(ctx, func(c *imapclient.Client) error {
		out = out[:0]
		folders, err := p.foldersOf(c, refs)
		if err != nil {
			return err
		}
		for role, folder := range folders {
			if folder == "" {
				continue
			}
			set, uidv, err := p.selectGroup(c, folder, role, refs)
			if err != nil {
				return err
			}
			if len(set) == 0 {
				continue
			}
			msgs, err := c.Fetch(set, mailRowFetch).Collect()
			if err != nil {
				return err
			}
			for _, m := range withEnvelope(msgs) {
				out = append(out, imapSummary(m, uidv, role))
			}
		}
		return nil
	})
	return out, err
}

func (p *imapProvider) Find(ctx context.Context, messageID string, roles []MailRole) (MailSummary, error) {
	var found MailSummary
	if messageID == "" || strings.HasPrefix(messageID, "h:") {
		return found, errMailGone // a made-up name cannot be searched for
	}
	if roles == nil {
		roles = mailRoles
	}
	err := p.do(ctx, func(c *imapclient.Client) error {
		for _, role := range roles {
			hits, err := p.findIn(c, role, messageID)
			if err != nil {
				return err
			}
			if len(hits) > 0 {
				found = hits[0]
				return nil
			}
		}
		return errMailGone
	})
	return found, err
}

// FindAll (mailFinderAll) is every copy with this Message-ID in one tray,
// newest first: a mail to yourself deleted from the Inbox and from Sent sits
// in the Trash twice, and an Undo brings back both (data-safety I9).
func (p *imapProvider) FindAll(ctx context.Context, messageID string, role MailRole) ([]MailSummary, error) {
	var out []MailSummary
	if messageID == "" || strings.HasPrefix(messageID, "h:") {
		return out, nil
	}
	err := p.do(ctx, func(c *imapclient.Client) error {
		var err error
		out, err = p.findIn(c, role, messageID)
		return err
	})
	return out, err
}

// findIn is every message with exactly this Message-ID in one tray, newest
// first.
func (p *imapProvider) findIn(c *imapclient.Client, role MailRole, messageID string) ([]MailSummary, error) {
	folder, err := p.folderFor(c, role)
	if err != nil || folder == "" {
		return nil, err
	}
	sel, err := p.selectFolder(c, folder, true)
	if err != nil {
		return nil, err
	}
	res, err := c.UIDSearch(&imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{
		{Key: "Message-ID", Value: messageID}}}, nil).Wait()
	if err != nil {
		return nil, err
	}
	uids := res.AllUIDs()
	if len(uids) == 0 {
		return nil, nil
	}
	// SEARCH HEADER is a substring match ("12@x.com" finds "412@x.com"
	// too): only the exact ones count
	msgs, err := c.Fetch(imap.UIDSetNum(uids...), mailRowFetch).Collect()
	if err != nil {
		return nil, err
	}
	msgs = withEnvelope(msgs)
	sort.Slice(msgs, func(i, j int) bool { return msgs[i].UID > msgs[j].UID })
	var out []MailSummary
	for _, m := range msgs {
		if strings.Trim(m.Envelope.MessageID, "<> ") == messageID {
			out = append(out, imapSummary(m, sel.UIDValidity, role))
		}
	}
	return out, nil
}

// Anywhere (mailAnywhere): is a message with this Message-ID in ANY folder
// of the account - Gmail's All Mail (\All: everything but Spam and the Trash,
// which Find saw) where the server has one, else every folder that is no
// tray? Read-only (EXAMINE). Its answer decides whether a message's labels
// are dropped for good (I3): any doubt is an error, never "nowhere".
func (p *imapProvider) Anywhere(ctx context.Context, messageID string) (bool, error) {
	if messageID == "" || strings.HasPrefix(messageID, "h:") {
		return true, nil // a made-up name cannot be searched for
	}
	found := false
	err := p.do(ctx, func(c *imapclient.Client) error {
		found = false
		var opts *imap.ListOptions
		if caps := c.Caps(); caps.Has(imap.CapSpecialUse) && caps.Has(imap.CapListExtended) {
			opts = &imap.ListOptions{ReturnSpecialUse: true}
		}
		list, err := c.List("", "*", opts).Collect()
		if err != nil {
			return err
		}
		trays := map[string]bool{}
		for _, role := range mailRoles {
			f, err := p.folderFor(c, role)
			if err != nil {
				return err
			}
			trays[f] = true
		}
		var all, others []string
		for _, m := range list {
			ok := true
			for _, a := range m.Attrs {
				switch a {
				case imap.MailboxAttrNoSelect, imap.MailboxAttrNonExistent:
					ok = false
				case imap.MailboxAttrAll:
					all = append(all, m.Mailbox)
				}
			}
			if ok && !trays[m.Mailbox] {
				others = append(others, m.Mailbox)
			}
		}
		if len(all) > 0 {
			others = all[:1]
		}
		defer func() { p.sel, p.selData = "", nil }() // EXAMINEd: the next call selects again
		for _, folder := range others {
			d, err := c.Select(folder, &imap.SelectOptions{ReadOnly: true}).Wait()
			if err != nil {
				return err
			}
			if d.NumMessages == 0 {
				continue
			}
			res, err := c.UIDSearch(&imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{
				{Key: "Message-ID", Value: messageID}}}, nil).Wait()
			if err != nil {
				return err
			}
			uids := res.AllUIDs()
			if len(uids) == 0 {
				continue
			}
			msgs, err := c.Fetch(imap.UIDSetNum(uids...), &imap.FetchOptions{UID: true, Envelope: true}).Collect()
			if err != nil {
				return err
			}
			for _, m := range msgs {
				if m.Envelope != nil && strings.Trim(m.Envelope.MessageID, "<> ") == messageID {
					found = true
					return nil
				}
			}
		}
		return nil
	})
	return found, err
}

// Scan is every message of a tray, fetched mailScanChunk at a time - each
// chunk a call of its own, so a big Trash never runs into one call's clock
// and other requests get their turn in between.
func (p *imapProvider) Scan(ctx context.Context, role MailRole) ([]MailSummary, error) {
	out := []MailSummary{}
	var uids []imap.UID
	var uidv uint32
	err := p.do(ctx, func(c *imapclient.Client) error {
		uids, uidv = nil, 0
		folder, err := p.folderFor(c, role)
		if err != nil || folder == "" {
			return err
		}
		sel, err := p.selectFolder(c, folder, true)
		if err != nil || sel.NumMessages == 0 {
			return err
		}
		res, err := c.UIDSearch(&imap.SearchCriteria{}, nil).Wait()
		if err != nil {
			return err
		}
		uids, uidv = res.AllUIDs(), sel.UIDValidity
		return nil
	})
	if err != nil || len(uids) == 0 {
		return out, err
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })
	for len(uids) > 0 {
		n := min(mailScanChunk, len(uids))
		chunk := uids[:n]
		uids = uids[n:]
		err := p.do(ctx, func(c *imapclient.Client) error {
			if err := p.selectRef(c, MailRef{Role: role, UIDValidity: uidv}); err != nil {
				return err
			}
			msgs, err := c.Fetch(imap.UIDSetNum(chunk...), mailRowFetch).Collect()
			if err != nil {
				return err
			}
			for _, m := range withEnvelope(msgs) {
				out = append(out, imapSummary(m, uidv, role))
			}
			return nil
		})
		if err != nil {
			return out, err
		}
	}
	return out, nil
}

func (p *imapProvider) LatestUnseen(ctx context.Context) (MailSummary, bool, error) {
	var found MailSummary
	ok := false
	err := p.do(ctx, func(c *imapclient.Client) error {
		folder, err := p.folderFor(c, RoleInbox)
		if err != nil || folder == "" {
			return err
		}
		sel, err := p.selectFolder(c, folder, true)
		if err != nil {
			return err
		}
		res, err := c.UIDSearch(&imap.SearchCriteria{NotFlag: []imap.Flag{imap.FlagSeen}}, nil).Wait()
		if err != nil {
			return err
		}
		uids := res.AllUIDs()
		if len(uids) == 0 {
			return nil
		}
		sort.Slice(uids, func(i, j int) bool { return uids[i] > uids[j] })
		msgs, err := c.Fetch(imap.UIDSetNum(uids[0]), mailRowFetch).Collect()
		if msgs = withEnvelope(msgs); err != nil || len(msgs) != 1 {
			return err
		}
		found, ok = imapSummary(msgs[0], sel.UIDValidity, RoleInbox), true
		return nil
	})
	return found, ok, err
}

// UNSOLICITED FETCH. While a command runs, a server may slip in news of
// another client's change - "* 3 FETCH (UID 812 FLAGS (\\Seen))" - and go-imap
// hands it over as one of the messages asked for: a row with no envelope, a
// message "found" empty. These keep only the answers that carry what was asked.

// withEnvelope: the messages that came with their envelope, each UID once.
func withEnvelope(msgs []*imapclient.FetchMessageBuffer) []*imapclient.FetchMessageBuffer {
	seen := map[imap.UID]bool{}
	out := make([]*imapclient.FetchMessageBuffer, 0, len(msgs))
	for _, m := range msgs {
		if m.Envelope != nil && !seen[m.UID] {
			seen[m.UID] = true
			out = append(out, m)
		}
	}
	return out
}

// withSection: the message that came with that body section (nil: none).
func withSection(msgs []*imapclient.FetchMessageBuffer, sec *imap.FetchItemBodySection) *imapclient.FetchMessageBuffer {
	for _, m := range msgs {
		if m.FindBodySection(sec) != nil {
			return m
		}
	}
	return nil
}

// headerText reads one plain-text header out of a header block: unfolded,
// its RFC 2047 words decoded ("" when it is not there).
func headerText(raw []byte, name string) string {
	text := strings.ReplaceAll(strings.ReplaceAll(string(raw), "\r\n ", " "), "\r\n\t", " ")
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(k), name) {
			continue
		}
		v = strings.TrimSpace(v)
		if dec, err := mailWordDecoder.DecodeHeader(v); err == nil {
			v = dec
		}
		return v
	}
	return ""
}

// parseMsgIDs reads one header of message ids ("References: <a> <b>",
// "In-Reply-To: <a>") out of a header block, brackets off.
func parseMsgIDs(raw []byte, name string) []string {
	var out []string
	text := strings.ReplaceAll(strings.ReplaceAll(string(raw), "\r\n ", " "), "\r\n\t", " ")
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(k), name) {
			continue
		}
		for _, id := range strings.Fields(v) {
			if id = strings.Trim(id, "<>"); id != "" {
				out = append(out, id)
			}
		}
	}
	return out
}
