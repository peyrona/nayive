package main

// =============================================================================
// "Confirm it is you" - the second factor in front of a risky action.
// =============================================================================
//
// A Confirmer keeps the ways one person proves it is them, beyond the Nayive
// password: PASSKEYS (Face ID, a fingerprint, a PIN, or a phone through the
// browser's QR code) and ONE AUTHENTICATOR APP (a 6-digit code that changes
// every 30 s; confirm_totp.go). A confirmed one gives a TICKET.
//
// It is made for re-use: each user of it has its own file prefix and label
// (NewConfirmer(configDir, "ssh", "Nayive SSH") -> config/ssh-passkeys.json,
// ssh-totp.json, ssh-setup-code.txt). Today only the Admin panel's SSH tab
// uses it (SSHHub embeds one; ssh_term.go, client/apps/ssh/ssh-tab.js).
//
// WebAuthn without a library: the browser already hands over the public key as
// SPKI (response.getPublicKey()) and the authenticator data as bytes, so the
// standard library is enough - no CBOR, no attestation (attestation "none": we
// trust the browser, as every passkey site does).
//
// ADDING A WAY TO CONFIRM, the part an attacker would aim at:
//   - the FIRST one (no passkey and no app yet) needs a one-time SETUP CODE
//     that the server writes to a 0600 file in the config folder. Reading it
//     needs a real shell on the server, so a stolen Nayive admin password alone
//     cannot enrol a phone;
//   - every later one needs a ticket (a passkey or an app code confirmed).
// Lost them all? Delete config/<prefix>-passkeys.json AND <prefix>-totp.json
// over a real SSH login.
//
// TICKETS: a confirmed passkey or code gives a ticket, bound to the Nayive
// session, valid a few minutes and good for ONE action (for SSH: open the
// terminal, add a way, or remove one).
//
// WRONG TRIES of every kind (passkey, app code, setup code, SSH password)
// count together: 5 in 15 minutes, or 10 in 24 hours, lock the door until
// the window passes.
//
// Nothing here is logged (his rule: no "SSH opened" lines or alerts).

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	confirmChallengeTTL = 3 * time.Minute  // begin -> the browser's answer
	confirmTicketTTL    = 5 * time.Minute  // passkey confirmed -> the action it allows
	confirmSetupTTL     = 15 * time.Minute // the setup code's life
	confirmFailWindow   = 15 * time.Minute // wrong tries counted over this window...
	confirmFailMax      = 5                // ...and this many lock the door until it passes
	confirmFailDay      = 24 * time.Hour   // and over a day...
	confirmFailDayMax   = 10               // ...this many: slow, patient guessing stops too

	// The files, each "<prefix>-<name>" in the config folder.
	confirmKeysFile  = "passkeys.json"
	confirmSetupFile = "setup-code.txt"
	confirmTOTPFile  = "totp.json" // confirm_totp.go
)

// COSE algorithm numbers the browser reports (getPublicKeyAlgorithm).
const (
	coseES256 = -7
	coseEdDSA = -8
	coseRS256 = -257
)

// passkeyRec is one registered passkey, as stored in config/<prefix>-passkeys.json.
type passkeyRec struct {
	ID         string   `json:"id"`  // the credential id, base64url
	Key        string   `json:"key"` // the public key, SPKI DER, base64url
	Alg        int      `json:"alg"`
	RPID       string   `json:"rp_id"` // the host name it was made for
	Name       string   `json:"name"`
	Transports []string `json:"transports,omitempty"`
	Count      uint32   `json:"count"`
	Added      string   `json:"added"`
	Used       string   `json:"used,omitempty"`
}

// confirmPending is a challenge or a ticket: a random value, bound to one Nayive
// session, with an end.
type confirmPending struct {
	value   []byte
	kind    string // challenge: "get" or "create"; ticket: "ticket"
	expires time.Time
}

// Confirmer holds the passkeys and the app, the pending challenges and
// tickets, the setup code and the wrong tries.
type Confirmer struct {
	mu         sync.Mutex
	configDir  string
	prefix     string                    // file names: "<prefix>-passkeys.json"...
	label      string                    // what the authenticator app shows: "Nayive SSH"
	challenges map[string]confirmPending // by session token
	tickets    map[string]confirmPending // by session token
	totpNew    map[string]totpPending    // an app being added, by session token (confirm_totp.go)
	setupCode  string
	setupEnds  time.Time
	fails      []time.Time

	now func() time.Time // a seam for the tests
}

func NewConfirmer(configDir, prefix, label string) *Confirmer {
	return &Confirmer{
		configDir:  configDir,
		prefix:     prefix,
		label:      label,
		challenges: map[string]confirmPending{},
		tickets:    map[string]confirmPending{},
		totpNew:    map[string]totpPending{},
		now:        time.Now,
	}
}

// path is one of the Confirmer's files in the config folder.
func (h *Confirmer) path(name string) string {
	return filepath.Join(h.configDir, h.prefix+"-"+name)
}

// hasFactor: a passkey or an app exists. While none does, the setup code is
// the only way in. Caller holds h.mu.
func (h *Confirmer) hasFactor() (bool, error) {
	keys, err := h.loadKeys()
	if err != nil {
		return false, err
	}
	app, err := h.loadTOTP()
	if err != nil {
		return false, err
	}
	return len(keys) > 0 || app != nil, nil
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on a working OS
	}
	return b
}

// -- wrong tries ---------------------------------------------------------------

// lockErr says whether the door is shut, and why: 5 wrong tries in 15
// minutes, or 10 in a day (a 6-digit code guessed 5 times every 15 minutes
// would fall in about two years; 10 a day makes that some 90). The caller
// holds h.mu.
func (h *Confirmer) lockErr() error {
	now := h.now()
	keep := h.fails[:0]
	recent := 0
	for _, t := range h.fails {
		if t.After(now.Add(-confirmFailDay)) {
			keep = append(keep, t)
			if t.After(now.Add(-confirmFailWindow)) {
				recent++
			}
		}
	}
	h.fails = keep
	switch {
	case recent >= confirmFailMax:
		return errTooManyTries
	case len(h.fails) >= confirmFailDayMax:
		return errTooManyToday
	}
	return nil
}

// tooManyFails reports whether the door is shut. The caller holds h.mu.
func (h *Confirmer) tooManyFails() bool { return h.lockErr() != nil }

func (h *Confirmer) failed() {
	h.mu.Lock()
	h.fails = append(h.fails, h.now())
	h.mu.Unlock()
}

var (
	errTooManyTries = errors.New("Too many wrong tries. Wait 15 minutes.")
	errTooManyToday = errors.New("Too many wrong tries today. Wait up to 24 hours.")
	errConfirmFirst = errors.New("Confirm it is you first (a passkey or your app's code).")
	errSetupCode    = errors.New("Wrong or old setup code.")
)

// -- the stored passkeys -------------------------------------------------------

func (h *Confirmer) keysPath() string { return h.path(confirmKeysFile) }

// loadKeys reads the list; a missing file is an empty list. Caller holds h.mu.
func (h *Confirmer) loadKeys() ([]passkeyRec, error) {
	data, err := os.ReadFile(h.keysPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var keys []passkeyRec
	if err := json.Unmarshal(data, &keys); err != nil {
		return nil, err
	}
	return keys, nil
}

// saveKeys writes the list, 0600 (it is config, not user data). Caller holds h.mu.
func (h *Confirmer) saveKeys(keys []passkeyRec) error {
	if keys == nil {
		keys = []passkeyRec{}
	}
	data, err := json.MarshalIndent(keys, "", "    ")
	if err != nil {
		return err
	}
	return atomicWriteFile(h.keysPath(), append(data, '\n'), 0o600)
}

// factorInfo is what the panel lists - no key material, no secret.
type factorInfo struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"` // "passkey" or "app"
	Name  string `json:"name"`
	Added string `json:"added"`
	Used  string `json:"used,omitempty"`
}

// ListKeys lists the passkeys and the app, in one list.
func (h *Confirmer) ListKeys() ([]factorInfo, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	keys, err := h.loadKeys()
	if err != nil {
		return nil, err
	}
	app, err := h.loadTOTP()
	if err != nil {
		return nil, err
	}
	out := make([]factorInfo, 0, len(keys)+1)
	for _, k := range keys {
		out = append(out, factorInfo{ID: k.ID, Kind: "passkey", Name: k.Name, Added: k.Added, Used: k.Used})
	}
	if app != nil {
		out = append(out, factorInfo{ID: totpListID, Kind: "app", Name: app.Name, Added: app.Added, Used: app.Used})
	}
	return out, nil
}

// confirmStatus says which ways to confirm can be used at this address, so
// the page offers them before it asks for anything.
type confirmStatus struct {
	None     bool   `json:"none"`           // nothing yet: the setup code first
	Passkeys int    `json:"passkeys"`       // passkeys made for this address
	Others   int    `json:"others"`         // passkeys made for another address (unusable here)
	App      bool   `json:"app"`            // an authenticator app
	Locked   bool   `json:"locked"`         // too many wrong tries just now...
	Lock     string `json:"lock,omitempty"` // ...and how long to wait
}

func (h *Confirmer) Status(rpID string) (confirmStatus, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	keys, err := h.loadKeys()
	if err != nil {
		return confirmStatus{}, err
	}
	app, err := h.loadTOTP()
	if err != nil {
		return confirmStatus{}, err
	}
	var st confirmStatus
	for _, k := range keys {
		if k.RPID == rpID {
			st.Passkeys++
		} else {
			st.Others++
		}
	}
	st.App = app != nil
	st.None = len(keys) == 0 && app == nil
	if err := h.lockErr(); err != nil {
		st.Locked, st.Lock = true, err.Error()
	}
	return st, nil
}

// -- tickets -------------------------------------------------------------------

// newTicket is given after a confirmed passkey or app code. One per session; a new one
// replaces the old. Caller holds h.mu.
func (h *Confirmer) newTicket(token string) string {
	v := randomBytes(32)
	h.tickets[token] = confirmPending{value: v, kind: "ticket", expires: h.now().Add(confirmTicketTTL)}
	return b64u(v)
}

// ticketOK checks a ticket without spending it. Caller holds h.mu.
func (h *Confirmer) ticketOK(token, ticket string) bool {
	t, ok := h.tickets[token]
	if !ok || h.now().After(t.expires) {
		delete(h.tickets, token)
		return false
	}
	got, err := b64uDec(ticket)
	return err == nil && subtle.ConstantTimeCompare(got, t.value) == 1
}

// SpendTicket checks a ticket and uses it up.
func (h *Confirmer) SpendTicket(token, ticket string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	ok := h.ticketOK(token, ticket)
	delete(h.tickets, token) // a wrong ticket burns the right one too
	return ok
}

// -- the setup code ------------------------------------------------------------

func (h *Confirmer) setupPath() string { return h.path(confirmSetupFile) }

// MakeSetupCode writes a new one-time code to config/<prefix>-setup-code.txt
// and answers that file's path. Only while no passkey and no app exist.
func (h *Confirmer) MakeSetupCode() (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	has, err := h.hasFactor()
	if err != nil {
		return "", err
	}
	if has {
		return "", errors.New("A way to confirm exists already: add more with it.")
	}
	if err := h.lockErr(); err != nil {
		return "", err
	}
	// 12 letters/digits with no look-alikes (0/O, 1/I/L), shown as 3 groups of 4.
	const abc = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
	raw := randomBytes(12)
	var b strings.Builder
	for i, c := range raw {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		b.WriteByte(abc[int(c)%len(abc)])
	}
	code := b.String()
	if err := atomicWriteFile(h.setupPath(), []byte(code+"\n"), 0o600); err != nil {
		return "", err
	}
	h.setupCode, h.setupEnds = code, h.now().Add(confirmSetupTTL)
	return h.setupPath(), nil
}

// setupOK checks a typed setup code. Caller holds h.mu. A wrong one counts as
// a wrong try; the code dies with the 5th.
func (h *Confirmer) setupOK(typed string) bool {
	if h.setupCode == "" || h.now().After(h.setupEnds) {
		h.dropSetup()
		return false
	}
	norm := func(s string) string {
		return strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(s)))
	}
	if subtle.ConstantTimeCompare([]byte(norm(typed)), []byte(norm(h.setupCode))) == 1 {
		return true
	}
	h.fails = append(h.fails, h.now())
	if h.tooManyFails() {
		h.dropSetup()
	}
	return false
}

// dropSetup forgets the code and removes its file. Caller holds h.mu.
func (h *Confirmer) dropSetup() {
	h.setupCode = ""
	os.Remove(h.setupPath())
}

// -- begin: the challenge ------------------------------------------------------

// passkeyBegin is what the browser needs to call navigator.credentials.get/create.
type passkeyBegin struct {
	None      bool           `json:"none,omitempty"` // no passkey and no app yet: the setup step
	Challenge string         `json:"challenge,omitempty"`
	RPID      string         `json:"rp_id,omitempty"`
	Allow     []passkeyAllow `json:"allow,omitempty"`   // get: the registered keys
	Exclude   []string       `json:"exclude,omitempty"` // create: do not make a second one on the same device
	UserID    string         `json:"user_id,omitempty"` // create
}

type passkeyAllow struct {
	ID         string   `json:"id"`
	Transports []string `json:"transports,omitempty"`
}

// Begin hands out a challenge. "get": confirm a passkey. "create": add one,
// which needs the setup code (no way to confirm yet) or a ticket (there is one).
func (h *Confirmer) Begin(token, mode, rpID, admin, code, ticket string) (passkeyBegin, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.lockErr(); err != nil {
		return passkeyBegin{}, err
	}
	keys, err := h.loadKeys()
	if err != nil {
		return passkeyBegin{}, err
	}
	has, err := h.hasFactor()
	if err != nil {
		return passkeyBegin{}, err
	}
	var out passkeyBegin
	switch mode {
	case "get":
		if !has {
			return passkeyBegin{None: true}, nil
		}
		for _, k := range keys {
			if k.RPID == rpID {
				out.Allow = append(out.Allow, passkeyAllow{ID: k.ID, Transports: k.Transports})
			}
		}
		if len(out.Allow) == 0 {
			return passkeyBegin{}, errors.New("No passkey was made for this address (" + rpID + "). Open Nayive at the address you used to add it.")
		}
	case "create":
		if !has {
			if !h.setupOK(code) {
				return passkeyBegin{}, errSetupCode
			}
		} else if !h.ticketOK(token, ticket) {
			return passkeyBegin{}, errConfirmFirst
		}
		for _, k := range keys {
			out.Exclude = append(out.Exclude, k.ID)
		}
		sum := sha256.Sum256([]byte("nayive-" + h.prefix + ":" + admin))
		out.UserID = b64u(sum[:16])
	default:
		return passkeyBegin{}, errors.New("unknown mode")
	}
	v := randomBytes(32)
	h.challenges[token] = confirmPending{value: v, kind: mode, expires: h.now().Add(confirmChallengeTTL)}
	out.Challenge = b64u(v)
	out.RPID = rpID
	return out, nil
}

// takeChallenge returns the session's challenge of that kind and forgets it:
// each one is good for one answer. Caller holds h.mu.
func (h *Confirmer) takeChallenge(token, kind string) ([]byte, bool) {
	c, ok := h.challenges[token]
	delete(h.challenges, token)
	if !ok || c.kind != kind || h.now().After(c.expires) {
		return nil, false
	}
	return c.value, true
}

// -- the checks every answer goes through --------------------------------------

type webauthnClientData struct {
	Type        string `json:"type"`
	Challenge   string `json:"challenge"`
	Origin      string `json:"origin"`
	CrossOrigin bool   `json:"crossOrigin"`
}

// checkClientData: the right ceremony, our challenge, our page.
func checkClientData(raw []byte, typ string, challenge []byte, origin string) error {
	var cd webauthnClientData
	if err := json.Unmarshal(raw, &cd); err != nil {
		return errors.New("bad client data")
	}
	if cd.Type != typ {
		return errors.New("wrong ceremony")
	}
	got, err := b64uDec(cd.Challenge)
	if err != nil || subtle.ConstantTimeCompare(got, challenge) != 1 {
		return errors.New("wrong challenge")
	}
	if cd.Origin != origin || cd.CrossOrigin {
		return errors.New("wrong origin")
	}
	return nil
}

// Authenticator data flags.
const (
	adUP = 0x01 // user present (touched)
	adUV = 0x04 // user verified (fingerprint, face, PIN)
	adAT = 0x40 // attested credential data follows (create only)
)

// checkAuthData: made for this host, touched AND verified. Answers the flags
// and the signature counter.
func checkAuthData(ad []byte, rpID string) (byte, uint32, error) {
	if len(ad) < 37 {
		return 0, 0, errors.New("bad authenticator data")
	}
	want := sha256.Sum256([]byte(rpID))
	if subtle.ConstantTimeCompare(ad[:32], want[:]) != 1 {
		return 0, 0, errors.New("wrong site")
	}
	flags := ad[32]
	if flags&adUP == 0 || flags&adUV == 0 {
		return 0, 0, errors.New("the passkey must check your fingerprint, face or PIN")
	}
	return flags, binary.BigEndian.Uint32(ad[33:37]), nil
}

// originMatches: the page's origin is on the passkey's host name.
func originMatches(origin, rpID string) bool {
	host := strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://")
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host == rpID
}

// parsePasskeyKey reads the SPKI and checks it fits the algorithm.
func parsePasskeyKey(spki []byte, alg int) (crypto.PublicKey, error) {
	pub, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		return nil, errors.New("bad public key")
	}
	switch k := pub.(type) {
	case *ecdsa.PublicKey:
		if alg == coseES256 && k.Curve == elliptic.P256() {
			return pub, nil
		}
	case ed25519.PublicKey:
		if alg == coseEdDSA {
			return pub, nil
		}
	case *rsa.PublicKey:
		if alg == coseRS256 && k.N.BitLen() >= 2048 {
			return pub, nil
		}
	}
	return nil, errors.New("unsupported passkey type")
}

// verifyAssertion checks the signature over authData || SHA-256(clientData).
func verifyAssertion(pub crypto.PublicKey, alg int, authData, clientData, sig []byte) bool {
	cdHash := sha256.Sum256(clientData)
	msg := append(append([]byte{}, authData...), cdHash[:]...)
	switch alg {
	case coseES256:
		k, ok := pub.(*ecdsa.PublicKey)
		h := sha256.Sum256(msg)
		return ok && ecdsa.VerifyASN1(k, h[:], sig)
	case coseEdDSA:
		k, ok := pub.(ed25519.PublicKey)
		return ok && ed25519.Verify(k, msg, sig)
	case coseRS256:
		k, ok := pub.(*rsa.PublicKey)
		h := sha256.Sum256(msg)
		return ok && rsa.VerifyPKCS1v15(k, crypto.SHA256, h[:], sig) == nil
	}
	return false
}

// -- confirm: navigator.credentials.get's answer --------------------------------

type passkeyAssertion struct {
	ID         string `json:"id"`
	ClientData string `json:"client_data"`
	AuthData   string `json:"auth_data"`
	Signature  string `json:"signature"`
}

// Confirm checks a passkey answer and gives a ticket.
func (h *Confirmer) Confirm(token, origin string, a passkeyAssertion) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.lockErr(); err != nil {
		return "", err
	}
	fail := func(msg string) (string, error) {
		h.fails = append(h.fails, h.now())
		return "", errors.New(msg)
	}
	challenge, ok := h.takeChallenge(token, "get")
	if !ok {
		return "", errors.New("Too slow - try again.")
	}
	cd, err1 := b64uDec(a.ClientData)
	ad, err2 := b64uDec(a.AuthData)
	sig, err3 := b64uDec(a.Signature)
	if err1 != nil || err2 != nil || err3 != nil {
		return fail("Bad passkey answer.")
	}
	keys, err := h.loadKeys()
	if err != nil {
		return "", err
	}
	idx := -1
	for i, k := range keys {
		if k.ID == strings.TrimRight(a.ID, "=") {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fail("This passkey is not registered here.")
	}
	k := &keys[idx]
	if err := checkClientData(cd, "webauthn.get", challenge, origin); err != nil {
		return fail("Passkey refused: " + err.Error() + ".")
	}
	if !originMatches(origin, k.RPID) {
		return fail("Passkey refused: wrong site.")
	}
	_, count, err := checkAuthData(ad, k.RPID)
	if err != nil {
		return fail("Passkey refused: " + err.Error() + ".")
	}
	spki, err := b64uDec(k.Key)
	if err != nil {
		return "", errors.New("the stored passkey is damaged")
	}
	pub, err := parsePasskeyKey(spki, k.Alg)
	if err != nil || !verifyAssertion(pub, k.Alg, ad, cd, sig) {
		return fail("Passkey refused: bad signature.")
	}
	// A counter that goes back means a copied key. Synced passkeys always
	// say 0, and that is fine.
	if (count != 0 || k.Count != 0) && count <= k.Count {
		return fail("Passkey refused: its counter went back (a copied key?).")
	}
	k.Count = count
	k.Used = h.now().UTC().Format(time.RFC3339)
	if err := h.saveKeys(keys); err != nil {
		return "", err
	}
	return h.newTicket(token), nil
}

// -- register: navigator.credentials.create's answer ----------------------------

type passkeyRegistration struct {
	Code       string   `json:"code"`   // the first passkey: the setup code
	Ticket     string   `json:"ticket"` // the next ones: a ticket
	Name       string   `json:"name"`
	ID         string   `json:"id"`
	ClientData string   `json:"client_data"`
	AuthData   string   `json:"auth_data"`
	Key        string   `json:"key"` // getPublicKey(): SPKI DER
	Alg        int      `json:"alg"`
	Transports []string `json:"transports"`
}

// Register stores a new passkey and gives a ticket (making it needed the
// fingerprint/face/PIN, so it counts as confirmed).
func (h *Confirmer) Register(token, origin string, r passkeyRegistration) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.lockErr(); err != nil {
		return "", err
	}
	keys, err := h.loadKeys()
	if err != nil {
		return "", err
	}
	// The same gate as Begin, checked again and now spent.
	has, err := h.hasFactor()
	if err != nil {
		return "", err
	}
	if !has {
		if !h.setupOK(r.Code) {
			return "", errSetupCode
		}
	} else {
		ok := h.ticketOK(token, r.Ticket)
		delete(h.tickets, token)
		if !ok {
			return "", errConfirmFirst
		}
	}
	challenge, ok := h.takeChallenge(token, "create")
	if !ok {
		return "", errors.New("Too slow - try again.")
	}
	id, err0 := b64uDec(r.ID)
	cd, err1 := b64uDec(r.ClientData)
	ad, err2 := b64uDec(r.AuthData)
	spki, err3 := b64uDec(r.Key)
	if err0 != nil || err1 != nil || err2 != nil || err3 != nil || len(id) == 0 || len(id) > 1023 {
		return "", errors.New("Bad passkey answer.")
	}
	if err := checkClientData(cd, "webauthn.create", challenge, origin); err != nil {
		return "", errors.New("Passkey refused: " + err.Error() + ".")
	}
	host := strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://")
	if hh, _, err := net.SplitHostPort(host); err == nil {
		host = hh
	}
	flags, count, err := checkAuthData(ad, host)
	if err != nil {
		return "", errors.New("Passkey refused: " + err.Error() + ".")
	}
	// The credential id inside the authenticator data must be the one sent.
	if flags&adAT == 0 || len(ad) < 55 {
		return "", errors.New("Passkey refused: no credential in the answer.")
	}
	n := int(binary.BigEndian.Uint16(ad[53:55]))
	if len(ad) < 55+n || !bytes.Equal(ad[55:55+n], id) {
		return "", errors.New("Passkey refused: the ids do not match.")
	}
	if _, err := parsePasskeyKey(spki, r.Alg); err != nil {
		return "", errors.New("Passkey refused: " + err.Error() + ".")
	}
	idS := b64u(id)
	for _, k := range keys {
		if k.ID == idS {
			return "", errors.New("This passkey is registered already.")
		}
	}
	name := strings.TrimSpace(r.Name)
	if name == "" {
		name = "Passkey"
	}
	if len([]rune(name)) > 60 {
		name = string([]rune(name)[:60])
	}
	var tr []string
	for _, t := range r.Transports {
		if len(tr) < 8 && len(t) <= 20 {
			tr = append(tr, t)
		}
	}
	now := h.now().UTC().Format(time.RFC3339)
	keys = append(keys, passkeyRec{
		ID: idS, Key: b64u(spki), Alg: r.Alg, RPID: host,
		Name: name, Transports: tr, Count: count, Added: now, Used: now,
	})
	if err := h.saveKeys(keys); err != nil {
		return "", err
	}
	h.dropSetup()
	return h.newTicket(token), nil
}

// RemoveKey drops one passkey, or the app (id "app"); it needs a ticket.
func (h *Confirmer) RemoveKey(token, ticket, id string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	ok := h.ticketOK(token, ticket)
	delete(h.tickets, token)
	if !ok {
		return errConfirmFirst
	}
	if id == totpListID {
		return h.removeTOTP()
	}
	keys, err := h.loadKeys()
	if err != nil {
		return err
	}
	keep := keys[:0]
	for _, k := range keys {
		if k.ID != id {
			keep = append(keep, k)
		}
	}
	if len(keep) == len(keys) {
		return errors.New("No such passkey.")
	}
	return h.saveKeys(keep)
}
