package main

// =============================================================================
// eMail: sending (SMTP), saving drafts (IMAP APPEND).
// =============================================================================
//
// SMTP with the account's login: implicit TLS on 465, STARTTLS anywhere else
// (refused when the server does not offer it - never a password in clear).
// Gmail files what it sends in its Sent folder by itself (a preset's
// OwnSent); every other server gets the copy APPENDed there by us (read, of
// course) - the copy keeps the Bcc, so the user can see whom he Bcc'd.
//
// A refusal (an unknown recipient, too big, a daily limit) is the server's
// ANSWER: a mailRejectError carrying its own words, never "no answer". Once
// the server has taken the message (DATA accepted), nothing after it - QUIT,
// the copy in Sent - can make it "not sent".
//
// A draft is APPENDed to the Drafts tray (flagged \Draft, read) and the one it
// replaces is deleted - IMAP cannot edit a message in place.

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
)

// mailTLSRoots: the certificates a mail server's must chain to; nil = the
// system's. Only the tests set it (their servers' own certificate).
var mailTLSRoots *x509.CertPool

// smtpRefused turns an SMTP reply error into what the user reads; anything
// else (the line died, a timeout) stays as it is: "no answer".
func smtpRefused(err error, rcpt string) error {
	var te *textproto.Error
	if !errors.As(err, &te) || te.Code < 400 {
		return err
	}
	text := strconv.Itoa(te.Code) + " " + strings.TrimSpace(te.Msg)
	if rcpt != "" {
		text = rcpt + ": " + text
	}
	return &mailRejectError{Text: text}
}

// smtpOpen connects, secures and logs in. The deadline covers everything the
// caller then does on it.
func smtpOpen(ctx context.Context, a MailAccount) (*smtp.Client, error) {
	addr := net.JoinHostPort(a.SMTPHost, strconv.Itoa(a.SMTPPort))
	d := mailDialer()
	tlsCfg := &tls.Config{ServerName: a.SMTPHost, MinVersion: tls.VersionTLS12, RootCAs: mailTLSRoots}
	var conn net.Conn
	var err error
	if a.SMTPPort == 465 {
		conn, err = (&tls.Dialer{NetDialer: d, Config: tlsCfg}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(3 * time.Minute)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	conn.SetDeadline(deadline)
	c, err := smtp.NewClient(conn, a.SMTPHost)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if a.SMTPPort != 465 {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			c.Close()
			return nil, errors.New("mail: the SMTP server offers no TLS")
		}
		if err := c.StartTLS(tlsCfg); err != nil {
			c.Close()
			return nil, err
		}
	}
	if err := c.Auth(smtp.PlainAuth("", a.User, a.Pass, a.SMTPHost)); err != nil {
		c.Close()
		var te *textproto.Error
		if errors.As(err, &te) && (te.Code == 535 || te.Code == 534 || te.Code == 530) {
			return nil, errMailAuth
		}
		return nil, smtpRefused(err, "")
	}
	return c, nil
}

// smtpCheck: can this account send? Connect, TLS, log in, QUIT - no mail.
func smtpCheck(ctx context.Context, a MailAccount) error {
	c, err := smtpOpen(ctx, a)
	if err != nil {
		return err
	}
	c.Quit()
	return nil
}

// smtpSend hands one message to the account's SMTP server.
func smtpSend(ctx context.Context, a MailAccount, from string, rcpts []string, raw []byte) error {
	c, err := smtpOpen(ctx, a)
	if err != nil {
		return err
	}
	defer c.Close()
	// the server says how big a message it takes (EHLO SIZE): too big is
	// known before a byte of it goes
	if ok, max := c.Extension("SIZE"); ok {
		if n, err := strconv.ParseInt(strings.TrimSpace(max), 10, 64); err == nil && n > 0 && int64(len(raw)) > n {
			return fmt.Errorf("%w: %d bytes, the server takes %d", errMailTooBig, len(raw), n)
		}
	}
	if err := c.Mail(from); err != nil {
		return smtpRefused(err, "")
	}
	for _, r := range rcpts {
		if err := c.Rcpt(r); err != nil {
			return smtpRefused(err, r)
		}
	}
	w, err := c.Data()
	if err != nil {
		return smtpRefused(err, "")
	}
	if _, err := w.Write(raw); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		var te *textproto.Error
		if !errors.As(err, &te) {
			// the end of the message went, the server's answer did not
			// come: it may have taken it - never "not sent" (I6)
			return fmt.Errorf("%w: %v", errMailUnsure, err)
		}
		return smtpRefused(err, "")
	}
	c.Quit() // it is sent: a server that hangs up without its 221 changes nothing
	return nil
}

// ownSent: the account's SMTP server files its own copy of what it sends.
func (a MailAccount) ownSent() bool {
	if p := presetByID(a.Provider); p != nil && p.OwnSent {
		return true
	}
	return strings.EqualFold(a.SMTPHost, "smtp.gmail.com")
}

// CheckSend (mailSendChecker): the SMTP login works.
func (p *imapProvider) CheckSend(ctx context.Context) error {
	return p.smtpCheck(ctx, p.acct)
}

func (p *imapProvider) Send(ctx context.Context, raw, copy []byte, from string, rcpts []string) error {
	if err := p.smtp(ctx, p.acct, from, rcpts, raw); err != nil {
		return err
	}
	if p.acct.ownSent() {
		return nil
	}
	// the copy in Sent: the message has gone already - so a failure here is
	// not "not sent", only "no copy" (the caller logs it) - and it is put
	// there even when the app has left meanwhile (a phone locked after Send)
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), mailCmdTimeout)
	defer cancel()
	if _, err := p.appendTo(cctx, RoleSent, copy, []imap.Flag{imap.FlagSeen}, ""); err != nil {
		return errMailNoCopy
	}
	return nil
}

var errMailNoCopy = errors.New("mail: sent, but its copy could not be put in Sent")

// SaveDraft: the new one first, then the old one away. Stored but the old
// one not removed: the new ref with errMailLeftover - the app must go on
// from the NEW one, or every later save leaves one more copy behind.
func (p *imapProvider) SaveDraft(ctx context.Context, raw []byte, mid string, old *MailRef) (MailRef, []MailPart, error) {
	ref, err := p.appendTo(ctx, RoleDrafts, raw, []imap.Flag{imap.FlagSeen, imap.FlagDraft}, mid)
	if err != nil {
		return ref, nil, err
	}
	if old != nil && old.Role == RoleDrafts && *old != ref {
		if err := p.Expunge(ctx, []MailRef{*old}); err != nil {
			return ref, nil, fmt.Errorf("%w: %v", errMailLeftover, err)
		}
	}
	return ref, nil, nil
}

// appendTo puts a message in a tray; its ref from UIDPLUS, or found by its
// Message-ID when the server does not say (mid "" = not needed). Never
// retried: the server may have stored it before the line died. A big one
// goes over a connection of its own (side).
func (p *imapProvider) appendTo(ctx context.Context, role MailRole, raw []byte, flags []imap.Flag, mid string) (MailRef, error) {
	var ref MailRef
	put := func(c *imapclient.Client, folder string) error {
		cmd := c.Append(folder, int64(len(raw)), &imap.AppendOptions{Flags: flags, Time: time.Now()})
		if _, err := cmd.Write(raw); err != nil {
			cmd.Close()
			return err
		}
		if err := cmd.Close(); err != nil {
			return err
		}
		data, err := cmd.Wait()
		if err != nil {
			return err
		}
		if data != nil && data.UID != 0 {
			ref = MailRef{Role: role, UIDValidity: data.UIDValidity, UID: uint32(data.UID)}
		}
		return nil
	}
	var err error
	if len(raw) > mailBigAppend {
		var folder string
		if folder, err = p.folderOf(ctx, role); err == nil {
			if folder == "" {
				return ref, errMailNoTray
			}
			err = p.side(ctx, func(c *imapclient.Client) error { return put(c, folder) })
		}
	} else {
		err = p.doOnce(ctx, func(c *imapclient.Client) error {
			folder, err := p.folderFor(c, role)
			if err != nil {
				return err
			}
			if folder == "" {
				return errMailNoTray
			}
			p.sel, p.selData = "", nil // its counts change
			return put(c, folder)
		})
	}
	if err != nil || ref.UID != 0 || mid == "" {
		return ref, err
	}
	found, err := p.Find(ctx, mid, []MailRole{role})
	if err != nil {
		return ref, err
	}
	r, _ := parseMailRef(found.Ref)
	return r, nil
}
