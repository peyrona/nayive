package main

// =============================================================================
// eMail: every user's mail accounts, and the unread count the launcher shows.
// =============================================================================
//
// FILES. homes/<user>/data/mail/accounts.json (0600, the folder 0700) lists
// the accounts: address, servers, login - and the app password ENCRYPTED
// (AES-256-GCM) with a key only the server has, config/mail.key. So a copy of
// the home (Drive, a share) never carries a usable password; the daily backup
// zip leaves mail.key out on purpose (server/backup/backup_nayive.sh), so a
// restore from it asks each user for the passwords again ("New password":
// labels kept). A password that does not open (mail.key lost or changed) is
// kept sealed as it was - never overwritten - so putting the right key back
// brings it back. The file API cannot write anything under data/mail
// (isServerData, api_files.go): the server alone owns it.
//
// UNREAD. A poller asks every account's Inbox for its unread count every
// mailPollEvery (IMAP STATUS - one short command) and keeps the answer, so
// /api/mail/unread never waits on a mail server. Reading a message asks again
// at once, so the badge follows.

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const mailPollEvery = 2 * time.Minute

// MailAccount is one account as the file keeps it (Pass encrypted there,
// plain in memory).
type MailAccount struct {
	ID       string    `json:"id"`
	Email    string    `json:"email"`
	Name     string    `json:"name,omitempty"`     // the sender's name on mail sent (phase 3)
	Provider string    `json:"provider,omitempty"` // a mailPreset id; "" = servers typed by hand
	User     string    `json:"user"`               // the login, most often = Email
	Pass     string    `json:"pass"`
	IMAPHost string    `json:"imap_host"`
	IMAPPort int       `json:"imap_port"`
	SMTPHost string    `json:"smtp_host"`
	SMTPPort int       `json:"smtp_port"`
	Kind     string    `json:"kind,omitempty"`     // "" = IMAP + SMTP, "jmap"
	JMAPURL  string    `json:"jmap_url,omitempty"` // JMAP: the session resource
	Auth     string    `json:"auth,omitempty"`     // JMAP: "bearer" | "basic", what the server took
	Added    time.Time `json:"added"`
}

var (
	errMailNeedHosts = errors.New("mail: unknown provider, the servers are needed")
	errMailBlocked   = errors.New("mail: that provider lets no app in with a password")
	errMailDup       = errors.New("mail: that address is already here")
	errMailBad       = errors.New("mail: address or password missing")
	// the password is sealed with another config/mail.key: type it again
	errMailKey = errors.New("mail: the password does not open (config/mail.key changed?)")
	// the login works, sending does not (SMTP host, port or login)
	errMailSendCheck = errors.New("mail: it logs in, but cannot send")
)

type mailAcct struct {
	MailAccount
	sealed string // the password as the file has it, when it did not open (errMailKey)
	prov   MailProvider
	unread int
	mark   string // the Inbox's arrival mark (MailPoll.Mark) at the last poll
	known  bool   // polled once: an arrival after this is news (push)
	polled time.Time
	err    error
}

type mailUser struct {
	accts    []*mailAcct
	next     int                       // the number of the next account id: ids are never reused
	labels   mailLabelsFile            // mail_labels.go
	trash    map[string]mailTrashEntry // "<acct>|<message-id>" -> when, from where
	settings MailSettings
}

type MailHub struct {
	cfg   *Config
	log   Logger
	users *Users      // the account's devices, for the push
	push  *VapidStore // nil: no push (tests)

	mu     sync.Mutex
	owners map[string]*mailUser

	wordsMu sync.Mutex
	words   *phrasebook // the push's words, in each device's language

	keyMu sync.Mutex
	key   []byte

	newProvider func(MailAccount) MailProvider // tests swap in a fake
	onArrived   func(user, acct string, n int) // tests watch "new mail" here (nil: the push)
}

func NewMailHub(cfg *Config, users *Users, push *VapidStore, log Logger) *MailHub {
	return &MailHub{cfg: cfg, log: log, users: users, push: push, owners: map[string]*mailUser{},
		words: newPhrasebook(cfg.AppsDir),
		newProvider: func(a MailAccount) MailProvider {
			if a.Kind == "jmap" {
				return newJMAPProvider(a)
			}
			return newIMAPProvider(a)
		}}
}

func (h *MailHub) dir(user string) string {
	return filepath.Join(h.cfg.HomesDir, user, "data", "mail")
}

// -----------------------------------------------------------------------------
// the password's key
// -----------------------------------------------------------------------------

// secret is config/mail.key, made on first use (32 random bytes, 0600).
func (h *MailHub) secret() ([]byte, error) {
	h.keyMu.Lock()
	defer h.keyMu.Unlock()
	if h.key != nil {
		return h.key, nil
	}
	path := filepath.Join(h.cfg.ConfigDir, "mail.key")
	if raw, err := os.ReadFile(path); err == nil {
		k, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil || len(k) != 32 {
			return nil, fmt.Errorf("%w: config/mail.key is damaged", errMailKey)
		}
		h.key = k
		return k, nil
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	_, err = f.WriteString(base64.StdEncoding.EncodeToString(k) + "\n")
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(path)
		return nil, err
	}
	h.key = k
	return k, nil
}

func (h *MailHub) gcm() (cipher.AEAD, error) {
	k, err := h.secret()
	if err != nil {
		return nil, err
	}
	b, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(b)
}

const mailSealPrefix = "v1:"

func (h *MailHub) seal(plain string) (string, error) {
	g, err := h.gcm()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return mailSealPrefix + base64.StdEncoding.EncodeToString(g.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func (h *MailHub) open(sealed string) (string, error) {
	if !strings.HasPrefix(sealed, mailSealPrefix) {
		return "", errMailKey
	}
	raw, err := base64.StdEncoding.DecodeString(sealed[len(mailSealPrefix):])
	if err != nil {
		return "", errMailKey
	}
	g, err := h.gcm()
	if err != nil {
		return "", err
	}
	if len(raw) < g.NonceSize() {
		return "", errMailKey
	}
	plain, err := g.Open(nil, raw[:g.NonceSize()], raw[g.NonceSize():], nil)
	if err != nil {
		return "", errMailKey
	}
	return string(plain), nil
}

// -----------------------------------------------------------------------------
// accounts
// -----------------------------------------------------------------------------

type mailAccountsFile struct {
	Accounts []MailAccount `json:"accounts"`
	Next     int           `json:"next,omitempty"` // the next account number (ids never come back)
}

// user is `name`'s accounts, read from disk the first time. h.mu held.
func (h *MailHub) userLocked(name string) *mailUser {
	if u := h.owners[name]; u != nil {
		return u
	}
	u := &mailUser{}
	var f mailAccountsFile
	loadJSONFile(filepath.Join(h.dir(name), "accounts.json"), &f)
	u.next = f.Next
	for _, a := range f.Accounts {
		sealed := a.Pass
		pass, err := h.open(sealed)
		acct := &mailAcct{MailAccount: a}
		if err != nil {
			// kept sealed as it was, and never polled: the right mail.key
			// back (and a restart) opens it again
			h.log.Warn("mail: an account's password does not open", "user", name, "account", a.ID, "err", err)
			acct.Pass, acct.sealed, acct.err = "", sealed, errMailKey
		} else {
			acct.Pass = pass
		}
		acct.prov = h.newProvider(acct.MailAccount)
		u.accts = append(u.accts, acct)
	}
	h.loadExtrasLocked(name, u)
	h.owners[name] = u
	return u
}

// saveLocked writes `name`'s accounts, the passwords sealed. h.mu held.
func (h *MailHub) saveLocked(name string, u *mailUser) error {
	f := mailAccountsFile{Accounts: []MailAccount{}, Next: u.next}
	for _, a := range u.accts {
		stored := a.MailAccount
		if a.sealed != "" { // did not open: stays exactly as it was
			stored.Pass = a.sealed
		} else {
			sealed, err := h.seal(a.Pass)
			if err != nil {
				return err
			}
			stored.Pass = sealed
		}
		f.Accounts = append(f.Accounts, stored)
	}
	return h.writeMailFile(name, "accounts.json", f)
}

// MailAccountView is an account as the app sees it: never the password.
type MailAccountView struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	Name     string `json:"name,omitempty"`
	Provider string `json:"provider,omitempty"`
	Kind     string `json:"kind,omitempty"`
	JMAPURL  string `json:"jmapUrl,omitempty"`
	IMAPHost string `json:"imapHost"`
	IMAPPort int    `json:"imapPort"`
	SMTPHost string `json:"smtpHost"`
	SMTPPort int    `json:"smtpPort"`
	Unread   int    `json:"unread"`
	Error    string `json:"error,omitempty"` // "auth" | "down" | "key": the last poll failed
}

func mailErrCode(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, errMailSendCheck): // before auth: a refused SMTP login is "cannot send"
		return "smtp"
	case errors.Is(err, errMailAuth):
		return "auth"
	case errors.Is(err, errMailGone):
		return "gone"
	case errors.Is(err, errMailNoTray):
		return "notray"
	case errors.Is(err, errMailKey):
		return "key"
	case errors.Is(err, errMailRejected):
		return "rejected"
	case errors.Is(err, errMailTooBig):
		return "toobig"
	case errors.Is(err, errMailPrivateNet):
		return "private"
	}
	return "down"
}

// mailErrText is the server's own words of a refusal ("" for any other error).
func mailErrText(err error) string {
	var re *mailRejectError
	if errors.As(err, &re) {
		return re.Text
	}
	return ""
}

func (a *mailAcct) view() MailAccountView {
	return MailAccountView{ID: a.ID, Email: a.Email, Name: a.Name, Provider: a.Provider, Kind: a.Kind, JMAPURL: a.JMAPURL,
		IMAPHost: a.IMAPHost, IMAPPort: a.IMAPPort, SMTPHost: a.SMTPHost, SMTPPort: a.SMTPPort,
		Unread: a.unread, Error: mailErrCode(a.err)}
}

func (h *MailHub) Accounts(user string) []MailAccountView {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []MailAccountView{}
	for _, a := range h.userLocked(user).accts {
		out = append(out, a.view())
	}
	return out
}

// cleanPass: Google shows an app password as "abcd efgh ijkl mnop" - its
// spaces go. Any other password is taken as typed (a space may be part of it).
func cleanPass(pass, provider string) string {
	if p := presetByID(provider); p != nil && p.Pass == "app" {
		return strings.ReplaceAll(strings.TrimSpace(pass), " ", "")
	}
	return pass
}

// tryLogin: the account's server takes this login, to read AND to send.
// Answers the first poll (the unread count and the Inbox's mark).
func (h *MailHub) tryLogin(ctx context.Context, prov MailProvider) (MailPoll, error) {
	first, err := prov.Poll(ctx, "")
	if err != nil {
		return first, err
	}
	if sc, ok := prov.(mailSendChecker); ok {
		if err := sc.CheckSend(ctx); err != nil {
			if errors.Is(err, errMailPrivateNet) {
				return first, err
			}
			return first, fmt.Errorf("%w: %w", errMailSendCheck, err)
		}
	}
	return first, nil
}

// Add checks the login on the real server, then keeps the account.
func (h *MailHub) Add(ctx context.Context, user string, in MailAccount) (MailAccountView, error) {
	in.Email = strings.TrimSpace(strings.ToLower(in.Email))
	in.Name = strings.TrimSpace(in.Name)
	in.User = strings.TrimSpace(in.User)
	in.IMAPHost = strings.TrimSpace(strings.ToLower(in.IMAPHost))
	in.SMTPHost = strings.TrimSpace(strings.ToLower(in.SMTPHost))
	at := strings.LastIndexByte(in.Email, '@')
	if at < 1 || at == len(in.Email)-1 || in.Pass == "" {
		return MailAccountView{}, errMailBad
	}
	if in.User == "" {
		in.User = in.Email
	}
	// the servers: the provider picked, else the address's own, else typed
	p := presetByID(in.Provider)
	if p == nil && in.Provider != "other" && in.IMAPHost == "" {
		p = presetForEmail(in.Email)
	}
	in.Provider = ""
	jmapURL := strings.TrimSpace(in.JMAPURL)
	in.Kind, in.JMAPURL, in.Auth = "", "", ""
	if p != nil {
		if p.Blocked {
			return MailAccountView{}, errMailBlocked
		}
		in.Provider = p.ID
		in.IMAPHost, in.IMAPPort, in.SMTPHost, in.SMTPPort = p.IMAPHost, p.IMAPPort, p.SMTPHost, p.SMTPPort
		if p.Kind == "jmap" {
			in.Kind, in.JMAPURL = "jmap", p.JMAPURL
			if in.JMAPURL == "" { // "a JMAP server": the one typed
				u, err := cleanJMAPURL(jmapURL)
				if err != nil {
					return MailAccountView{}, err
				}
				in.JMAPURL = u
			}
		}
	} else if in.IMAPHost == "" {
		return MailAccountView{}, errMailNeedHosts
	}
	if in.Kind == "jmap" {
		in.IMAPHost, in.IMAPPort, in.SMTPHost, in.SMTPPort = "", 0, "", 0
	} else if in.IMAPPort <= 0 || in.IMAPPort > 65535 {
		in.IMAPPort = 993
	}
	if in.Kind != "jmap" {
		if in.SMTPPort <= 0 || in.SMTPPort > 65535 {
			in.SMTPPort = 465
		}
		if in.SMTPHost == "" {
			in.SMTPHost = in.IMAPHost
		}
	}
	if in.Pass = cleanPass(in.Pass, in.Provider); strings.TrimSpace(in.Pass) == "" {
		return MailAccountView{}, errMailBad
	}

	h.mu.Lock()
	for _, a := range h.userLocked(user).accts {
		if a.Email == in.Email {
			h.mu.Unlock()
			return MailAccountView{}, errMailDup
		}
	}
	h.mu.Unlock()

	// the test, outside the lock: a slow server must not stall everybody's badge
	prov := h.newProvider(in)
	first, err := h.tryLogin(ctx, prov)
	n := first.Unread
	if err != nil {
		prov.Close()
		return MailAccountView{}, err
	}
	if jp, ok := prov.(*jmapProvider); ok {
		in.Auth = jp.auth // no need to try the other kind every time
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	// ids are never reused: an old push (?a=a2) or a device's remembered
	// account must never open another mailbox
	next := u.next
	for _, a := range u.accts {
		if a.Email == in.Email {
			prov.Close()
			return MailAccountView{}, errMailDup
		}
		if k, _ := strconv.Atoi(strings.TrimPrefix(a.ID, "a")); k >= next {
			next = k + 1
		}
	}
	if next < 1 {
		next = 1
	}
	in.ID = "a" + strconv.Itoa(next)
	in.Added = time.Now().UTC().Truncate(time.Second)
	a := &mailAcct{MailAccount: in, prov: prov, unread: n, mark: first.Mark, known: true, polled: time.Now()}
	before := u.next
	u.accts, u.next = append(u.accts, a), next+1
	if err := h.saveLocked(user, u); err != nil {
		u.accts, u.next = u.accts[:len(u.accts)-1], before
		prov.Close()
		return MailAccountView{}, err
	}
	h.log.Info("mail: account added", "user", user, "account", in.ID, "host", in.IMAPHost)
	return a.view(), nil
}

// SetPassword gives an account a new password (Google revokes every app
// password when the Google password changes; a lost mail.key): tried on the
// server first, then kept - the account, its id and its labels stay.
func (h *MailHub) SetPassword(ctx context.Context, user, id, pass string) (MailAccountView, error) {
	a := h.account(user, id)
	if a == nil {
		return MailAccountView{}, errMailGone
	}
	h.mu.Lock()
	try := a.MailAccount
	h.mu.Unlock()
	if try.Pass = cleanPass(pass, try.Provider); strings.TrimSpace(try.Pass) == "" {
		return MailAccountView{}, errMailBad
	}
	try.Auth = "" // JMAP: find again which kind it takes
	prov := h.newProvider(try)
	first, err := h.tryLogin(ctx, prov)
	if err != nil {
		prov.Close()
		return MailAccountView{}, err
	}
	if jp, ok := prov.(*jmapProvider); ok {
		try.Auth = jp.auth
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	i := -1
	for k, x := range u.accts {
		if x == a {
			i = k
		}
	}
	if i < 0 { // removed meanwhile
		prov.Close()
		return MailAccountView{}, errMailGone
	}
	fresh := &mailAcct{MailAccount: try, prov: prov, unread: first.Unread, mark: first.Mark, known: true, polled: time.Now()}
	u.accts[i] = fresh
	if err := h.saveLocked(user, u); err != nil {
		u.accts[i] = a
		prov.Close()
		return MailAccountView{}, err
	}
	go a.prov.Close()
	h.log.Info("mail: new password", "user", user, "account", id)
	return fresh.view(), nil
}

// Remove forgets an account (the mail stays on its server, of course).
func (h *MailHub) Remove(user, id string) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	for i, a := range u.accts {
		if a.ID != id {
			continue
		}
		u.accts = append(u.accts[:i:i], u.accts[i+1:]...)
		if err := h.saveLocked(user, u); err != nil {
			u.accts = append(u.accts[:i], append([]*mailAcct{a}, u.accts[i:]...)...)
			return true, err
		}
		go a.prov.Close()
		// what Nayive kept about its mail goes with it
		for key := range u.trash {
			if strings.HasPrefix(key, id+"|") {
				delete(u.trash, key)
			}
		}
		for key := range u.labels.Tags {
			if strings.HasPrefix(key, id+"|") {
				delete(u.labels.Tags, key)
			}
		}
		if err := h.saveTrashLocked(user, u); err != nil {
			h.log.Warn("mail: saving trash.json", "user", user, "err", err)
		}
		if err := h.saveLabelsLocked(user, u); err != nil {
			h.log.Warn("mail: saving labels", "user", user, "err", err)
		}
		return true, nil
	}
	return false, nil
}

// provider is one account's server, nil when there is no such account.
func (h *MailHub) provider(user, id string) MailProvider {
	if a := h.account(user, id); a != nil {
		return a.prov
	}
	return nil
}

func (h *MailHub) account(user, id string) *mailAcct {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, a := range h.userLocked(user).accts {
		if a.ID == id {
			return a
		}
	}
	return nil
}

// -----------------------------------------------------------------------------
// unread
// -----------------------------------------------------------------------------

// Unread is the badge: every account's Inbox, from the last poll.
func (h *MailHub) Unread(user string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, a := range h.userLocked(user).accts {
		n += a.unread
	}
	return n
}

// pollOne asks one account again and keeps the answer. Mail that ARRIVED
// since the last poll (its mark moved - not the count going up, which one
// read + one new would hide) is news: a push to the user's devices.
func (h *MailHub) pollOne(ctx context.Context, user string, a *mailAcct) {
	h.mu.Lock()
	mark := a.mark
	h.mu.Unlock()
	res, err := a.prov.Poll(ctx, mark)
	h.mu.Lock()
	known := a.known
	arrived := 0
	if err == nil {
		// another poll of this account that answered first already told
		if a.mark == mark {
			arrived = res.Arrived
			if res.Mark != "" {
				a.mark = res.Mark
			}
		}
		a.unread, a.known = res.Unread, true
	}
	a.err, a.polled = err, time.Now()
	h.mu.Unlock()
	if err != nil {
		h.log.Debug("mail: poll failed", "user", user, "account", a.ID, "err", err)
		return
	}
	if known && arrived > 0 {
		if h.onArrived != nil {
			h.onArrived(user, a.ID, arrived)
			return
		}
		h.pushNew(ctx, user, a, arrived)
	}
}

// Refresh re-polls one account now, in the background (a message was read).
func (h *MailHub) Refresh(user, id string) {
	h.mu.Lock()
	var a *mailAcct
	for _, x := range h.userLocked(user).accts {
		if x.ID == id {
			a = x
		}
	}
	h.mu.Unlock()
	if a != nil && !errors.Is(a.err, errMailKey) {
		go h.pollOne(context.Background(), user, a)
	}
}

// pollAll polls every account of every user known, all at once.
func (h *MailHub) pollAll(ctx context.Context) {
	type job struct {
		user string
		a    *mailAcct
	}
	var jobs []job
	h.mu.Lock()
	for name, u := range h.owners {
		for _, a := range u.accts {
			if errors.Is(a.err, errMailKey) {
				continue // no password to try until it is typed again
			}
			if a.err == nil || !errors.Is(a.err, errMailAuth) || time.Since(a.polled) > 30*time.Minute {
				jobs = append(jobs, job{name, a}) // a refused password: try again every 30 min, not every 2
			}
		}
	}
	h.mu.Unlock()
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.pollOne(ctx, j.user, j.a)
		}()
	}
	wg.Wait()
}

// RunPoller loads every home that has mail accounts, then polls them all
// every mailPollEvery until ctx ends.
func (h *MailHub) RunPoller(ctx context.Context) {
	if entries, err := os.ReadDir(h.cfg.HomesDir); err == nil {
		h.mu.Lock()
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			if _, err := os.Stat(filepath.Join(h.dir(e.Name()), "accounts.json")); err == nil {
				h.userLocked(e.Name())
			}
		}
		h.mu.Unlock()
	}
	t := time.NewTicker(mailPollEvery)
	defer t.Stop()
	for {
		h.pollAll(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Close drops every connection - without waiting on one busy with a slow
// server (it waits for its own command first).
func (h *MailHub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, u := range h.owners {
		for _, a := range u.accts {
			go a.prov.Close()
		}
	}
}
