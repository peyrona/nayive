package main

// =============================================================================
// TestMailE2EServe - not a check by itself: it serves a whole Nayive (the real
// client/apps) with one mail account on an in-memory IMAP server, for the
// browser checks of tools/email-test/run.mjs. Skipped unless NAYIVE_MAIL_E2E
// names the address to listen on ("127.0.0.1:PORT"). It stops when the file
// named by NAYIVE_MAIL_E2E_STOP appears (or after 15 minutes).
//
// Besides Nayive's own routes it answers a few of its own, for the driver:
//
//	/e2e/hit/<name>      a "picture" a test mail points at: records whether
//	                     the request carried the session cookie
//	/e2e/hits            those records
//	/e2e/sent            the mails "sent" (the SMTP is a fake)
//	/e2e/draft?fail=1    the next draft saves fail (0: they work again)
//	/e2e/draft?slow=MS   draft saves wait MS first
// =============================================================================

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
)

type e2eState struct {
	mu        sync.Mutex
	hits      []map[string]any
	sent      []sentMail
	draftFail bool
	draftSlow time.Duration
}

type e2eProvider struct {
	*imapProvider
	st *e2eState
}

func (p e2eProvider) SaveDraft(ctx context.Context, raw []byte, mid string, old *MailRef) (MailRef, []MailPart, error) {
	p.st.mu.Lock()
	fail, slow := p.st.draftFail, p.st.draftSlow
	p.st.mu.Unlock()
	if slow > 0 {
		time.Sleep(slow)
	}
	if fail {
		return MailRef{}, nil, errors.New("e2e: drafts fail now")
	}
	return p.imapProvider.SaveDraft(ctx, raw, mid, old)
}

func TestMailE2EServe(t *testing.T) {
	addr := os.Getenv("NAYIVE_MAIL_E2E")
	if addr == "" {
		t.Skip("set NAYIVE_MAIL_E2E=127.0.0.1:PORT (tools/email-test/run.mjs does)")
	}
	stop := os.Getenv("NAYIVE_MAIL_E2E_STOP")
	apps, _ := filepath.Abs("../../client/apps")

	imapAddr := startMemIMAP(t, imap.CapMove, imap.CapUIDPlus)
	c, err := dialMemIMAP(imapAddr)(MailAccount{User: mailTestUser, Pass: mailTestPass})
	if err != nil {
		t.Fatal(err)
	}
	c.Create("Drafts", nil).Wait()
	c.Close()

	// the run-root: config, and the user "ana" (password "abc")
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "config"), 0o755)
	home := filepath.Join(root, "homes", "ana")
	os.MkdirAll(filepath.Join(home, "data"), 0o755)
	os.MkdirAll(filepath.Join(home, "files", "Docs"), 0o755)
	os.WriteFile(filepath.Join(home, "data", "config.json"), []byte(`{"password":"abc"}`), 0o644)
	os.WriteFile(filepath.Join(home, "files", "Docs", "nota.txt"), []byte("una nota\n"), 0o644)
	cfgRaw, _ := json.Marshal(map[string]any{"host": "127.0.0.1", "port": 0, "base_dir": ".", "apps_dir": apps,
		"admin": map[string]string{"name": "jefe", "password": "secreto"}})
	cfgPath := filepath.Join(root, "config", "server.json")
	os.WriteFile(cfgPath, cfgRaw, 0o644)
	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	srv, err := NewServer(cfg, quietLog())
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	st := &e2eState{}
	srv.mail.newProvider = func(a MailAccount) MailProvider {
		p := newIMAPProvider(a)
		p.dial = dialMemIMAP(imapAddr)
		p.smtpCheck = noSMTPCheck
		p.smtp = func(_ context.Context, _ MailAccount, from string, rcpts []string, raw []byte) error {
			st.mu.Lock()
			defer st.mu.Unlock()
			st.sent = append(st.sent, sentMail{from, rcpts, string(raw)})
			return nil
		}
		return e2eProvider{p, st}
	}

	// the mail: plain ones, one with a file, and an HTML one that tries
	// every way back to Nayive's own URLs
	for i := 1; i <= 8; i++ {
		appendMail(t, imapAddr, "INBOX", plainMail(i), i > 2)
	}
	pdf := base64.StdEncoding.EncodeToString(mailTestPDF)
	appendMail(t, imapAddr, "INBOX", "From: Bob <bob@example.com>\nTo: ana@example.com\nSubject: With a file\n"+
		"Date: Tue, 02 Sep 2026 08:00:00 +0000\nMessage-ID: <file@example.com>\nMIME-Version: 1.0\n"+
		"Content-Type: multipart/mixed; boundary=\"B\"\n\n--B\nContent-Type: text/plain\n\nSee the file.\n"+
		"--B\nContent-Type: application/pdf; name=\"informe.pdf\"\nContent-Disposition: attachment; filename=\"informe.pdf\"\n"+
		"Content-Transfer-Encoding: base64\n\n"+pdf+"\n--B--\n", true)
	png := base64.StdEncoding.EncodeToString(e2ePNG)
	base := "http://" + addr
	appendMail(t, imapAddr, "INBOX", "From: Eve <eve@example.com>\nTo: ana@example.com\nSubject: Pictures\n"+
		"Date: Tue, 02 Sep 2026 09:00:00 +0000\nMessage-ID: <pics@example.com>\nMIME-Version: 1.0\n"+
		"Content-Type: multipart/related; boundary=\"R\"\n\n--R\nContent-Type: text/html; charset=utf-8\n\n"+
		`<p>Hola <b>Ana</b></p><img id="own" src="cid:logo@x" width="40" height="40">`+
		`<div id="bg" style="width:20px;height:20px;background:url(cid:logo@x)">c</div>`+
		`<div style="width:10px;height:10px;background:u\72l(/e2e/hit/css-escape)">a</div>`+
		`<div style="width:10px;height:10px;background-image:image-set('/e2e/hit/image-set' 1x)">b</div>`+
		`<style>@\69mport "/e2e/hit/import";</style>`+
		`<img src="`+base+`/e2e/hit/absolute">`+
		`<img src="https://images.example.invalid/remote.png">`+
		`<p><a id="out" href="https://example.org/">a link</a></p>`+
		strings.Repeat("<p>line</p>", 60)+"\n"+
		"--R\nContent-Type: image/png\nContent-ID: <logo@x>\nContent-Transfer-Encoding: base64\n\n"+png+"\n--R--\n", false)

	mux := http.NewServeMux()
	mux.HandleFunc("/e2e/hit/", func(w http.ResponseWriter, r *http.Request) {
		_, err := r.Cookie(CookieName)
		st.mu.Lock()
		st.hits = append(st.hits, map[string]any{"path": r.URL.Path, "cookie": err == nil})
		st.mu.Unlock()
		w.Header().Set("Content-Type", "image/png")
		w.Write(e2ePNG)
	})
	mux.HandleFunc("/e2e/hits", func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		defer st.mu.Unlock()
		json.NewEncoder(w).Encode(st.hits)
	})
	mux.HandleFunc("/e2e/sent", func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		defer st.mu.Unlock()
		var out []map[string]any
		for _, m := range st.sent {
			out = append(out, map[string]any{"from": m.from, "rcpts": m.rcpts, "raw": m.raw})
		}
		json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("/e2e/draft", func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		defer st.mu.Unlock()
		if v := r.URL.Query().Get("fail"); v != "" {
			st.draftFail = v == "1"
		}
		if v := r.URL.Query().Get("slow"); v != "" {
			ms, _ := strconv.Atoi(v)
			st.draftSlow = time.Duration(ms) * time.Millisecond
		}
		w.Write([]byte("ok"))
	})
	mux.Handle("/", srv.routes())

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	hs := &http.Server{Handler: mux}
	go hs.Serve(ln)
	defer hs.Close()

	// the account, through the API as the app adds it
	host, port, _ := net.SplitHostPort(imapAddr)
	p, _ := strconv.Atoi(port)
	if _, err := srv.mail.Add(context.Background(), "ana", MailAccount{Email: mailTestUser, Pass: mailTestPass, IMAPHost: host, IMAPPort: p}); err != nil {
		t.Fatal(err)
	}
	t.Log("READY")
	os.Stdout.WriteString("E2E READY\n")

	end := time.Now().Add(15 * time.Minute)
	for time.Now().Before(end) {
		if stop != "" {
			if _, err := os.Stat(stop); err == nil {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// a 1x1 red PNG
var e2ePNG, _ = base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==")
