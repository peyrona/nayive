package main

// =============================================================================
// The SSH tab's terminal: one SSH session to THIS server, carried over HTTP.
// =============================================================================
//
// The browser cannot speak SSH, so Nayive does: it logs in to sshd on
// 127.0.0.1 (the port sshd_config names) with the username and password the
// admin types, asks for a pty and a shell, and relays the bytes.
//
// THE CARRIAGE is the one the rest of Nayive uses - plain requests, no
// WebSocket: a long-poll GET for what the shell prints (it waits up to 25 s
// for news, and asks "from byte N" so a lost answer loses nothing), a POST per
// burst of keys, a POST on resize. It works through HTTP/2 and needs no CSP
// change.
//
// THE RULES, enforced here and not only in the page:
//   - admin only, and a ticket (a passkey or an app code, confirm_passkey.go)
//     spent on each open;
//   - one session at all: a new one ends the old;
//   - bound to the Nayive session that opened it; signing out ends it;
//   - ends after 15 minutes with no key, after 2 hours in any case;
//   - the host key must be one of /etc/ssh/ssh_host_*_key.pub - a program
//     listening on that port in sshd's place gets no password.
// Nothing is logged: not the opening, not a byte.

import (
	"bufio"
	"errors"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	sshIdle     = 15 * time.Minute
	sshMaxLife  = 2 * time.Hour
	sshWait     = 25 * time.Second // a read waits this long for output
	sshKeepOut  = 512 << 10        // output kept for a slow reader
	sshMaxWrite = 64 << 10         // keys (or a paste) per POST
)

type sshHostKey = ssh.PublicKey

// SSHHub is the SSH tab: its "confirm it is you" part (a Confirmer, with
// prefix "ssh": config/ssh-passkeys.json, ssh-totp.json, ssh-setup-code.txt;
// confirm_passkey.go, confirm_totp.go) and the one open terminal. The terminal
// shares the Confirmer's lock and its wrong tries.
type SSHHub struct {
	*Confirmer

	term *sshTerm // the one open session, or nil

	// Seams for the tests.
	dialAddr func() string                // "127.0.0.1:<port from sshd_config>"
	hostKeys func() ([]sshHostKey, error) // /etc/ssh/ssh_host_*_key.pub
	alive    func(token string) bool      // the Nayive admin session still exists
	accounts func() sshAccounts           // this server's login accounts (/etc/passwd)
}

func NewSSHHub(configDir string) *SSHHub {
	return &SSHHub{
		Confirmer: NewConfirmer(configDir, "ssh", "Nayive SSH"),
		dialAddr:  sshLocalAddr,
		hostKeys:  sshLocalHostKeys,
		alive:     func(string) bool { return true },
		accounts:  sshLocalAccounts,
	}
}

// sshTerm is the one open session.
type sshTerm struct {
	id      string
	token   string // the Nayive session that opened it
	user    string
	client  *ssh.Client
	sess    *ssh.Session
	stdin   interface{ Write([]byte) (int, error) }
	started time.Time

	mu     sync.Mutex
	out    []byte
	base   int64         // the offset of out[0] in everything printed
	wake   chan struct{} // closed when there is news
	ended  string        // why it ended; "" while alive
	lastIn time.Time
}

// Write is where the shell's output lands (stdout and stderr both).
func (t *sshTerm) Write(p []byte) (int, error) {
	t.mu.Lock()
	t.out = append(t.out, p...)
	if over := len(t.out) - sshKeepOut; over > 0 {
		t.out = append([]byte(nil), t.out[over:]...)
		t.base += int64(over)
	}
	t.news()
	t.mu.Unlock()
	return len(p), nil
}

// news wakes the waiting reader. Caller holds t.mu.
func (t *sshTerm) news() {
	close(t.wake)
	t.wake = make(chan struct{})
}

// end closes the session once, with a reason the page shows.
func (t *sshTerm) end(reason string) {
	t.mu.Lock()
	if t.ended != "" {
		t.mu.Unlock()
		return
	}
	t.ended = reason
	t.news()
	t.mu.Unlock()
	t.sess.Close()
	t.client.Close()
}

// sshRead is one answer to the long-poll.
type sshRead struct {
	Next  int64  `json:"next"`
	Data  []byte `json:"data"` // base64 in JSON: bytes, not text (a UTF-8 character may be split)
	Ended string `json:"ended,omitempty"`
}

// read answers what was printed from byte `from` on, waiting for news if
// there is none yet. `stop` ends the wait early (the client left).
func (t *sshTerm) read(from int64, stop <-chan struct{}) sshRead {
	deadline := time.NewTimer(sshWait)
	defer deadline.Stop()
	for {
		t.mu.Lock()
		end := t.base + int64(len(t.out))
		if from < t.base {
			from = t.base // fell behind: the oldest output is gone
		}
		if from < end || t.ended != "" || from > end {
			var r sshRead
			if from <= end {
				r.Data = append([]byte(nil), t.out[from-t.base:]...)
			}
			r.Next, r.Ended = end, t.ended
			t.mu.Unlock()
			return r
		}
		wake := t.wake
		t.mu.Unlock()
		select {
		case <-wake:
		case <-deadline.C:
			return sshRead{Next: end}
		case <-stop:
			return sshRead{Next: end}
		}
	}
}

// -- opening -------------------------------------------------------------------

var (
	errSSHLogin   = errors.New("The server refused this password. Type the Linux password of that account on Nayive's server (the one sudo asks for), not your Nayive password.")
	errSSHNoPass  = errors.New("The SSH of Nayive's server does not take passwords. See the help (i).")
	errSSHNoReach = errors.New("Can't reach SSH on Nayive's server.")
)

// Open logs in to the local sshd and starts a shell. It ends any session
// already open. The caller has spent a ticket.
func (h *SSHHub) Open(token, user, password string, cols, rows int) (*sshTerm, error) {
	h.mu.Lock()
	shut := h.lockErr()
	h.mu.Unlock()
	if shut != nil {
		return nil, shut
	}
	if user == "" || strings.ContainsAny(user, " \t\r\n@:/") || len(user) > 64 {
		return nil, errors.New("Type a valid username.")
	}
	known, err := h.hostKeys()
	if err != nil || len(known) == 0 {
		return nil, errors.New("Can't read the SSH host keys of Nayive's server.")
	}
	answer := func(_, _ string, questions []string, echos []bool) ([]string, error) {
		// PAM's "Password:" prompt. Anything else (a code, two questions) we
		// cannot answer.
		if len(questions) == 0 {
			return nil, nil
		}
		if len(questions) != 1 || echos[0] {
			return nil, errors.New("unexpected question")
		}
		return []string{password}, nil
	}
	cfg := &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{ssh.Password(password), ssh.KeyboardInteractive(answer)},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			for _, k := range known {
				if k.Type() == key.Type() && string(k.Marshal()) == string(key.Marshal()) {
					return nil
				}
			}
			return errors.New("unknown host key")
		},
		Timeout: 10 * time.Second,
	}
	client, err := ssh.Dial("tcp", h.dialAddr(), cfg)
	if err != nil {
		msg := err.Error()
		switch {
		case strings.Contains(msg, "unable to authenticate") && strings.Contains(msg, "attempted methods [none]"):
			return nil, errSSHNoPass
		case strings.Contains(msg, "unable to authenticate"):
			h.failed()
			if !h.isAccount(user) {
				return nil, errors.New(`There is no account "` + user + `" on Nayive's server. Pick one from the list.`)
			}
			return nil, errSSHLogin
		case strings.Contains(msg, "unknown host key"):
			return nil, errors.New("The SSH server's key is not the key of Nayive's server: refused.")
		}
		return nil, errSSHNoReach
	}
	sess, err := client.NewSession()
	if err != nil {
		client.Close()
		return nil, errors.New("SSH refused a session.")
	}
	t := &sshTerm{
		id: b64u(randomBytes(18)), token: token, user: user,
		client: client, sess: sess, started: time.Now(), lastIn: time.Now(),
		wake: make(chan struct{}),
	}
	sess.Stdout, sess.Stderr = t, t
	stdin, err := sess.StdinPipe()
	if err == nil {
		t.stdin = stdin
		err = sess.RequestPty("xterm-256color", clampDim(rows, 24), clampDim(cols, 80),
			ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 38400, ssh.TTY_OP_OSPEED: 38400})
	}
	if err == nil {
		err = sess.Shell()
	}
	if err != nil {
		sess.Close()
		client.Close()
		return nil, errors.New("SSH refused a terminal.")
	}

	h.mu.Lock()
	old := h.term
	h.term = t
	h.mu.Unlock()
	if old != nil {
		old.end("Closed: a new session was opened.")
	}
	go func() {
		sess.Wait()
		t.end("Session closed.")
	}()
	go h.watch(t)
	return t, nil
}

func clampDim(n, def int) int {
	if n < 2 || n > 1000 {
		return def
	}
	return n
}

// watch ends the session on the limits, and when the Nayive session is gone.
func (h *SSHHub) watch(t *sshTerm) {
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for range tick.C {
		if h.checkLimits(t, time.Now()) {
			return
		}
	}
}

// checkLimits ends the session if a limit is passed; true once it is over.
func (h *SSHHub) checkLimits(t *sshTerm, now time.Time) bool {
	t.mu.Lock()
	ended, idle := t.ended != "", now.Sub(t.lastIn)
	t.mu.Unlock()
	switch {
	case ended:
	case idle >= sshIdle:
		t.end("Closed after 15 minutes with no key pressed.")
	case now.Sub(t.started) >= sshMaxLife:
		t.end("Closed: a session lasts 2 hours at most.")
	case !h.alive(t.token):
		t.end("Closed: you signed out.")
	default:
		return false
	}
	h.mu.Lock()
	if h.term == t {
		h.term = nil
	}
	h.mu.Unlock()
	return true
}

// find answers the open session with that id, if the asking Nayive session
// is the one that opened it.
func (h *SSHHub) find(token, id string) *sshTerm {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.term
	if t == nil || t.id != id || t.token != token {
		return nil
	}
	return t
}

// Send types keys into the shell.
func (t *sshTerm) send(data string) error {
	t.mu.Lock()
	ended := t.ended
	t.lastIn = time.Now()
	t.mu.Unlock()
	if ended != "" {
		return errors.New(ended)
	}
	_, err := t.stdin.Write([]byte(data))
	return err
}

// CloseAll ends the open session (shutdown).
func (h *SSHHub) CloseAll() {
	h.mu.Lock()
	t := h.term
	h.term = nil
	h.mu.Unlock()
	if t != nil {
		t.end("Closed: the server is restarting.")
	}
}

// CloseFor ends the session a Nayive session opened (sign-out).
func (h *SSHHub) CloseFor(token string) {
	h.mu.Lock()
	t := h.term
	if t != nil && t.token == token {
		h.term = nil
	} else {
		t = nil
	}
	h.mu.Unlock()
	if t != nil {
		t.end("Closed: you signed out.")
	}
}

// -- this server's accounts --------------------------------------------------------

// sshAccounts helps him pick the right login: the accounts of this computer
// that can log in, the one Nayive runs as, and the computer's name.
type sshAccounts struct {
	Accounts []string `json:"accounts"`
	RunsAs   string   `json:"runs_as,omitempty"`
	Host     string   `json:"host,omitempty"`
}

var sshPasswdFile = "/etc/passwd"

// sshLocalAccounts reads /etc/passwd: people's accounts (uid 1000 and up)
// with a real shell. The one Nayive runs as comes first.
func sshLocalAccounts() sshAccounts {
	var out sshAccounts
	if u, err := user.Current(); err == nil {
		out.RunsAs = u.Username
	}
	out.Host, _ = os.Hostname()
	f, err := os.Open(sshPasswdFile)
	if err != nil {
		return out
	}
	defer f.Close()
	var rest []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		p := strings.Split(sc.Text(), ":")
		if len(p) < 7 {
			continue
		}
		uid, err := strconv.Atoi(p[2])
		shell := p[6]
		if err != nil || uid < 1000 || uid >= 65534 || shell == "" ||
			strings.HasSuffix(shell, "nologin") || strings.HasSuffix(shell, "/false") || strings.HasSuffix(shell, "/sync") {
			continue
		}
		if p[0] == out.RunsAs {
			out.Accounts = append([]string{p[0]}, out.Accounts...)
		} else {
			rest = append(rest, p[0])
		}
	}
	out.Accounts = append(out.Accounts, rest...)
	return out
}

// isAccount: the name is an account here (the list, or the system's own
// lookup, which also knows network accounts).
func (h *SSHHub) isAccount(name string) bool {
	for _, a := range h.accounts().Accounts {
		if a == name {
			return true
		}
	}
	_, err := user.Lookup(name)
	return err == nil
}

// -- this server's sshd ----------------------------------------------------------

// sshLocalAddr is 127.0.0.1 and the first Port line of sshd_config (or of a
// readable file it includes from sshd_config.d); 22 when none says.
func sshLocalAddr() string {
	files := []string{"/etc/ssh/sshd_config"}
	more, _ := filepath.Glob("/etc/ssh/sshd_config.d/*.conf")
	files = append(files, more...)
	for _, f := range files {
		if p := sshdPort(f); p != "" {
			return "127.0.0.1:" + p
		}
	}
	return "127.0.0.1:22"
}

// sshdPort finds the first global "Port N" line of one file.
func sshdPort(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		switch strings.ToLower(fields[0]) {
		case "match":
			return "" // what follows is not global
		case "port":
			if n, err := strconv.Atoi(fields[1]); err == nil && n > 0 && n < 65536 {
				return fields[1]
			}
		}
	}
	return ""
}

// sshLocalHostKeys reads this machine's SSH host keys (world-readable).
func sshLocalHostKeys() ([]sshHostKey, error) {
	files, _ := filepath.Glob("/etc/ssh/ssh_host_*_key.pub")
	var keys []sshHostKey
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		if k, _, _, _, err := ssh.ParseAuthorizedKey(data); err == nil {
			keys = append(keys, k)
		}
	}
	return keys, nil
}
