package main

// =============================================================================
// "Confirm it is you" with an AUTHENTICATOR APP: a 6-digit code (TOTP).
// =============================================================================
//
// The fallback beside the passkeys (confirm_passkey.go), for a PC or a browser
// with no passkeys: Google Authenticator, Aegis, 2FAS, Microsoft
// Authenticator... any app that reads an otpauth:// QR code.
//
// RFC 6238 with the standard library only: HMAC-SHA1, 30-second steps, 6
// digits. A code is good one step either side of now (a clock a little off),
// is compared in constant time, and works ONCE: the last step used is kept,
// and only a later one is taken (no replay).
//
// ONE app per Confirmer, in config/<prefix>-totp.json (0600). Adding it:
//   1. TOTPBegin: the gate is checked - the setup code while nothing exists
//      (checked, kept), else a ticket (spent here: scanning may outlast it).
//      A new secret is held in memory for this session only; the page shows
//      it as a QR code, as text and as a link;
//   2. TOTPAdd: the gate again (the setup code, or "a ticket was spent in
//      step 1" while a way to confirm still exists), then the first code from
//      the app proves the scan worked. Only then is the file written and the
//      setup code spent. A ticket comes back, as after a passkey.
// The secret leaves the server once, in step 1, and is never sent again.
//
// Wrong codes count with every other wrong try (5 in 15 minutes, or 10 in a
// day, lock it).

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	totpStep     = 30 // seconds
	totpDigits   = 6
	totpEnrolTTL = 10 * time.Minute // the QR code shown -> the first code typed
	totpListID   = "app"            // the app's id in ListKeys / RemoveKey
)

var totpB32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// totpApp is the one app, as stored in config/<prefix>-totp.json.
type totpApp struct {
	Name   string `json:"name"`
	Secret string `json:"secret"`    // base32, no padding
	Last   int64  `json:"last_step"` // the last step used: only a later one works
	Added  string `json:"added"`
	Used   string `json:"used,omitempty"`
}

// totpPending is a secret shown to the page, waiting for its first code.
type totpPending struct {
	secret    []byte
	viaTicket bool // step 1 spent a ticket (not the setup code)
	expires   time.Time
}

// hotp is RFC 4226: HMAC-SHA1 of the counter, dynamic truncation, `digits` long.
func hotp(key []byte, counter uint64, digits int) string {
	m := hmac.New(sha1.New, key)
	m.Write(binary.BigEndian.AppendUint64(nil, counter))
	sum := m.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	n := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	mod := uint32(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	s := strconv.FormatUint(uint64(n%mod), 10)
	return strings.Repeat("0", digits-len(s)) + s
}

// totpMatch checks a typed code against the steps around `now`, all three
// in constant time. It answers the latest matching step after `last`;
// `old` is true when the code matched only a step already used.
func totpMatch(key []byte, typed string, now time.Time, last int64) (step int64, old, ok bool) {
	typed = strings.NewReplacer(" ", "", "-", "").Replace(strings.TrimSpace(typed))
	cur := now.Unix() / totpStep
	for d := int64(-1); d <= 1; d++ {
		s := cur + d
		if s < 0 {
			continue
		}
		eq := subtle.ConstantTimeCompare([]byte(hotp(key, uint64(s), totpDigits)), []byte(typed)) == 1
		switch {
		case eq && s > last:
			step, ok = s, true
		case eq:
			old = true
		}
	}
	return step, old && !ok, ok
}

// -- the stored app ---------------------------------------------------------------

func (h *Confirmer) totpPath() string { return h.path(confirmTOTPFile) }

// loadTOTP reads the app; a missing file is no app. Caller holds h.mu.
func (h *Confirmer) loadTOTP() (*totpApp, error) {
	data, err := os.ReadFile(h.totpPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var app totpApp
	if err := json.Unmarshal(data, &app); err != nil {
		return nil, err
	}
	return &app, nil
}

// saveTOTP writes it, 0600 (config, not user data). Caller holds h.mu.
func (h *Confirmer) saveTOTP(app *totpApp) error {
	data, err := json.MarshalIndent(app, "", "    ")
	if err != nil {
		return err
	}
	return atomicWriteFile(h.totpPath(), append(data, '\n'), 0o600)
}

// removeTOTP forgets the app. Caller holds h.mu and has spent a ticket.
func (h *Confirmer) removeTOTP() error {
	err := os.Remove(h.totpPath())
	if errors.Is(err, os.ErrNotExist) {
		return errors.New("No authenticator app is set up.")
	}
	return err
}

// -- adding the app ----------------------------------------------------------------

// totpOffer is what the page shows: the secret as text and as an otpauth://
// link (the QR code is drawn from the link, in the page).
type totpOffer struct {
	Secret string `json:"secret"`
	URI    string `json:"uri"`
}

var errTOTPExists = errors.New("An authenticator app is set up already. Remove it first to use another.")

// TOTPBegin makes a new secret for this session and answers it.
func (h *Confirmer) TOTPBegin(token, admin, rpID, code, ticket string) (totpOffer, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.lockErr(); err != nil {
		return totpOffer{}, err
	}
	if app, err := h.loadTOTP(); err != nil {
		return totpOffer{}, err
	} else if app != nil {
		return totpOffer{}, errTOTPExists
	}
	// The gate, as Begin's "create": the setup code while nothing exists,
	// else a ticket - spent now.
	has, err := h.hasFactor()
	if err != nil {
		return totpOffer{}, err
	}
	if !has {
		if !h.setupOK(code) {
			return totpOffer{}, errSetupCode
		}
	} else {
		ok := h.ticketOK(token, ticket)
		delete(h.tickets, token)
		if !ok {
			return totpOffer{}, errConfirmFirst
		}
	}
	secret := randomBytes(20) // 160 bits, as RFC 4226 advises
	h.totpNew[token] = totpPending{secret: secret, viaTicket: has, expires: h.now().Add(totpEnrolTTL)}

	b32 := totpB32.EncodeToString(secret)
	esc := func(s string) string { return strings.ReplaceAll(url.QueryEscape(s), "+", "%20") }
	account := admin + "@" + rpID
	uri := "otpauth://totp/" + esc(h.label) + ":" + esc(account) +
		"?secret=" + b32 + "&issuer=" + esc(h.label) +
		"&algorithm=SHA1&digits=" + strconv.Itoa(totpDigits) + "&period=" + strconv.Itoa(totpStep)
	return totpOffer{Secret: b32, URI: uri}, nil
}

// TOTPAdd takes the app's first code (a ticket, if one was needed, went in
// step 1). A right one saves the app, spends the setup code and gives a
// ticket; a wrong one counts as a wrong try and keeps the secret, so he can
// type the next code.
func (h *Confirmer) TOTPAdd(token, code, otp, name string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.lockErr(); err != nil {
		return "", err
	}
	if app, err := h.loadTOTP(); err != nil {
		return "", err
	} else if app != nil {
		return "", errTOTPExists
	}
	p, ok := h.totpNew[token]
	if !ok || h.now().After(p.expires) {
		delete(h.totpNew, token)
		return "", errors.New("Too slow - start again.")
	}
	// The gate again, on what is there NOW.
	has, err := h.hasFactor()
	if err != nil {
		return "", err
	}
	if !has {
		if !h.setupOK(code) {
			return "", errSetupCode
		}
	} else if !p.viaTicket {
		delete(h.totpNew, token) // a way in appeared meanwhile: this one is void
		return "", errConfirmFirst
	}
	step, _, ok := totpMatch(p.secret, otp, h.now(), -1)
	if !ok {
		h.fails = append(h.fails, h.now())
		return "", errors.New("Wrong code. Type the code the app shows now.")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Authenticator app"
	}
	if len([]rune(name)) > 60 {
		name = string([]rune(name)[:60])
	}
	now := h.now().UTC().Format(time.RFC3339)
	if err := h.saveTOTP(&totpApp{
		Name: name, Secret: totpB32.EncodeToString(p.secret), Last: step, Added: now, Used: now,
	}); err != nil {
		return "", err
	}
	delete(h.totpNew, token)
	if !has {
		h.dropSetup() // the setup code is spent
	}
	return h.newTicket(token), nil
}

// -- confirming with the app ---------------------------------------------------------

// TOTPConfirm checks a code from the app and gives a ticket.
func (h *Confirmer) TOTPConfirm(token, otp string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.lockErr(); err != nil {
		return "", err
	}
	app, err := h.loadTOTP()
	if err != nil {
		return "", err
	}
	if app == nil {
		return "", errors.New("No authenticator app is set up.")
	}
	key, err := totpB32.DecodeString(app.Secret)
	if err != nil || len(key) == 0 {
		return "", errors.New("the stored app secret is damaged")
	}
	step, old, ok := totpMatch(key, otp, h.now(), app.Last)
	if !ok {
		h.fails = append(h.fails, h.now())
		if old {
			return "", errors.New("This code was used already. Wait for the next code in your app.")
		}
		return "", errors.New("Wrong code. Type the code your app shows now.")
	}
	// The step is saved before the ticket is given: a lost write must not
	// leave the code usable twice.
	app.Last = step
	app.Used = h.now().UTC().Format(time.RFC3339)
	if err := h.saveTOTP(app); err != nil {
		return "", err
	}
	return h.newTicket(token), nil
}
