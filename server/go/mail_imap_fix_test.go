package main

// =============================================================================
// eMail, the IMAP / SMTP / MIME side of the audit's fixes (docs/audit/email.md):
// each test names the items it holds.
// =============================================================================

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
)

// noSMTPCheck stands in for the SMTP login check where the tests have no
// SMTP server.
func noSMTPCheck(context.Context, MailAccount) error { return nil }

// memProvider is an IMAP provider on the in-memory server, counting its dials.
func memProvider(addr string, dials *atomic.Int32) *imapProvider {
	p := newIMAPProvider(MailAccount{ID: "a1", Email: mailTestUser, User: mailTestUser, Pass: mailTestPass})
	inner := dialMemIMAP(addr)
	p.dial = func(a MailAccount) (*imapclient.Client, error) {
		if dials != nil {
			dials.Add(1)
		}
		return inner(a)
	}
	p.smtpCheck = noSMTPCheck
	return p
}

// memClient is a plain client on the in-memory server, as "another device".
func memClient(t *testing.T, addr string) *imapclient.Client {
	t.Helper()
	c, err := dialMemIMAP(addr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func firstRef(t *testing.T, p *imapProvider, role MailRole) MailRef {
	t.Helper()
	page, err := p.List(t.Context(), role, "", "")
	if err != nil || len(page.Items) == 0 {
		t.Fatalf("list %s: %v %+v", role, err, page)
	}
	r, _ := parseMailRef(page.Items[0].Ref)
	return r
}

// #2: a mail connection never goes to this server's own network.
func TestMailFixDialGuard(t *testing.T) {
	mailNetGuard = true
	defer func() { mailNetGuard = false }()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	n, _ := strconv.Atoi(port)
	a := MailAccount{IMAPHost: host, IMAPPort: n, SMTPHost: host, SMTPPort: n, User: "u", Pass: "p"}
	if _, err := dialIMAP(a); !errors.Is(err, errMailPrivateNet) {
		t.Fatalf("imap to 127.0.0.1 = %v", err)
	}
	if err := smtpCheck(t.Context(), a); !errors.Is(err, errMailPrivateNet) {
		t.Fatalf("smtp to 127.0.0.1 = %v", err)
	}
	for _, ip := range []string{"10.1.2.3", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "0.0.0.0"} {
		if mailPublicIP(net.ParseIP(ip)) {
			t.Errorf("%s counted as public", ip)
		}
	}
	if !mailPublicIP(net.ParseIP("142.250.1.1")) {
		t.Error("a public address refused")
	}
}

// #4 #57: a tag split by a removed one cannot re-form; entity-written
// javascript: goes; the text itself is left alone.
func TestMailFixSanitize(t *testing.T) {
	for _, in := range []string{
		`<scr<iframe>ipt>alert(1)</script>`,
		`<ifr<meta>ame src=https://evil/>`,
		`<scr<form>ipt src=https://evil/x.js>`,
		`<scr<scr<iframe>ipt>ipt>x`,
	} {
		out := strings.ToLower(sanitizeMailHTML(in, nil))
		if strings.Contains(out, "<script") || strings.Contains(out, "<iframe") {
			t.Errorf("%s -> %s", in, out)
		}
	}
	for _, in := range []string{
		`<a href="jav&#x61;script:alert(1)">x</a>`,
		`<a href="&#106;avascript:x">x</a>`,
		`<a href='java&#9;script:x'>x</a>`,
		`<a href=javas&#99;ript:x>x</a>`,
		`<object data="d&#97;ta:text/html,x">`,
	} {
		out := sanitizeMailHTML(in, nil)
		plain := strings.ToLower(reMailCtl.ReplaceAllString(html.UnescapeString(out), ""))
		if strings.Contains(plain, "javascript:") || strings.Contains(plain, "data:text/html") {
			t.Errorf("%s -> %s", in, out)
		}
	}
	text := "<p>go online = now, only = 5 euros; onClick = the button</p>"
	if out := sanitizeMailHTML(text, nil); out != text {
		t.Errorf("text changed: %s", out)
	}
	if out := sanitizeMailHTML(`<b onclick="x()" class=a>t</b>`, nil); strings.Contains(out, "onclick") || !strings.Contains(out, "class=a") {
		t.Errorf("handler: %s", out)
	}
}

// #6: without MOVE, a COPY that fails leaves the message where it was.
func TestMailFixMoveCopyFails(t *testing.T) {
	addr := startMemIMAP(t) // no MOVE, no UIDPLUS
	appendMail(t, addr, "INBOX", plainMail(1), false)
	p := memProvider(addr, nil)
	ref := firstRef(t, p, RoleInbox)
	if _, err := p.Trays(t.Context()); err != nil { // the folders are known now
		t.Fatal(err)
	}
	c := memClient(t, addr)
	if err := c.Delete("Trash").Wait(); err != nil { // another device removes it
		t.Fatal(err)
	}
	if _, err := p.Set(t.Context(), []MailRef{ref}, MailChange{Move: RoleTrash}); err == nil {
		t.Fatal("a move into a missing folder worked")
	}
	if page, err := p.List(t.Context(), RoleInbox, "", ""); err != nil || len(page.Items) != 1 {
		t.Fatalf("the message is gone: %v %+v", err, page.Items)
	}
}

// #7: without UIDPLUS, deleting one never erases what another client only
// marked \Deleted.
func TestMailFixExpungeKeepsOthers(t *testing.T) {
	addr := startMemIMAP(t)
	appendMail(t, addr, "INBOX", plainMail(1), false)
	appendMail(t, addr, "INBOX", plainMail(2), false)
	c := memClient(t, addr)
	if _, err := c.Select("INBOX", nil).Wait(); err != nil {
		t.Fatal(err)
	}
	// Thunderbird's "mark as deleted": message 1 marked, not expunged
	if err := c.Store(imap.SeqSetNum(1), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true,
		Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close(); err != nil {
		t.Fatal(err)
	}
	p := memProvider(addr, nil)
	page, _ := p.List(t.Context(), RoleInbox, "", "")
	var two MailRef
	for _, it := range page.Items {
		if it.Subject == "Hello 2" {
			two, _ = parseMailRef(it.Ref)
		}
	}
	if _, err := p.Set(t.Context(), []MailRef{two}, MailChange{Move: RoleTrash}); err != nil {
		t.Fatal(err)
	}
	st, err := c.Status("INBOX", &imap.StatusOptions{NumMessages: true}).Wait()
	if err != nil || st.NumMessages == nil || *st.NumMessages != 1 {
		t.Fatalf("inbox after the move: %+v %v", st, err)
	}
	if err := p.Expunge(t.Context(), []MailRef{firstRef(t, p, RoleTrash)}); err != nil {
		t.Fatal(err)
	}
	st, _ = c.Status("INBOX", &imap.StatusOptions{NumMessages: true}).Wait()
	if *st.NumMessages != 1 {
		t.Fatalf("the marked one was erased too")
	}
}

// fakeSMTP is an SMTP server that speaks STARTTLS with httptest's own
// certificate (mailTLSRoots trusts it): AUTH PLAIN takes "pw", SIZE is 2000,
// "bad@x.test" is an unknown recipient, and after DATA it hangs up without
// answering QUIT.
type fakeSMTP struct {
	addr string
	mu   sync.Mutex
	got  []string // the commands, as received
}

func startFakeSMTP(t *testing.T) *fakeSMTP {
	t.Helper()
	ts := httptest.NewUnstartedServer(nil)
	ts.StartTLS()
	cert := ts.TLS.Certificates[0]
	pool := x509.NewCertPool()
	pool.AddCert(ts.Certificate())
	ts.Close()
	mailTLSRoots = pool
	t.Cleanup(func() { mailTLSRoots = nil })

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	f := &fakeSMTP{addr: ln.Addr().String()}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(conn, cert)
		}
	}()
	return f
}

func (f *fakeSMTP) serve(conn net.Conn, cert tls.Certificate) {
	defer conn.Close()
	var r *bufio.Reader
	var w net.Conn = conn
	r = bufio.NewReader(conn)
	say := func(s string) { fmt.Fprintf(w, "%s\r\n", s) }
	say("220 fake ESMTP")
	secure := false
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		f.mu.Lock()
		f.got = append(f.got, line)
		f.mu.Unlock()
		up := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(up, "EHLO"):
			if secure {
				say("250-fake\r\n250-AUTH PLAIN\r\n250 SIZE 2000")
			} else {
				say("250-fake\r\n250 STARTTLS")
			}
		case up == "STARTTLS":
			say("220 go ahead")
			tc := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}})
			if tc.Handshake() != nil {
				return
			}
			w, r, secure = tc, bufio.NewReader(tc), true
		case strings.HasPrefix(up, "AUTH PLAIN"):
			raw, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(line[len("AUTH PLAIN"):]))
			if strings.HasSuffix(string(raw), "\x00pw") {
				say("235 ok")
			} else {
				say("535 5.7.8 bad credentials")
			}
		case strings.HasPrefix(up, "MAIL FROM"):
			say("250 ok")
		case strings.HasPrefix(up, "RCPT TO"):
			if strings.Contains(line, "bad@x.test") {
				say("550 5.1.1 no such user here")
			} else {
				say("250 ok")
			}
		case up == "DATA":
			say("354 go")
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" {
					break
				}
			}
			say("250 queued")
		case up == "QUIT":
			return // hangs up with no 221
		default:
			say("502 what")
		}
	}
}

func (f *fakeSMTP) saw(prefix string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, l := range f.got {
		if strings.HasPrefix(strings.ToUpper(l), prefix) {
			return true
		}
	}
	return false
}

// #13 #37 #39 #45: the SMTP side, against a real (fake) SMTP server.
func TestMailFixSMTP(t *testing.T) {
	f := startFakeSMTP(t)
	host, port, _ := net.SplitHostPort(f.addr)
	n, _ := strconv.Atoi(port)
	a := MailAccount{SMTPHost: host, SMTPPort: n, User: "ana", Pass: "pw"}
	ctx := t.Context()

	if err := smtpCheck(ctx, a); err != nil {
		t.Fatalf("check: %v", err)
	}
	bad := a
	bad.Pass = "nope"
	if err := smtpCheck(ctx, bad); !errors.Is(err, errMailAuth) {
		t.Fatalf("check, wrong password: %v", err)
	}
	// sent, although the server hangs up instead of answering QUIT
	if err := smtpSend(ctx, a, "ana@x.test", []string{"bob@x.test"}, []byte("Subject: hi\r\n\r\nhi\r\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	// a refused recipient: the server's words, and which address
	err := smtpSend(ctx, a, "ana@x.test", []string{"bob@x.test", "bad@x.test"}, []byte("Subject: hi\r\n\r\nhi\r\n"))
	var re *mailRejectError
	if !errors.As(err, &re) || !errors.Is(err, errMailRejected) || !strings.Contains(re.Text, "bad@x.test") || !strings.Contains(re.Text, "550") {
		t.Fatalf("refused rcpt: %v", err)
	}
	// too big for its SIZE: refused before MAIL FROM
	f.mu.Lock()
	f.got = nil
	f.mu.Unlock()
	if err := smtpSend(ctx, a, "ana@x.test", []string{"bob@x.test"}, bytes.Repeat([]byte("x"), 3000)); !errors.Is(err, errMailTooBig) {
		t.Fatalf("too big: %v", err)
	}
	if f.saw("MAIL FROM") {
		t.Fatal("a message too big was still offered")
	}
	// the provider's CheckSend is the same check
	p := newIMAPProvider(a)
	if err := p.CheckSend(ctx); err != nil {
		t.Fatalf("CheckSend: %v", err)
	}
}

// #14 #66: the copy in Sent is the one given (with Bcc), put there even when
// the app left right after Send; a server that files its own gets none.
func TestMailFixSentCopy(t *testing.T) {
	addr := startMemIMAP(t, imap.CapUIDPlus)
	p := memProvider(addr, nil)
	ctx, cancel := context.WithCancel(t.Context())
	p.smtp = func(context.Context, MailAccount, string, []string, []byte) error {
		cancel() // the phone locks the moment it is sent
		return nil
	}
	raw := "From: ana@example.com\r\nTo: bob@x.test\r\nSubject: s1\r\nMessage-ID: <s1@x>\r\n\r\nhi\r\n"
	copy := "From: ana@example.com\r\nTo: bob@x.test\r\nBcc: eve@x.test\r\nSubject: s1\r\nMessage-ID: <s1@x>\r\n\r\nhi\r\n"
	if err := p.Send(ctx, []byte(raw), []byte(copy), "ana@example.com", []string{"bob@x.test", "eve@x.test"}); err != nil {
		t.Fatal(err)
	}
	m, err := p.Message(t.Context(), firstRef(t, p, RoleSent))
	if err != nil || len(m.Bcc) != 1 || m.Bcc[0].Addr != "eve@x.test" {
		t.Fatalf("the copy in Sent: %+v %v", m.Bcc, err)
	}

	g := memProvider(addr, nil)
	g.acct.Provider = "gmail"
	g.smtp = func(context.Context, MailAccount, string, []string, []byte) error { return nil }
	if err := g.Send(t.Context(), []byte(raw), []byte(copy), "a", []string{"b"}); err != nil {
		t.Fatal(err)
	}
	if page, _ := g.List(t.Context(), RoleSent, "", ""); len(page.Items) != 1 {
		t.Fatalf("Gmail got a second copy: %d", len(page.Items))
	}
}

// #15: a server that greets and then never answers holds nothing for good.
func TestMailFixLoginHang(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Write([]byte("* OK ready\r\n"))
			go func() { time.Sleep(time.Minute); c.Close() }()
		}
	}()
	old := mailLoginTime
	mailLoginTime = 300 * time.Millisecond
	defer func() { mailLoginTime = old }()
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	n, _ := strconv.Atoi(port)
	p := newIMAPProvider(MailAccount{IMAPHost: host, IMAPPort: n, User: "u", Pass: "p"})
	for i := 0; i < 2; i++ { // and the account is free again after
		start := time.Now()
		_, err := p.Poll(t.Context(), "")
		if err == nil || time.Since(start) > 5*time.Second {
			t.Fatalf("poll %d: %v after %v", i, err, time.Since(start))
		}
	}
}

// #38: only a refused login is "wrong password".
func TestMailFixLoginErrors(t *testing.T) {
	for code, want := range map[imap.ResponseCode]string{
		"": "auth", imap.ResponseCodeAuthenticationFailed: "auth", imap.ResponseCodeAuthorizationFailed: "auth",
		imap.ResponseCodeAlert: "rejected", imap.ResponseCodeUnavailable: "down",
	} {
		err := imapLoginError(&imap.Error{Type: imap.StatusResponseTypeNo, Code: code, Text: "Too many simultaneous connections"})
		got := "down"
		if errors.Is(err, errMailAuth) {
			got = "auth"
		} else if errors.Is(err, errMailRejected) {
			got = "rejected"
		}
		if got != want {
			t.Errorf("%q = %s, want %s", code, got, want)
		}
	}
}

// #16 #29: a caller that left starts nothing, a cancel mid-command does not
// cut the shared line, and a waiter gives up with its context.
func TestMailFixConnection(t *testing.T) {
	addr := startMemIMAP(t)
	var dials atomic.Int32
	p := memProvider(addr, &dials)
	if _, err := p.Poll(t.Context(), ""); err != nil {
		t.Fatal(err)
	}
	c1 := p.c
	gone, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := p.Poll(gone, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("a caller that left: %v", err)
	}
	ctx, cancel2 := context.WithCancel(t.Context())
	err := p.do(ctx, func(c *imapclient.Client) error {
		cancel2() // the phone locks mid-command
		time.Sleep(100 * time.Millisecond)
		_, err := c.Status("INBOX", &imap.StatusOptions{NumMessages: true}).Wait()
		return err
	})
	if err != nil {
		t.Fatalf("the command was cut: %v", err)
	}
	select {
	case <-c1.Closed():
		t.Fatal("the shared connection was closed")
	default:
	}
	if p.c != c1 || dials.Load() != 1 {
		t.Fatalf("a new connection: dials %d", dials.Load())
	}

	p.lock <- struct{}{} // busy
	short, cancel3 := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel3()
	start := time.Now()
	if _, err := p.Poll(short, ""); !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 2*time.Second {
		t.Fatalf("a waiter: %v after %v", err, time.Since(start))
	}
	p.release()
}

// mimeMail is a raw message with a multipart body; parts are
// "Content-Type...\n\nbody" blocks.
func mimeMail(id, subject string, extraHead string, parts ...string) string {
	b := "From: Bob <bob@example.com>\nTo: ana@example.com\nSubject: " + subject + "\n" +
		"Date: Mon, 01 Sep 2026 10:00:00 +0000\nMessage-ID: <" + id + ">\n" + extraHead +
		"MIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=\"B\"\n\n"
	for _, p := range parts {
		b += "--B\n" + p + "\n"
	}
	return b + "--B--\n"
}

// #24 #28 #29 #61 #62: an Apple-Mail split body is one; sizes are the
// file's; a big part comes over its own connection; the thread; a long
// body is cut and says so.
func TestMailFixMessage(t *testing.T) {
	addr := startMemIMAP(t, imap.CapUIDPlus)
	big := bytes.Repeat([]byte("0123456789abcdef"), 96<<10) // 1.5 MB
	b64 := base64.StdEncoding.EncodeToString(big)
	var lines []string
	for len(b64) > 76 {
		lines, b64 = append(lines, b64[:76]), b64[76:]
	}
	lines = append(lines, b64)
	appendMail(t, addr, "INBOX", mimeMail("split@x", "split", "In-Reply-To: <parent@x>\n",
		"Content-Type: text/html; charset=utf-8\n\n<p>one</p>",
		"Content-Type: application/octet-stream; name=\"big.bin\"\nContent-Disposition: inline; filename=\"big.bin\"\nContent-Transfer-Encoding: base64\n\n"+strings.Join(lines, "\n"),
		"Content-Type: text/html; charset=utf-8\n\n<p>two</p>"), false)
	var dials atomic.Int32
	p := memProvider(addr, &dials)
	ref := firstRef(t, p, RoleInbox)
	m, err := p.Message(t.Context(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(m.HTML, "one") || !strings.Contains(m.HTML, "two") || len(m.Parts) != 1 || m.Parts[0].Name != "big.bin" {
		t.Fatalf("split body: html %q parts %+v", m.HTML, m.Parts)
	}
	if d := m.Parts[0].Size - int64(len(big)); d < -int64(len(big))/50 || d > int64(len(big))/50 {
		t.Fatalf("size %d for a %d-byte file", m.Parts[0].Size, len(big))
	}
	if len(m.References) != 1 || m.References[0] != "parent@x" {
		t.Fatalf("references = %v", m.References)
	}
	before := dials.Load()
	_, data, err := p.Attachment(t.Context(), ref, m.Parts[0].ID)
	if err != nil || !bytes.Equal(data, big) {
		t.Fatalf("attachment: %v, %d bytes", err, len(data))
	}
	if dials.Load() != before+1 {
		t.Fatalf("the big part did not get its own connection (dials %d -> %d)", before, dials.Load())
	}

	long := strings.Repeat("palabra ", (mailBodyMax/8)+1000)
	appendMail(t, addr, "INBOX", mimeMail("long@x", "long", "", "Content-Type: text/plain; charset=utf-8\n\n"+long), false)
	m2, err := p.Message(t.Context(), firstRef(t, p, RoleInbox))
	if err != nil || !m2.Cut || len(m2.Text) > mailBodyMax || !strings.HasPrefix(m2.Text, "palabra palabra") {
		t.Fatalf("long: cut %v, %d bytes, %v", m2.Cut, len(m2.Text), err)
	}
}

// #23: an HTML-only mail's row never shows its CSS.
func TestMailFixSnippet(t *testing.T) {
	if s := mailSnippet(`<html><head><style>body{margin:0;padding:0} .wrapper{width:100%}`, true); s != "" {
		t.Fatalf("cut in the style: %q", s)
	}
	if s := mailSnippet(`<html><head><title>T</title><style>p{}</style></head><body><!--[if mso]><v:x/><![endif]--><p>Hola &amp; adiós</p><p>más</p>`, true); s != "Hola & adiós más" {
		t.Fatalf("snippet = %q", s)
	}
	addr := startMemIMAP(t)
	style := "<style>" + strings.Repeat(".c{color:#333} ", 400) + "</style>"
	appendMail(t, addr, "INBOX", mimeMail("news@x", "news", "", "Content-Type: text/html; charset=utf-8\n\n<html><head>"+style+"</head><body><p>La noticia</p></body></html>"), false)
	page, err := memProvider(addr, nil).List(t.Context(), RoleInbox, "", "")
	if err != nil || len(page.Items) != 1 || strings.Contains(page.Items[0].Snippet, "{") {
		t.Fatalf("row: %v %+v", err, page.Items)
	}
}

// #26: RFC 2231 names, whole and in pieces, in any charset.
func TestMailFixPartNames(t *testing.T) {
	part := func(disp, params map[string]string) *imap.BodyStructureSinglePart {
		sp := &imap.BodyStructureSinglePart{Type: "application", Subtype: "pdf", Params: params}
		if disp != nil {
			sp.Extended = &imap.BodyStructureSinglePartExt{Disposition: &imap.BodyStructureDisposition{Value: "attachment", Params: disp}}
		}
		return sp
	}
	for want, sp := range map[string]*imap.BodyStructureSinglePart{
		"café.pdf":        part(map[string]string{"filename*": "utf-8''caf%C3%A9.pdf"}, nil),
		"María doc.pdf":   part(map[string]string{"filename*0*": "iso-8859-1''Mar%EDa", "filename*1": " doc.pdf"}, nil),
		"informe.pdf":     part(nil, map[string]string{"name*": "UTF-8'es'informe.pdf"}),
		"Factura nº7.pdf": part(map[string]string{"filename": "=?utf-8?q?Factura_n=C2=BA7.pdf?="}, nil),
	} {
		if got := mailPartName(sp); got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	}
	if n := mailDecodedSize(&imap.BodyStructureSinglePart{Encoding: "base64", Size: 78000}); n != 57000 {
		t.Errorf("base64 size = %d", n)
	}
}

// #32: Find takes only the exact Message-ID (SEARCH HEADER is a substring).
func TestMailFixFindExact(t *testing.T) {
	addr := startMemIMAP(t)
	appendMail(t, addr, "INBOX", strings.Replace(plainMail(1), "<m1@example.com>", "<12@x.com>", 1), false)
	appendMail(t, addr, "INBOX", strings.Replace(plainMail(2), "<m2@example.com>", "<412@x.com>", 1), false)
	p := memProvider(addr, nil)
	got, err := p.Find(t.Context(), "12@x.com", nil)
	if err != nil || got.MessageID != "12@x.com" {
		t.Fatalf("find = %+v %v", got, err)
	}
	if _, err := p.Find(t.Context(), "2@x.com", nil); !errors.Is(err, errMailGone) {
		t.Fatalf("a partial id was found: %v", err)
	}
}

// #43: every word must be there, anywhere; a quoted phrase is one.
func TestMailFixSearch(t *testing.T) {
	if got := mailSearchWords(`factura  "de enero" 2026`); strings.Join(got, "|") != "factura|de enero|2026" {
		t.Fatalf("words = %q", got)
	}
	addr := startMemIMAP(t)
	for i, subj := range []string{"factura de enero", "enero", "factura"} {
		appendMail(t, addr, "INBOX", strings.Replace(plainMail(i+1), "Subject: Hello "+strconv.Itoa(i+1), "Subject: "+subj, 1), false)
	}
	page, err := memProvider(addr, nil).List(t.Context(), RoleInbox, "enero factura", "")
	if err != nil || len(page.Items) != 1 || page.Items[0].Subject != "factura de enero" {
		t.Fatalf("search: %v %+v", err, page.Items)
	}
}

// #65: Scan fetches in chunks and still gets them all.
func TestMailFixScanChunks(t *testing.T) {
	old := mailScanChunk
	mailScanChunk = 5
	defer func() { mailScanChunk = old }()
	addr := startMemIMAP(t)
	for i := 1; i <= 12; i++ {
		appendMail(t, addr, "Trash", plainMail(i), true)
	}
	rows, err := memProvider(addr, nil).Scan(t.Context(), RoleTrash)
	if err != nil || len(rows) != 12 {
		t.Fatalf("scan: %d rows, %v", len(rows), err)
	}
}

// #55 #56 #58 #59 #60 #64: the small decoders.
func TestMailFixDecoders(t *testing.T) {
	// #58
	if got := string(decodeBase64([]byte("QUJD RA== RUY=\r\n"))); got != "ABCDEF" {
		t.Errorf("inner padding: %q", got)
	}
	if got := string(decodeBase64([]byte("QU!JD*"))); got != "ABC" {
		t.Errorf("junk skipped: %q", got)
	}
	// #59
	if got := mailText([]byte("caf\xe9"), "", false); got != "café" {
		t.Errorf("latin-1 with no charset: %q", got)
	}
	if got := mailText([]byte("<meta charset=\"windows-1252\"><p>ni\xf1o</p>"), "", true); !strings.Contains(got, "niño") {
		t.Errorf("meta charset: %q", got)
	}
	// #60
	flowed := "Hola que \r\ntal est\xc3\xa1s.\r\n> una cita \r\n> que sigue\r\n \r\n-- \r\nFirma"
	if got := unflowText(flowed, false); got != "Hola que tal estás.\n> una cita que sigue\n\n-- \nFirma" {
		t.Errorf("flowed: %q", got)
	}
	if got := unflowText("parte \r\nunida", true); got != "parteunida" {
		t.Errorf("delsp: %q", got)
	}
	// #56
	list, err := parseAddrs(`"Pérez; Ana" <a@x.es>; b@y.com, "Info, Empresa" <c@z.es>,`)
	if err != nil || len(list) != 3 || list[0].Name != "Pérez; Ana" || list[2].Name != "Info, Empresa" {
		t.Errorf("addresses: %+v %v", list, err)
	}
	// #64
	if parts := mailDraftParts([]mailOutFile{{Name: "a.pdf", Data: []byte("x")}}); parts[0].Type != "application/pdf" {
		t.Errorf("draft part type: %+v", parts)
	}
	// #55
	f := newMailFixture(t)
	dir := filepath.Join(f.srv.cfg.HomesDir, "ana", "data")
	os.MkdirAll(dir, 0o755)
	vcf := "BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 P=C3=A9rez de la Fuen=\r\nte\r\nEMAIL:jose@x.es\r\nEND:VCARD\r\n" +
		"BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=ISO-8859-1;QUOTED-PRINTABLE:Mar=EDa\r\nEMAIL;INTERNET:maria@x.es\r\nEND:VCARD\r\n"
	os.WriteFile(filepath.Join(dir, "contacts.vcf"), []byte(vcf), 0o644)
	names := map[string]string{}
	for _, c := range f.srv.mail.Contacts("ana") {
		names[c.Email] = c.Name
	}
	if names["jose@x.es"] != "José Pérez de la Fuente" || names["maria@x.es"] != "María" {
		t.Errorf("contacts = %v", names)
	}
}
