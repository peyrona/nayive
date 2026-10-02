package main

// =============================================================================
// eMail: the JMAP provider (RFC 8620 core, RFC 8621 mail) - Fastmail,
// Stalwart, Cyrus, Apache James... Plain HTTPS + JSON: no library.
// =============================================================================
//
// THE SESSION. The account's JMAP URL is its session resource (for Fastmail
// https://api.fastmail.com/jmap/session). It says where to send method calls
// (apiUrl), where blobs go up and come down, which account holds the mail and
// which one sends (primaryAccounts), what the server offers (capabilities:
// "submission" or not) and its limits (objects per get/set, calls per
// request, upload size). Read once per provider, and again when the server
// says it moved (404/410).
//
// THE WAY OUT. Every request dials through mailDialer (mail_net.go: never
// into this server's own network), no proxy, redirects only to https and at
// most five. The session's URLs must be https too - they may sit on another
// domain (Fastmail downloads from fastmailusercontent.com).
//
// AUTH. The secret is sent as "Bearer <token>" (Fastmail's API tokens); a
// server that refuses that gets "Basic <login:secret>" (a password, as
// Stalwart and Cyrus take). Whichever worked is remembered. A 429 or 503 is
// tried once more, after the Retry-After the server asks (at most 5 s).
//
// THE MODEL. Trays are Mailboxes by role (inbox, drafts, sent, junk -> spam,
// trash). A message is an Email id; its ref is "<tray>.j.<id>" (the tray it was
// listed in - a JMAP Email may sit in several Mailboxes). An attachment's part
// id is its blobId. A move takes the Email out of the trays' Mailboxes and
// puts it in the new one - any other Mailbox it is in (a Fastmail folder or
// label) stays; read and starred are the $seen and $flagged keywords, Spam /
// Not spam also set $junk / $notjunk (the server's spam training). Deleting
// for good destroys only an Email still where its ref says: one that moved
// since (a draft sent from another app) is left alone. Lists are by date,
// newest first; the cursor is the last Email shown (an anchor), so mail that
// goes or comes meanwhile never skips or repeats a row.
//
// THE REFUSALS. What the server refuses - a SetError (overQuota, tooLarge,
// forbiddenFrom, invalidRecipients...) or a method error - comes back as a
// *mailRejectError in words, never as "no answer"; of several messages, the
// ones refused are named in a *mailPartialError.
//
// SENDING: the built message is uploaded as a blob, imported into Sent (read),
// and handed to EmailSubmission with the Identity of the account's address
// (or its "*@domain" one); if the submission fails, the imported copy is
// destroyed again. With no Sent Mailbox it is imported elsewhere and the
// submission destroys it: sent, but errMailNoCopy. A draft is imported into
// Drafts ($draft, $seen); the one it replaces is destroyed only once the new
// one and its parts are known.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	jmapCore       = "urn:ietf:params:jmap:core"
	jmapMail       = "urn:ietf:params:jmap:mail"
	jmapSubmission = "urn:ietf:params:jmap:submission"
	jmapMaxBody    = 2 << 20 // bytes of a body value asked for

	jmapDefObjects = 500 // objects per get/set when the server does not say
	jmapDefCalls   = 16  // method calls per request, the same
	jmapRetryMax   = 5 * time.Second
	jmapMaxPages   = 400 // Scan: pages of at most 500 - 200 000 messages
)

// jmapMaxFile: an attachment bigger than this is refused, never served cut.
var jmapMaxFile int64 = 64 << 20

type jmapSession struct {
	APIURL       string                     `json:"apiUrl"`
	DownloadURL  string                     `json:"downloadUrl"`
	UploadURL    string                     `json:"uploadUrl"`
	Primary      map[string]string          `json:"primaryAccounts"`
	Capabilities map[string]json.RawMessage `json:"capabilities"`

	// from the capabilities
	maxGet, maxSet, maxCalls int
	maxUpload                int64
	submission               bool // the server offers sending
}

type jmapProvider struct {
	acct   MailAccount
	client *http.Client

	mu      sync.Mutex
	sess    *jmapSession
	auth    string              // "bearer" | "basic" - what the server took
	boxes   map[MailRole]string // role -> Mailbox id
	boxRole map[string]MailRole // Mailbox id -> role
}

func newJMAPProvider(a MailAccount) *jmapProvider {
	return &jmapProvider{acct: a, auth: a.Auth, client: newJMAPClient()}
}

// newJMAPClient: straight out through the guarded dialer - no proxy, which
// would dodge it - and only https redirects.
func newJMAPClient() *http.Client {
	tr := &http.Transport{
		Proxy:               nil,
		DialContext:         mailDialer().DialContext,
		TLSHandshakeTimeout: mailDialTime,
		ForceAttemptHTTP2:   true,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
	}
	return &http.Client{Timeout: mailCmdTimeout, Transport: tr, CheckRedirect: jmapRedirect}
}

// jmapURLOK: https, or plain http only where the guard is off (the tests'
// servers on 127.0.0.1 - the guard refuses those anyway in real use).
func jmapURLOK(u string) bool {
	l := strings.ToLower(u)
	return strings.HasPrefix(l, "https://") || (!mailNetGuard && strings.HasPrefix(l, "http://"))
}

func jmapRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("jmap: too many redirects")
	}
	if !jmapURLOK(req.URL.String()) {
		return errors.New("jmap: a redirect to plain http")
	}
	return nil
}

func (p *jmapProvider) Close() {}

// -----------------------------------------------------------------------------
// transport
// -----------------------------------------------------------------------------

func (p *jmapProvider) authorize(req *http.Request, how string) {
	if how == "basic" {
		user := p.acct.User
		if user == "" {
			user = p.acct.Email
		}
		req.SetBasicAuth(user, p.acct.Pass)
		return
	}
	req.Header.Set("Authorization", "Bearer "+p.acct.Pass)
}

// send does one HTTP request with the account's auth; on a 401 with none
// settled yet it tries the other kind.
func (p *jmapProvider) send(ctx context.Context, method, u, ctype string, body []byte) (*http.Response, error) {
	p.mu.Lock()
	how := p.auth
	p.mu.Unlock()
	tries := []string{how}
	if how == "" {
		tries = []string{"bearer", "basic"}
	}
	for i, t := range tries {
		resp, err := p.sendOnce(ctx, method, u, ctype, body, t)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			resp.Body.Close()
			if i < len(tries)-1 {
				continue
			}
			return nil, errMailAuth
		}
		if how == "" {
			p.mu.Lock()
			p.auth = t
			p.mu.Unlock()
		}
		return resp, nil
	}
	return nil, errMailAuth
}

// sendOnce is one request - and once more after a 429 or 503, when the
// server has said how long to wait (Retry-After, at most jmapRetryMax).
func (p *jmapProvider) sendOnce(ctx context.Context, method, u, ctype string, body []byte, how string) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		req.Header.Set("Accept", "application/json")
		p.authorize(req, how)
		resp, err := p.client.Do(req)
		if err != nil {
			return nil, err
		}
		if attempt == 0 && (resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable) {
			wait := jmapRetryAfter(resp.Header.Get("Retry-After"))
			resp.Body.Close()
			t := time.NewTimer(wait)
			select {
			case <-t.C:
			case <-ctx.Done():
				t.Stop()
				return nil, ctx.Err()
			}
			continue
		}
		return resp, nil
	}
}

// jmapRetryAfter reads a Retry-After (seconds, or a date): 1 s when it says
// nothing, never more than jmapRetryMax.
func jmapRetryAfter(v string) time.Duration {
	d := time.Second
	v = strings.TrimSpace(v)
	if n, err := strconv.Atoi(v); err == nil {
		d = time.Duration(n) * time.Second
	} else if t, err := http.ParseTime(v); err == nil {
		d = time.Until(t)
	}
	return max(0, min(d, jmapRetryMax))
}

func (p *jmapProvider) session(ctx context.Context) (*jmapSession, error) {
	p.mu.Lock()
	s := p.sess
	p.mu.Unlock()
	if s != nil {
		return s, nil
	}
	resp, err := p.send(ctx, http.MethodGet, p.acct.JMAPURL, "", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jmap: session answered %d", resp.StatusCode)
	}
	s = &jmapSession{}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(s); err != nil {
		return nil, err
	}
	if s.APIURL == "" || s.Primary[jmapMail] == "" {
		return nil, errors.New("jmap: the server offers no mail")
	}
	// "/path" URLs are on the session's own host. By hand, not ResolveReference:
	// that would escape the {accountId} {blobId} placeholders of the templates.
	if base, err := url.Parse(p.acct.JMAPURL); err == nil {
		for _, u := range []*string{&s.APIURL, &s.UploadURL, &s.DownloadURL} {
			if strings.HasPrefix(*u, "/") && !strings.HasPrefix(*u, "//") {
				*u = base.Scheme + "://" + base.Host + *u
			}
		}
	}
	if err := s.check(); err != nil {
		return nil, err
	}
	p.mu.Lock()
	p.sess = s
	p.mu.Unlock()
	return s, nil
}

// check reads the capabilities and refuses URLs that are not https.
func (s *jmapSession) check() error {
	for _, u := range []string{s.APIURL, s.UploadURL, s.DownloadURL} {
		if u != "" && !jmapURLOK(u) {
			return &mailRejectError{Text: "the JMAP server names an address that is not https: " + clip(u, 120)}
		}
	}
	var core struct {
		MaxSizeUpload     int64 `json:"maxSizeUpload"`
		MaxCallsInRequest int   `json:"maxCallsInRequest"`
		MaxObjectsInGet   int   `json:"maxObjectsInGet"`
		MaxObjectsInSet   int   `json:"maxObjectsInSet"`
	}
	if raw, ok := s.Capabilities[jmapCore]; ok {
		json.Unmarshal(raw, &core)
	}
	s.maxGet, s.maxSet, s.maxCalls, s.maxUpload = core.MaxObjectsInGet, core.MaxObjectsInSet, core.MaxCallsInRequest, core.MaxSizeUpload
	if s.maxGet <= 0 {
		s.maxGet = jmapDefObjects
	}
	if s.maxSet <= 0 {
		s.maxSet = jmapDefObjects
	}
	if s.maxCalls <= 0 {
		s.maxCalls = jmapDefCalls
	}
	// a session that lists no capabilities at all (not by the RFC) is taken
	// at its word that it does mail - and, then, sending
	_, sub := s.Capabilities[jmapSubmission]
	s.submission = sub || s.Capabilities == nil
	return nil
}

func (p *jmapProvider) accountID(s *jmapSession) string { return s.Primary[jmapMail] }

// submissionAccount: the account that sends - the RFC lets it differ from
// the one holding the mail.
func (p *jmapProvider) submissionAccount(s *jmapSession) string {
	if a := s.Primary[jmapSubmission]; a != "" {
		return a
	}
	return s.Primary[jmapMail]
}

// jmapCall is one method call: name, arguments, call id.
type jmapCall struct {
	Name string
	Args map[string]any
	ID   string
}

func (c jmapCall) MarshalJSON() ([]byte, error) { return json.Marshal([]any{c.Name, c.Args, c.ID}) }

// jmapSends: the methods that need "submission" in "using" (and its account).
func jmapSends(name string) bool {
	return strings.HasPrefix(name, "Identity/") || strings.HasPrefix(name, "EmailSubmission/")
}

// jmapError is a method's "error" answer. A refusal (anything but the
// server failing) carries its words as a *mailRejectError (errors.As / Is).
type jmapError struct {
	Type, Description string
	reject            *mailRejectError
}

func (e *jmapError) Error() string { return "jmap: " + e.Type + " " + e.Description }
func (e *jmapError) Unwrap() error {
	if e.reject != nil {
		return e.reject
	}
	return nil
}

func newJMAPError(typ, desc string) *jmapError {
	e := &jmapError{Type: typ, Description: desc}
	switch typ {
	case "serverFail", "serverUnavailable", "serverPartialFail":
	default:
		e.reject = &mailRejectError{Text: jmapWords(typ, desc)}
	}
	return e
}

// jmapErrorWords: what a refusal means, in plain words.
var jmapErrorWords = map[string]string{
	"overQuota":         "the mailbox is full",
	"tooLarge":          "the message is too big for the server",
	"rateLimit":         "too much at once: the server asks to wait a little",
	"forbiddenFrom":     "the server does not let this account send as that address",
	"forbiddenMailFrom": "the server does not let this account send as that address",
	"forbiddenToSend":   "the server does not let this account send mail",
	"invalidRecipients": "the server refused a recipient",
	"noRecipients":      "there is nobody to send it to",
	"tooManyRecipients": "too many recipients",
	"invalidEmail":      "the server found the message not valid",
	"forbidden":         "the server does not allow that",
	"requestTooLarge":   "too many at once for the server",
	"accountReadOnly":   "the account is read-only",
	"notFound":          "that message is not there any more",
	"unknownCapability": "the server does not offer what is needed",
	"limit":             "the request is over one of the server's limits",
}

func jmapWords(typ, desc string) string {
	w := jmapErrorWords[typ]
	if w == "" {
		w = "the server refused it (" + typ + ")"
	}
	if desc = strings.TrimSpace(desc); desc != "" {
		w += ": " + clip(desc, 200)
	}
	return w
}

// jmapSetError is one object a /set or /import refused (RFC 8620 5.3).
type jmapSetError struct {
	Type              string   `json:"type"`
	Description       string   `json:"description"`
	InvalidRecipients []string `json:"invalidRecipients"`
}

func (e jmapSetError) reject() *mailRejectError {
	text := jmapWords(e.Type, e.Description)
	if len(e.InvalidRecipients) > 0 {
		text += " (" + clip(strings.Join(e.InvalidRecipients, ", "), 200) + ")"
	}
	return &mailRejectError{Text: text}
}

// call sends method calls and answers each call id's arguments. A method
// error ("error" answer) fails the whole call (a *jmapError). More calls than
// the server takes in one request go in several, their back-references
// resolved here.
func (p *jmapProvider) call(ctx context.Context, calls ...jmapCall) (map[string]json.RawMessage, error) {
	s, err := p.session(ctx)
	if err != nil {
		return nil, err
	}
	mailAcc, subAcc := p.accountID(s), p.submissionAccount(s)
	sends := false
	for i := range calls {
		one := jmapSends(calls[i].Name)
		sends = sends || one
		if _, set := calls[i].Args["accountId"]; !set {
			if one {
				calls[i].Args["accountId"] = subAcc
			} else {
				calls[i].Args["accountId"] = mailAcc
			}
		}
	}
	if sends && !s.submission {
		return nil, &mailRejectError{Text: "this JMAP account cannot send mail (the server offers no submission)"}
	}
	using := []string{jmapCore, jmapMail}
	if sends {
		using = append(using, jmapSubmission)
	}
	res := map[string]json.RawMessage{}
	for start := 0; start < len(calls); start += s.maxCalls {
		batch := calls[start:min(start+s.maxCalls, len(calls))]
		if start > 0 {
			for _, c := range batch {
				for k, v := range c.Args {
					ref, ok := v.(map[string]any)
					if !strings.HasPrefix(k, "#") || !ok {
						continue
					}
					if got, found := jmapResolve(res, ref); found {
						delete(c.Args, k)
						c.Args[k[1:]] = got
					}
				}
			}
		}
		part, err := p.request(ctx, s, using, batch)
		if err != nil {
			return nil, err
		}
		for k, v := range part {
			res[k] = v
		}
	}
	return res, nil
}

// request is one POST to the API with those calls.
func (p *jmapProvider) request(ctx context.Context, s *jmapSession, using []string, calls []jmapCall) (map[string]json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{"using": using, "methodCalls": calls})
	resp, err := p.send(ctx, http.MethodPost, s.APIURL, "application/json", body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
			p.mu.Lock()
			p.sess = nil // the session moved: read it again next time
			p.mu.Unlock()
		}
		// a request-level problem (RFC 8620 3.6.1): unknownCapability, limit...
		var prob struct {
			Type, Detail, Limit string
		}
		if resp.StatusCode == http.StatusBadRequest &&
			json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&prob) == nil && prob.Type != "" {
			typ := prob.Type[strings.LastIndexByte(prob.Type, ':')+1:]
			detail := prob.Detail
			if prob.Limit != "" {
				detail = strings.TrimSpace(detail + " (" + prob.Limit + ")")
			}
			return nil, &mailRejectError{Text: jmapWords(typ, detail)}
		}
		return nil, fmt.Errorf("jmap: api answered %d", resp.StatusCode)
	}
	var out struct {
		MethodResponses [][]json.RawMessage `json:"methodResponses"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&out); err != nil {
		return nil, err
	}
	res := map[string]json.RawMessage{}
	for _, r := range out.MethodResponses {
		if len(r) != 3 {
			continue
		}
		var name, id string
		json.Unmarshal(r[0], &name)
		json.Unmarshal(r[2], &id)
		if name == "error" {
			var e struct {
				Type        string `json:"type"`
				Description string `json:"description"`
			}
			json.Unmarshal(r[1], &e)
			return nil, newJMAPError(e.Type, e.Description)
		}
		res[id] = r[1]
	}
	return res, nil
}

// jmapResolve evaluates a result reference (RFC 8620 3.7) against answers in
// hand: a JSON pointer where "*" maps over an array (and flattens).
func jmapResolve(res map[string]json.RawMessage, ref map[string]any) (any, bool) {
	of, _ := ref["resultOf"].(string)
	path, _ := ref["path"].(string)
	raw, ok := res[of]
	if !ok {
		return nil, false
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil, false
	}
	return jmapPointer(v, strings.Split(strings.TrimPrefix(path, "/"), "/")), true
}

func jmapPointer(v any, tokens []string) any {
	if len(tokens) == 0 || (len(tokens) == 1 && tokens[0] == "") {
		return v
	}
	t := strings.NewReplacer("~1", "/", "~0", "~").Replace(tokens[0])
	switch x := v.(type) {
	case map[string]any:
		return jmapPointer(x[t], tokens[1:])
	case []any:
		if t == "*" {
			out := []any{}
			for _, item := range x {
				r := jmapPointer(item, tokens[1:])
				if arr, ok := r.([]any); ok {
					out = append(out, arr...)
				} else {
					out = append(out, r)
				}
			}
			return out
		}
		if i, err := strconv.Atoi(t); err == nil && i >= 0 && i < len(x) {
			return jmapPointer(x[i], tokens[1:])
		}
	}
	return nil
}

// -----------------------------------------------------------------------------
// mailboxes
// -----------------------------------------------------------------------------

type jmapMailbox struct {
	ID           string `json:"id"`
	Role         string `json:"role"`
	TotalEmails  int    `json:"totalEmails"`
	UnreadEmails int    `json:"unreadEmails"`
}

var jmapRoles = map[string]MailRole{"inbox": RoleInbox, "drafts": RoleDrafts, "sent": RoleSent, "junk": RoleSpam, "trash": RoleTrash}

func (p *jmapProvider) mailboxes(ctx context.Context) ([]jmapMailbox, error) {
	res, err := p.call(ctx, jmapCall{"Mailbox/get", map[string]any{"ids": nil,
		"properties": []string{"id", "role", "totalEmails", "unreadEmails"}}, "m"})
	if err != nil {
		return nil, err
	}
	var got struct {
		List []jmapMailbox `json:"list"`
	}
	if err := json.Unmarshal(res["m"], &got); err != nil {
		return nil, err
	}
	boxes, roles := map[MailRole]string{}, map[string]MailRole{}
	for _, b := range got.List {
		if r, ok := jmapRoles[strings.ToLower(b.Role)]; ok && boxes[r] == "" {
			boxes[r], roles[b.ID] = b.ID, r
		}
	}
	p.mu.Lock()
	p.boxes, p.boxRole = boxes, roles
	p.mu.Unlock()
	return got.List, nil
}

// box is a role's Mailbox id ("" = none).
func (p *jmapProvider) box(ctx context.Context, role MailRole) (string, error) {
	p.mu.Lock()
	id, known := p.boxes[role], p.boxes != nil
	p.mu.Unlock()
	if known {
		return id, nil
	}
	if _, err := p.mailboxes(ctx); err != nil {
		return "", err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.boxes[role], nil
}

func (p *jmapProvider) Trays(ctx context.Context) ([]MailTray, error) {
	list, err := p.mailboxes(ctx)
	if err != nil {
		return nil, err
	}
	byRole := map[MailRole]jmapMailbox{}
	for _, b := range list {
		if r, ok := jmapRoles[strings.ToLower(b.Role)]; ok {
			if _, dup := byRole[r]; !dup {
				byRole[r] = b
			}
		}
	}
	var out []MailTray
	for _, r := range mailRoles {
		b, ok := byRole[r]
		out = append(out, MailTray{Role: r, Total: b.TotalEmails, Unread: b.UnreadEmails, Missing: !ok})
	}
	return out, nil
}

// jmapEmptyMark: the Inbox was empty at that poll - whatever is there next
// time arrived since.
const jmapEmptyMark = "1970-01-01T00:00:00Z|"

// Poll: the Inbox's unread count, and as the mark its newest arrival
// ("<receivedAt>|<id>"); Arrived counts what came in after that time.
func (p *jmapProvider) Poll(ctx context.Context, mark string) (MailPoll, error) {
	var out MailPoll
	list, err := p.mailboxes(ctx)
	if err != nil {
		return out, err
	}
	box := ""
	for _, b := range list {
		if strings.EqualFold(b.Role, "inbox") {
			out.Unread, box = b.UnreadEmails, b.ID
		}
	}
	if box == "" {
		return out, nil
	}
	calls := []jmapCall{
		{"Email/query", map[string]any{"filter": map[string]any{"inMailbox": box},
			"sort": []any{map[string]any{"property": "receivedAt", "isAscending": false}}, "limit": 1}, "q"},
		{"Email/get", map[string]any{"#ids": map[string]any{"resultOf": "q", "name": "Email/query", "path": "/ids"},
			"properties": []string{"id", "receivedAt"}}, "g"},
	}
	at, _, _ := strings.Cut(mark, "|")
	since, sinceErr := time.Parse(time.RFC3339, at)
	if sinceErr == nil {
		calls = append(calls, jmapCall{"Email/query", map[string]any{
			"filter":         map[string]any{"inMailbox": box, "after": since.UTC().Format(time.RFC3339)},
			"calculateTotal": true, "limit": 1}, "n"})
	}
	res, err := p.call(ctx, calls...)
	if err != nil {
		return out, err
	}
	var got struct {
		List []jmapEmail `json:"list"`
	}
	out.Mark = jmapEmptyMark
	if json.Unmarshal(res["g"], &got) == nil && len(got.List) > 0 {
		out.Mark = got.List[0].ReceivedAt.UTC().Format(time.RFC3339) + "|" + got.List[0].ID
	}
	if sinceErr == nil {
		var n struct {
			Total int `json:"total"`
		}
		if json.Unmarshal(res["n"], &n) == nil {
			out.Arrived = n.Total
		}
	}
	return out, nil
}

// -----------------------------------------------------------------------------
// emails
// -----------------------------------------------------------------------------

type jmapAddr struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type jmapPart struct {
	PartID      string `json:"partId"`
	BlobID      string `json:"blobId"`
	Size        int64  `json:"size"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Disposition string `json:"disposition"`
	CID         string `json:"cid"`
}

type jmapEmail struct {
	ID            string                   `json:"id"`
	MailboxIDs    map[string]bool          `json:"mailboxIds"`
	Keywords      map[string]bool          `json:"keywords"`
	Size          int64                    `json:"size"`
	ReceivedAt    time.Time                `json:"receivedAt"`
	SentAt        *time.Time               `json:"sentAt"`
	MessageID     []string                 `json:"messageId"`
	References    []string                 `json:"references"`
	From          []jmapAddr               `json:"from"`
	To            []jmapAddr               `json:"to"`
	Cc            []jmapAddr               `json:"cc"`
	Bcc           []jmapAddr               `json:"bcc"`
	ReplyTo       []jmapAddr               `json:"replyTo"`
	Subject       string                   `json:"subject"`
	Preview       string                   `json:"preview"`
	HasAttachment bool                     `json:"hasAttachment"`
	TextBody      []jmapPart               `json:"textBody"`
	HTMLBody      []jmapPart               `json:"htmlBody"`
	Attachments   []jmapPart               `json:"attachments"`
	BodyValues    map[string]jmapBodyValue `json:"bodyValues"`
	// a draft's fields as typed (mail_compose.go draftAddrs): asked for by name
	TypedTo  *string `json:"header:X-Nayive-To:asText"`
	TypedCc  *string `json:"header:X-Nayive-Cc:asText"`
	TypedBcc *string `json:"header:X-Nayive-Bcc:asText"`
}

type jmapBodyValue struct {
	Value       string `json:"value"`
	IsTruncated bool   `json:"isTruncated"`
}

var jmapRowProps = []string{"id", "mailboxIds", "keywords", "size", "receivedAt", "sentAt", "messageId",
	"from", "to", "subject", "preview", "hasAttachment"}

// jmapScanProps: all a whole-tray scan needs - where, and the row's name
// (Message-ID, or the sender, date and subject mailHashID is made of).
var jmapScanProps = []string{"id", "mailboxIds", "receivedAt", "sentAt", "messageId", "from", "subject"}

func jmapAddrs(list []jmapAddr) []MailAddr {
	out := []MailAddr{}
	for _, a := range list {
		out = append(out, MailAddr{Name: a.Name, Addr: a.Email})
	}
	return out
}

// summary is an Email as a row, listed in `role`.
func (e *jmapEmail) summary(role MailRole) MailSummary {
	s := MailSummary{
		Ref: MailRef{Role: role, ID: e.ID}.String(), From: jmapAddrs(e.From), To: jmapAddrs(e.To),
		Subject: e.Subject, Date: e.ReceivedAt, Snippet: e.Preview, Seen: e.Keywords["$seen"],
		Flagged: e.Keywords["$flagged"], Attach: e.HasAttachment, Size: e.Size,
	}
	if e.SentAt != nil && !e.SentAt.IsZero() {
		s.Date = *e.SentAt
	}
	if len(e.MessageID) > 0 {
		s.MessageID = e.MessageID[0]
	}
	if s.MessageID == "" {
		s.MessageID = mailHashID(s)
	}
	return s
}

// roleOf is the tray an Email is in: `prefer` when it is there, else its first.
func (p *jmapProvider) roleOf(e *jmapEmail, prefer MailRole) MailRole {
	p.mu.Lock()
	defer p.mu.Unlock()
	if id := p.boxes[prefer]; id != "" && e.MailboxIDs[id] {
		return prefer
	}
	for _, r := range mailRoles {
		if id := p.boxes[r]; id != "" && e.MailboxIDs[id] {
			return r
		}
	}
	return prefer
}

// getEmails: Email/get, as many at a time as the server takes.
func (p *jmapProvider) getEmails(ctx context.Context, ids []string, props []string, extra map[string]any) ([]jmapEmail, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	s, err := p.session(ctx)
	if err != nil {
		return nil, err
	}
	var out []jmapEmail
	for start := 0; start < len(ids); start += s.maxGet {
		args := map[string]any{"ids": ids[start:min(start+s.maxGet, len(ids))], "properties": props}
		for k, v := range extra {
			args[k] = v
		}
		res, err := p.call(ctx, jmapCall{"Email/get", args, "g"})
		if err != nil {
			return nil, err
		}
		var got struct {
			List []jmapEmail `json:"list"`
		}
		if err := json.Unmarshal(res["g"], &got); err != nil {
			return nil, err
		}
		out = append(out, got.List...)
	}
	return out, nil
}

// jmapCursor is a list's cursor: the position of the next page and the last
// Email shown ("50:M11"). The Email is the anchor; the position only serves
// when it has gone (or for a cursor of before, a bare number).
func jmapCursor(cursor string) (pos int, anchor string) {
	n, id, _ := strings.Cut(cursor, ":")
	pos, _ = strconv.Atoi(n)
	if jmapIDOK(id) {
		anchor = id
	}
	return max(pos, 0), anchor
}

func (p *jmapProvider) List(ctx context.Context, role MailRole, query, cursor string) (MailPage, error) {
	page := MailPage{Items: []MailSummary{}}
	box, err := p.box(ctx, role)
	if err != nil || box == "" {
		return page, err
	}
	s, err := p.session(ctx)
	if err != nil {
		return page, err
	}
	limit := min(mailPageSize, s.maxGet)
	pos, anchor := jmapCursor(cursor)
	filter := map[string]any{"inMailbox": box}
	if query != "" {
		filter = map[string]any{"operator": "AND", "conditions": []any{filter, map[string]any{"text": query}}}
	}
	ask := func(anchor string) (map[string]json.RawMessage, error) {
		q := map[string]any{"filter": filter, "sort": []any{map[string]any{"property": "receivedAt", "isAscending": false}},
			"limit": limit, "calculateTotal": true}
		if anchor != "" {
			q["anchor"], q["anchorOffset"] = anchor, 1
		} else {
			q["position"] = pos
		}
		return p.call(ctx,
			jmapCall{"Email/query", q, "q"},
			jmapCall{"Email/get", map[string]any{"#ids": map[string]any{"resultOf": "q", "name": "Email/query", "path": "/ids"},
				"properties": jmapRowProps}, "g"})
	}
	res, err := ask(anchor)
	var je *jmapError
	if anchor != "" && errors.As(err, &je) && je.Type == "anchorNotFound" {
		res, err = ask("") // the last one shown went away: by position
	}
	if err != nil {
		return page, err
	}
	var q struct {
		IDs      []string `json:"ids"`
		Total    int      `json:"total"`
		Position int      `json:"position"`
	}
	var g struct {
		List []jmapEmail `json:"list"`
	}
	json.Unmarshal(res["q"], &q)
	json.Unmarshal(res["g"], &g)
	byID := map[string]*jmapEmail{}
	for i := range g.List {
		byID[g.List[i].ID] = &g.List[i]
	}
	for _, id := range q.IDs { // the query's order: newest first
		if e := byID[id]; e != nil {
			page.Items = append(page.Items, e.summary(role))
		}
	}
	if len(q.IDs) > 0 {
		next := q.Position + len(q.IDs)
		if next < q.Total || (q.Total == 0 && len(q.IDs) >= limit) {
			page.Next = strconv.Itoa(next) + ":" + q.IDs[len(q.IDs)-1]
		}
	}
	return page, nil
}

func (p *jmapProvider) Summaries(ctx context.Context, refs []MailRef) ([]MailSummary, error) {
	var ids []string
	roles := map[string]MailRole{}
	for _, r := range refs {
		if r.ID != "" {
			ids = append(ids, r.ID)
			roles[r.ID] = r.Role
		}
	}
	if _, err := p.box(ctx, RoleInbox); err != nil {
		return nil, err
	}
	list, err := p.getEmails(ctx, ids, jmapRowProps, nil)
	if err != nil {
		return nil, err
	}
	out := []MailSummary{}
	for i := range list {
		out = append(out, list[i].summary(p.roleOf(&list[i], roles[list[i].ID])))
	}
	return out, nil
}

// jmapMedia: a picture, a sound or a video - what a body may show between
// its pieces of text (RFC 8621 4.1.4).
func jmapMedia(t string) bool {
	t = strings.ToLower(t)
	return strings.HasPrefix(t, "image/") || strings.HasPrefix(t, "audio/") || strings.HasPrefix(t, "video/")
}

// jmapCID is the Content-ID a body's picture is shown by: its own, or one
// made up of its blob (the API maps it to the part like any other).
func jmapCID(pt jmapPart) string {
	if cid := strings.Trim(pt.CID, "<>"); cid != "" {
		return cid
	}
	return "nayive-" + pt.BlobID
}

// jmapBodies makes the text and the HTML of an Email. Text: its textBody's
// plain pieces, a line between them. HTML: its htmlBody, where a plain piece
// is drawn as text and a picture as an <img> of its part; with no HTML but
// pictures between the pieces of text (a photo in a plain Apple Mail message),
// the textBody is drawn that way, so the photo shows where it was. cut: a
// value came back cut (over maxBodyValueBytes).
func jmapBodies(e *jmapEmail) (text, htm string, cut bool) {
	value := func(pt jmapPart) string {
		v := e.BodyValues[pt.PartID]
		cut = cut || v.IsTruncated
		return v.Value
	}
	var pieces []string
	media := false
	for _, pt := range e.TextBody {
		switch t := strings.ToLower(pt.Type); {
		case t == "text/plain":
			pieces = append(pieces, value(pt))
		case jmapMedia(t):
			media = true
		}
	}
	text = strings.Join(pieces, "\n")
	list, isHTML := e.HTMLBody, false
	for _, pt := range list {
		if strings.EqualFold(pt.Type, "text/html") {
			isHTML = true
		}
	}
	if !isHTML {
		if !media {
			return text, "", cut
		}
		list = e.TextBody
	}
	var b strings.Builder
	for i, pt := range list {
		chunk := ""
		switch t := strings.ToLower(pt.Type); {
		case t == "text/html":
			chunk = value(pt)
		case t == "text/plain":
			chunk = `<div style="white-space:pre-wrap">` + html.EscapeString(value(pt)) + `</div>`
		case strings.HasPrefix(t, "image/") && pt.BlobID != "":
			cid := jmapCID(pt)
			if !strings.Contains(strings.ToLower(b.String()), "cid:"+strings.ToLower(cid)) {
				chunk = `<img src="cid:` + html.EscapeString(cid) + `">`
			}
		}
		if chunk == "" {
			continue
		}
		if i > 0 && b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString(chunk)
	}
	return text, b.String(), cut
}

// jmapParts is an Email's files and pictures: its attachments, and the
// pictures, sounds and videos of its bodies (never lost between two pieces of
// text). A picture the HTML shows (by its cid) is inline; everything else is
// a file to download. html "": nothing is inline.
func jmapParts(e *jmapEmail, htm string) []MailPart {
	out := []MailPart{}
	seen := map[string]bool{}
	low := strings.ToLower(htm)
	add := func(a jmapPart, body bool) {
		mt := strings.ToLower(a.Type)
		if a.BlobID == "" || seen[a.BlobID] || (body && !jmapMedia(mt)) {
			return
		}
		seen[a.BlobID] = true
		cid := strings.Trim(a.CID, "<>")
		if body {
			cid = jmapCID(a)
		}
		name := a.Name
		if name == "" {
			name = "file"
		}
		shown := cid != "" && strings.Contains(low, "cid:"+strings.ToLower(cid))
		out = append(out, MailPart{ID: a.BlobID, Name: name, Type: mt, Size: a.Size, CID: cid,
			Inline: shown && strings.HasPrefix(mt, "image/") && !strings.EqualFold(a.Disposition, "attachment")})
	}
	// the bodies' first: a picture that is in both (RFC 8621 lists it in
	// attachments too when one body is missing) keeps the cid its <img> uses
	for _, a := range e.TextBody {
		add(a, true)
	}
	for _, a := range e.HTMLBody {
		add(a, true)
	}
	for _, a := range e.Attachments {
		add(a, false)
	}
	return out
}

var jmapFullProps = append(append([]string{}, jmapRowProps...), "cc", "bcc", "replyTo", "references",
	"textBody", "htmlBody", "attachments", "bodyValues",
	"header:"+mailTypedTo+":asText", "header:"+mailTypedCc+":asText", "header:"+mailTypedBcc+":asText")

// jmapPartProps: enough to find any part of an Email.
var jmapPartProps = []string{"id", "attachments", "textBody", "htmlBody"}

func (p *jmapProvider) Message(ctx context.Context, ref MailRef) (MailMessage, error) {
	var msg MailMessage
	if ref.ID == "" {
		return msg, errMailGone
	}
	if _, err := p.box(ctx, RoleInbox); err != nil {
		return msg, err
	}
	list, err := p.getEmails(ctx, []string{ref.ID}, jmapFullProps, map[string]any{
		"fetchTextBodyValues": true, "fetchHTMLBodyValues": true, "maxBodyValueBytes": jmapMaxBody})
	if err != nil {
		return msg, err
	}
	if len(list) != 1 {
		return msg, errMailGone
	}
	e := &list[0]
	msg = MailMessage{MailSummary: e.summary(p.roleOf(e, ref.Role)), Cc: jmapAddrs(e.Cc), Bcc: jmapAddrs(e.Bcc),
		ReplyTo: jmapAddrs(e.ReplyTo), References: e.References}
	msg.Text, msg.HTML, msg.Cut = jmapBodies(e)
	msg.Parts = jmapParts(e, msg.HTML)
	if refRole(msg.Ref) == RoleDrafts {
		text := func(p *string) string {
			if p == nil {
				return ""
			}
			return *p
		}
		msg.keepRest(text(e.TypedTo), text(e.TypedCc), text(e.TypedBcc))
	}
	if !msg.Seen {
		if done, _, err := p.update(ctx, map[string]map[string]any{e.ID: {"keywords/$seen": true}}); err == nil && len(done) == 1 {
			msg.Seen = true
		}
	}
	return msg, nil
}

func (p *jmapProvider) Attachment(ctx context.Context, ref MailRef, part string) (MailPart, []byte, error) {
	var info MailPart
	if ref.ID == "" || !jmapIDOK(part) {
		return info, nil, errMailGone
	}
	list, err := p.getEmails(ctx, []string{ref.ID}, jmapPartProps, nil)
	if err != nil {
		return info, nil, err
	}
	if len(list) != 1 {
		return info, nil, errMailGone
	}
	found := false
	for _, pt := range jmapParts(&list[0], "") {
		if pt.ID == part {
			info, found = pt, true
		}
	}
	if !found {
		return info, nil, errMailGone // only a blob of THIS message
	}
	s, err := p.session(ctx)
	if err != nil {
		return info, nil, err
	}
	u := strings.NewReplacer("{accountId}", url.PathEscape(p.accountID(s)), "{blobId}", url.PathEscape(part),
		"{name}", url.PathEscape(info.Name), "{type}", url.QueryEscape(info.Type)).Replace(s.DownloadURL)
	resp, err := p.send(ctx, http.MethodGet, u, "", nil)
	if err != nil {
		return info, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return info, nil, errMailGone
	}
	tooBig := fmt.Errorf("jmap: the file is over %d MB: %w", jmapMaxFile>>20, errMailTooBig)
	if resp.ContentLength > jmapMaxFile {
		return info, nil, tooBig
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, jmapMaxFile+1))
	if err == nil && int64(len(data)) > jmapMaxFile {
		return info, nil, tooBig
	}
	return info, data, err
}

// update patches Emails (id -> patch), as many at a time as the server
// takes. It answers the ids changed and the ones refused, with why.
func (p *jmapProvider) update(ctx context.Context, patches map[string]map[string]any) ([]string, map[string]jmapSetError, error) {
	var done []string
	bad := map[string]jmapSetError{}
	if len(patches) == 0 {
		return done, bad, nil
	}
	s, err := p.session(ctx)
	if err != nil {
		return nil, nil, err
	}
	ids := make([]string, 0, len(patches))
	for id := range patches {
		ids = append(ids, id)
	}
	for start := 0; start < len(ids); start += s.maxSet {
		upd := map[string]any{}
		for _, id := range ids[start:min(start+s.maxSet, len(ids))] {
			upd[id] = patches[id]
		}
		res, err := p.call(ctx, jmapCall{"Email/set", map[string]any{"update": upd}, "s"})
		if err != nil {
			return nil, nil, err
		}
		var got struct {
			Updated    map[string]any          `json:"updated"`
			NotUpdated map[string]jmapSetError `json:"notUpdated"`
		}
		json.Unmarshal(res["s"], &got)
		for id := range got.Updated {
			done = append(done, id)
		}
		for id, e := range got.NotUpdated {
			bad[id] = e
		}
	}
	return done, bad, nil
}

// destroy destroys Emails, as many at a time as the server takes: the ids
// refused, with why (one already gone is not refused).
func (p *jmapProvider) destroy(ctx context.Context, ids []string) (map[string]jmapSetError, error) {
	bad := map[string]jmapSetError{}
	s, err := p.session(ctx)
	if err != nil {
		return nil, err
	}
	for start := 0; start < len(ids); start += s.maxSet {
		res, err := p.call(ctx, jmapCall{"Email/set", map[string]any{"destroy": ids[start:min(start+s.maxSet, len(ids))]}, "d"})
		if err != nil {
			return nil, err
		}
		var got struct {
			NotDestroyed map[string]jmapSetError `json:"notDestroyed"`
		}
		json.Unmarshal(res["d"], &got)
		for id, e := range got.NotDestroyed {
			if e.Type != "notFound" {
				bad[id] = e
			}
		}
	}
	return bad, nil
}

// jmapMoved: the SetError type expunge gives a message it left alone
// because it is no longer where its ref says.
const jmapMoved = "nayive:moved"

// failed turns what was not done into the error Set and Expunge answer:
// nil for none; for all of them, the reason (errMailGone when they had only
// moved or gone); for some, a *mailPartialError naming their refs.
func jmapFailed(refsOf map[string][]MailRef, total int, bad map[string]jmapSetError) error {
	if len(bad) == 0 {
		return nil
	}
	if len(bad) >= total {
		for _, e := range bad {
			if e.Type != jmapMoved && e.Type != "notFound" {
				return e.reject()
			}
		}
		return errMailGone
	}
	pe := &mailPartialError{Failed: map[string]bool{}}
	for id := range bad {
		for _, r := range refsOf[id] {
			pe.Failed[r.String()] = true
		}
	}
	return pe
}

func (p *jmapProvider) Set(ctx context.Context, refs []MailRef, ch MailChange) (map[string]MailRef, error) {
	moved := map[string]MailRef{}
	refsOf := map[string][]MailRef{}
	var ids []string
	for _, r := range refs {
		if r.ID == "" {
			continue
		}
		if _, dup := refsOf[r.ID]; !dup {
			ids = append(ids, r.ID)
		}
		refsOf[r.ID] = append(refsOf[r.ID], r)
	}
	if len(ids) == 0 {
		return moved, nil
	}
	base := map[string]any{}
	if ch.Seen != nil {
		base["keywords/$seen"] = jmapFlag(*ch.Seen)
	}
	if ch.Flagged != nil {
		base["keywords/$flagged"] = jmapFlag(*ch.Flagged)
	}
	patches := map[string]map[string]any{}
	bad := map[string]jmapSetError{}
	if ch.Move == "" {
		if len(base) == 0 {
			return moved, nil
		}
		for _, id := range ids {
			patches[id] = base
		}
	} else {
		dest, err := p.box(ctx, ch.Move)
		if err != nil {
			return nil, err
		}
		if dest == "" {
			return nil, errMailNoTray
		}
		// where each one is now: out of every tray's Mailbox, into dest -
		// the Mailboxes that are no tray (a folder, a label) stay
		list, err := p.getEmails(ctx, ids, []string{"id", "mailboxIds"}, nil)
		if err != nil {
			return nil, err
		}
		p.mu.Lock()
		trays, spam := map[string]bool{}, p.boxes[RoleSpam]
		for b := range p.boxRole {
			trays[b] = true
		}
		p.mu.Unlock()
		found := map[string]bool{}
		for _, e := range list {
			found[e.ID] = true
			patch := map[string]any{}
			for k, v := range base {
				patch[k] = v
			}
			for b := range e.MailboxIDs {
				if trays[b] && b != dest {
					patch["mailboxIds/"+b] = nil
				}
			}
			patch["mailboxIds/"+dest] = true
			switch {
			case ch.Move == RoleSpam: // the user says: junk
				patch["keywords/$junk"], patch["keywords/$notjunk"] = true, nil
			case spam != "" && e.MailboxIDs[spam] && ch.Move == RoleInbox: // "Not spam"
				patch["keywords/$notjunk"], patch["keywords/$junk"] = true, nil
			}
			patches[e.ID] = patch
		}
		for _, id := range ids {
			if !found[id] {
				bad[id] = jmapSetError{Type: "notFound"}
			}
		}
	}
	done, refused, err := p.update(ctx, patches)
	if err != nil {
		return nil, err
	}
	for id, e := range refused {
		bad[id] = e
	}
	if ch.Move != "" {
		for _, id := range done {
			for _, r := range refsOf[id] {
				moved[r.String()] = MailRef{Role: ch.Move, ID: id}
			}
		}
	}
	return moved, jmapFailed(refsOf, len(ids), bad)
}

// jmapFlag: a keyword on is true; off is null (removed), never false.
func jmapFlag(on bool) any {
	if on {
		return true
	}
	return nil
}

// expunge destroys what is still where its ref says (a draft: in Drafts,
// still a $draft). It answers the ids NOT destroyed: left alone because they
// moved since (type jmapMoved), or refused by the server. One gone already is
// neither.
func (p *jmapProvider) expunge(ctx context.Context, refs []MailRef) (map[string]jmapSetError, error) {
	bad := map[string]jmapSetError{}
	want := map[string]MailRole{}
	var ids []string
	for _, r := range refs {
		if r.ID != "" {
			if _, dup := want[r.ID]; !dup {
				ids = append(ids, r.ID)
			}
			want[r.ID] = r.Role
		}
	}
	if len(ids) == 0 {
		return bad, nil
	}
	if _, err := p.box(ctx, RoleInbox); err != nil {
		return nil, err
	}
	list, err := p.getEmails(ctx, ids, []string{"id", "mailboxIds", "keywords"}, nil)
	if err != nil {
		return nil, err
	}
	var doomed []string
	out := map[string]map[string]any{}
	for _, e := range list {
		role := want[e.ID]
		p.mu.Lock()
		box := p.boxes[role]
		p.mu.Unlock()
		if box == "" || !e.MailboxIDs[box] || (role == RoleDrafts && !e.Keywords["$draft"]) {
			bad[e.ID] = jmapSetError{Type: jmapMoved}
			continue
		}
		// In another Mailbox too (a Fastmail folder or label the user
		// still sees it in - a Delete here keeps those, by design): it only
		// leaves this one. Destroying the Email took it out of that folder
		// too (data-safety I8, mail-chat #8).
		if len(e.MailboxIDs) > 1 {
			out[e.ID] = map[string]any{"mailboxIds/" + box: nil}
			continue
		}
		doomed = append(doomed, e.ID)
	}
	if len(out) > 0 {
		_, refused, err := p.update(ctx, out)
		if err != nil {
			return nil, err
		}
		for id, e := range refused {
			bad[id] = e
		}
	}
	if len(doomed) == 0 {
		return bad, nil
	}
	refused, err := p.destroy(ctx, doomed)
	if err != nil {
		return nil, err
	}
	for id, e := range refused {
		bad[id] = e
	}
	return bad, nil
}

func (p *jmapProvider) Expunge(ctx context.Context, refs []MailRef) error {
	bad, err := p.expunge(ctx, refs)
	if err != nil {
		return err
	}
	refsOf := map[string][]MailRef{}
	for _, r := range refs {
		if r.ID != "" {
			refsOf[r.ID] = append(refsOf[r.ID], r)
		}
	}
	return jmapFailed(refsOf, len(refsOf), bad)
}

// query answers the ids a filter finds, newest first (up to limit).
func (p *jmapProvider) query(ctx context.Context, filter map[string]any, limit int) ([]string, error) {
	res, err := p.call(ctx, jmapCall{"Email/query", map[string]any{"filter": filter,
		"sort": []any{map[string]any{"property": "receivedAt", "isAscending": false}}, "limit": limit}, "q"})
	if err != nil {
		return nil, err
	}
	var q struct {
		IDs []string `json:"ids"`
	}
	err = json.Unmarshal(res["q"], &q)
	return q.IDs, err
}

func (p *jmapProvider) Find(ctx context.Context, messageID string, roles []MailRole) (MailSummary, error) {
	var found MailSummary
	if messageID == "" || strings.HasPrefix(messageID, "h:") {
		return found, errMailGone
	}
	if roles == nil {
		roles = mailRoles
	}
	if _, err := p.box(ctx, RoleInbox); err != nil {
		return found, err
	}
	// the "header" filter is a text search (RFC 8621 4.4.1): its hits are
	// only candidates - kept when their Message-ID is exactly this one
	ids, err := p.query(ctx, map[string]any{"header": []string{"Message-ID", "<" + messageID + ">"}}, 50)
	if err != nil {
		return found, err
	}
	list, err := p.getEmails(ctx, ids, jmapRowProps, nil)
	if err != nil {
		return found, err
	}
	var exact []jmapEmail
	for _, e := range list {
		if contains(e.MessageID, messageID) {
			exact = append(exact, e)
		}
	}
	for _, role := range roles {
		p.mu.Lock()
		box := p.boxes[role]
		p.mu.Unlock()
		for i := range exact {
			if box != "" && exact[i].MailboxIDs[box] {
				return exact[i].summary(role), nil
			}
		}
	}
	return found, errMailGone
}

// FindAll (mailFinderAll) is every Email with this Message-ID in one tray,
// newest first (data-safety I9).
func (p *jmapProvider) FindAll(ctx context.Context, messageID string, role MailRole) ([]MailSummary, error) {
	var out []MailSummary
	if messageID == "" || strings.HasPrefix(messageID, "h:") {
		return out, nil
	}
	box, err := p.box(ctx, role)
	if err != nil || box == "" {
		return out, err
	}
	ids, err := p.query(ctx, map[string]any{"operator": "AND", "conditions": []any{
		map[string]any{"inMailbox": box}, map[string]any{"header": []string{"Message-ID", "<" + messageID + ">"}}}}, 50)
	if err != nil {
		return out, err
	}
	list, err := p.getEmails(ctx, ids, jmapRowProps, nil)
	if err != nil {
		return out, err
	}
	byID := map[string]*jmapEmail{}
	for i := range list {
		byID[list[i].ID] = &list[i]
	}
	for _, id := range ids { // the query's order: newest first
		if e := byID[id]; e != nil && e.MailboxIDs[box] && contains(e.MessageID, messageID) {
			out = append(out, e.summary(role))
		}
	}
	return out, nil
}

// Anywhere (mailAnywhere): an Email with this Message-ID in any Mailbox at
// all - the query is not limited to the trays. Its answer decides whether a
// message's labels are dropped for good (I3).
func (p *jmapProvider) Anywhere(ctx context.Context, messageID string) (bool, error) {
	if messageID == "" || strings.HasPrefix(messageID, "h:") {
		return true, nil // a made-up name cannot be searched for
	}
	ids, err := p.query(ctx, map[string]any{"header": []string{"Message-ID", "<" + messageID + ">"}}, 50)
	if err != nil {
		return false, err
	}
	list, err := p.getEmails(ctx, ids, []string{"id", "messageId"}, nil)
	if err != nil {
		return false, err
	}
	for _, e := range list {
		if contains(e.MessageID, messageID) {
			return true, nil
		}
	}
	return false, nil
}

// Scan is every message of a tray, page after page until the query's total.
func (p *jmapProvider) Scan(ctx context.Context, role MailRole) ([]MailSummary, error) {
	out := []MailSummary{}
	box, err := p.box(ctx, role)
	if err != nil || box == "" {
		return out, err
	}
	s, err := p.session(ctx)
	if err != nil {
		return out, err
	}
	size := min(500, s.maxGet)
	pos := 0
	for page := 0; page < jmapMaxPages; page++ {
		res, err := p.call(ctx,
			jmapCall{"Email/query", map[string]any{"filter": map[string]any{"inMailbox": box},
				"sort":     []any{map[string]any{"property": "receivedAt", "isAscending": false}},
				"position": pos, "limit": size, "calculateTotal": true}, "q"},
			jmapCall{"Email/get", map[string]any{"#ids": map[string]any{"resultOf": "q", "name": "Email/query", "path": "/ids"},
				"properties": jmapScanProps}, "g"})
		if err != nil {
			return out, err
		}
		var q struct {
			IDs   []string `json:"ids"`
			Total int      `json:"total"`
		}
		var g struct {
			List []jmapEmail `json:"list"`
		}
		json.Unmarshal(res["q"], &q)
		json.Unmarshal(res["g"], &g)
		for i := range g.List {
			out = append(out, g.List[i].summary(role))
		}
		pos += len(q.IDs)
		if len(q.IDs) == 0 || (q.Total > 0 && pos >= q.Total) || (q.Total == 0 && len(q.IDs) < size) {
			break
		}
	}
	return out, nil
}

func (p *jmapProvider) LatestUnseen(ctx context.Context) (MailSummary, bool, error) {
	box, err := p.box(ctx, RoleInbox)
	if err != nil || box == "" {
		return MailSummary{}, false, err
	}
	ids, err := p.query(ctx, map[string]any{"operator": "AND", "conditions": []any{
		map[string]any{"inMailbox": box}, map[string]any{"notKeyword": "$seen"}}}, 1)
	if err != nil || len(ids) == 0 {
		return MailSummary{}, false, err
	}
	list, err := p.getEmails(ctx, ids, jmapRowProps, nil)
	if err != nil || len(list) == 0 {
		return MailSummary{}, false, err
	}
	return list[0].summary(RoleInbox), true, nil
}

// -----------------------------------------------------------------------------
// sending and drafts
// -----------------------------------------------------------------------------

// upload puts a built message up as a blob.
func (p *jmapProvider) upload(ctx context.Context, raw []byte) (string, error) {
	s, err := p.session(ctx)
	if err != nil {
		return "", err
	}
	if s.maxUpload > 0 && int64(len(raw)) > s.maxUpload {
		return "", fmt.Errorf("%w: %d bytes, the server takes %d", errMailTooBig, len(raw), s.maxUpload)
	}
	u := strings.ReplaceAll(s.UploadURL, "{accountId}", url.PathEscape(p.accountID(s)))
	resp, err := p.send(ctx, http.MethodPost, u, "message/rfc822", raw)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var got struct {
		BlobID string `json:"blobId"`
	}
	if resp.StatusCode == http.StatusRequestEntityTooLarge {
		return "", fmt.Errorf("%w: the server refused %d bytes", errMailTooBig, len(raw))
	}
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("jmap: upload answered %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&got); err != nil || got.BlobID == "" {
		return "", errors.New("jmap: upload gave no blob")
	}
	return got.BlobID, nil
}

// importTo puts the uploaded message in a Mailbox with those keywords.
func (p *jmapProvider) importTo(ctx context.Context, blob, box string, keywords map[string]bool) (string, error) {
	res, err := p.call(ctx, jmapCall{"Email/import", map[string]any{"emails": map[string]any{
		"k": map[string]any{"blobId": blob, "mailboxIds": map[string]bool{box: true}, "keywords": keywords}}}, "i"})
	if err != nil {
		return "", err
	}
	var got struct {
		Created    map[string]struct{ ID string } `json:"created"`
		NotCreated map[string]jmapSetError        `json:"notCreated"`
	}
	json.Unmarshal(res["i"], &got)
	if c, ok := got.Created["k"]; ok && c.ID != "" {
		return c.ID, nil
	}
	if e, ok := got.NotCreated["k"]; ok {
		return "", e.reject()
	}
	return "", errors.New("jmap: import gave no Email")
}

// identity is the Identity that sends as `from`: that address, else the
// account's "*@domain" one. None: a refusal in words, never some other one.
func (p *jmapProvider) identity(ctx context.Context, from string) (string, error) {
	res, err := p.call(ctx, jmapCall{"Identity/get", map[string]any{"ids": nil}, "id"})
	if err != nil {
		return "", err
	}
	var got struct {
		List []struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"list"`
	}
	json.Unmarshal(res["id"], &got)
	for _, i := range got.List {
		if strings.EqualFold(i.Email, from) {
			return i.ID, nil
		}
	}
	if at := strings.LastIndexByte(from, '@'); at >= 0 {
		for _, i := range got.List {
			if strings.EqualFold(i.Email, "*"+from[at:]) {
				return i.ID, nil
			}
		}
	}
	return "", &mailRejectError{Text: "the JMAP server has no identity to send as " + from}
}

// CheckSend: the server offers sending, and an identity sends as the
// account's address (mailSendChecker: asked before the account is kept).
func (p *jmapProvider) CheckSend(ctx context.Context) error {
	_, err := p.identity(ctx, p.acct.Email)
	return err
}

// Send. The stored copy is `raw`, not `copy`: RFC 8621 does not promise that
// the server drops a Bcc header on delivery, so a copy with Bcc could reach
// the recipients.
func (p *jmapProvider) Send(ctx context.Context, raw, copy []byte, from string, rcpts []string) error {
	ident, err := p.identity(ctx, from)
	if err != nil {
		return err
	}
	blob, err := p.upload(ctx, raw)
	if err != nil {
		return err
	}
	// Sent, where it belongs; with no Sent, somewhere for the submission to
	// read it from - and it destroys it once sent
	box, err := p.box(ctx, RoleSent)
	if err != nil {
		return err
	}
	noCopy, keywords := box == "", map[string]bool{"$seen": true}
	if noCopy {
		if box, err = p.anyBox(ctx); err != nil {
			return err
		}
		keywords["$draft"] = true
	}
	id, err := p.importTo(ctx, blob, box, keywords)
	if err != nil {
		return err
	}
	var to []map[string]string
	for _, r := range rcpts {
		to = append(to, map[string]string{"email": r})
	}
	sub := map[string]any{"create": map[string]any{
		"s": map[string]any{"identityId": ident, "emailId": id,
			"envelope": map[string]any{"mailFrom": map[string]string{"email": from}, "rcptTo": to}}}}
	if noCopy {
		sub["onSuccessDestroyEmail"] = []string{"#s"}
	}
	res, err := p.call(ctx, jmapCall{"EmailSubmission/set", sub, "sub"})
	var got struct {
		Created    map[string]any          `json:"created"`
		NotCreated map[string]jmapSetError `json:"notCreated"`
	}
	if err != nil {
		var je *jmapError
		var re *mailRejectError
		if !errors.As(err, &je) && !errors.As(err, &re) {
			// No answer (the line died, a timeout, a 500): the server may
			// have taken it. Its copy stays where it is - never destroyed on
			// a doubt, or a mail that went leaves no trace in Sent (I6)
			return fmt.Errorf("%w: %v", errMailUnsure, err)
		}
	} else {
		json.Unmarshal(res["sub"], &got)
		if _, ok := got.Created["s"]; !ok {
			e, refused := got.NotCreated["s"]
			if !refused { // answered, but not about it: the same doubt
				return fmt.Errorf("%w: the submission gave no answer", errMailUnsure)
			}
			err = e.reject()
		}
	}
	if err != nil {
		p.destroy(ctx, []string{id}) // refused: not sent, so no "sent" copy either
		return err
	}
	if noCopy {
		return errMailNoCopy
	}
	return nil
}

// anyBox: a Mailbox to hold a message for a moment - Drafts, else the first.
func (p *jmapProvider) anyBox(ctx context.Context) (string, error) {
	list, err := p.mailboxes(ctx)
	if err != nil {
		return "", err
	}
	p.mu.Lock()
	drafts := p.boxes[RoleDrafts]
	p.mu.Unlock()
	if drafts != "" {
		return drafts, nil
	}
	if len(list) == 0 {
		return "", errMailNoTray
	}
	return list[0].ID, nil
}

// SaveDraft: import the new draft, learn its parts, and only then destroy the
// one it replaces. The parts cannot be learnt: the new one goes again and the
// old one stays, so nothing the writer holds points at nothing. The old one
// refused: the new ref with errMailLeftover (one that moved since - sent from
// another app - is no leftover, and is left alone).
func (p *jmapProvider) SaveDraft(ctx context.Context, raw []byte, mid string, old *MailRef) (MailRef, []MailPart, error) {
	blob, err := p.upload(ctx, raw)
	if err != nil {
		return MailRef{}, nil, err
	}
	box, err := p.box(ctx, RoleDrafts)
	if err != nil {
		return MailRef{}, nil, err
	}
	if box == "" {
		return MailRef{}, nil, errMailNoTray
	}
	id, err := p.importTo(ctx, blob, box, map[string]bool{"$draft": true, "$seen": true})
	if err != nil {
		return MailRef{}, nil, err
	}
	ref := MailRef{Role: RoleDrafts, ID: id}
	var list []jmapEmail
	for try := 0; try < 2; try++ {
		if list, err = p.getEmails(ctx, []string{id}, jmapPartProps, nil); err == nil && len(list) == 1 {
			break
		}
	}
	if err != nil || len(list) != 1 {
		p.destroy(ctx, []string{id})
		if err == nil {
			err = errors.New("jmap: the new draft's parts could not be read")
		}
		return MailRef{}, nil, err
	}
	parts := []MailPart{}
	for _, pt := range jmapParts(&list[0], "") {
		if !pt.Inline {
			parts = append(parts, pt)
		}
	}
	if old != nil && old.ID != "" && old.ID != id {
		bad, err := p.expunge(ctx, []MailRef{*old})
		if err != nil {
			return ref, parts, errMailLeftover
		}
		for _, e := range bad {
			if e.Type != jmapMoved {
				return ref, parts, errMailLeftover
			}
		}
	}
	return ref, parts, nil
}
