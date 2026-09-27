package main

// =============================================================================
// eMail: the providers the accounts dialog offers, with their servers.
// =============================================================================
//
// One list, here: GET /api/mail/providers hands it to the page (its drop-down
// and the help it shows for each), and Add fills an account's servers from
// it - by the provider picked, or by the address's domain. "Other" is not
// in it: that one is the user typing the two servers.
//
// Pass: "app" = the provider wants an app password (its normal password is
// refused over IMAP); "normal" = the account's own password; "token" = an
// API token. Kind "jmap": spoken over JMAP (mail_jmap.go), not IMAP + SMTP -
// JMAPURL is its session resource, "" = the user types their server. Blocked: the
// provider no longer lets any app in with a password at all - Microsoft
// turned it off for Outlook.com / Hotmail / Live in September 2024 and only
// takes its own OAuth sign-in now, which Nayive does not do (yet). Proton
// only speaks IMAP through its Bridge program, on a computer.

import (
	"errors"
	"net/url"
	"strings"
)

type mailPreset struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Domains  []string `json:"domains"`
	IMAPHost string   `json:"imapHost,omitempty"`
	IMAPPort int      `json:"imapPort,omitempty"`
	SMTPHost string   `json:"smtpHost,omitempty"`
	SMTPPort int      `json:"smtpPort,omitempty"`
	Kind     string   `json:"kind,omitempty"` // "" = IMAP + SMTP | "jmap"
	JMAPURL  string   `json:"jmapUrl,omitempty"`
	Pass     string   `json:"pass"`           // "app" | "normal" | "token"
	Help     string   `json:"help,omitempty"` // where the app password is made
	Blocked  bool     `json:"blocked,omitempty"`
	// OwnSent: its SMTP files a copy of what it sends in Sent by itself, so
	// Nayive must not add one (Gmail: known). Unknown = false: Nayive adds it.
	OwnSent bool `json:"-"`
}

var mailPresets = []mailPreset{
	{ID: "gmail", Name: "Gmail", Domains: []string{"gmail.com", "googlemail.com"},
		IMAPHost: "imap.gmail.com", IMAPPort: 993, SMTPHost: "smtp.gmail.com", SMTPPort: 465,
		Pass: "app", Help: "https://myaccount.google.com/apppasswords", OwnSent: true},
	{ID: "microsoft", Name: "Outlook / Hotmail",
		Domains: []string{"outlook.com", "outlook.es", "hotmail.com", "hotmail.es", "live.com", "live.es", "msn.com"},
		Pass:    "app", Blocked: true},
	{ID: "yahoo", Name: "Yahoo", Domains: []string{"yahoo.com", "yahoo.es", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.it", "ymail.com", "rocketmail.com"},
		IMAPHost: "imap.mail.yahoo.com", IMAPPort: 993, SMTPHost: "smtp.mail.yahoo.com", SMTPPort: 465,
		Pass: "app", Help: "https://login.yahoo.com/account/security"},
	{ID: "icloud", Name: "iCloud (Apple)", Domains: []string{"icloud.com", "me.com", "mac.com"},
		IMAPHost: "imap.mail.me.com", IMAPPort: 993, SMTPHost: "smtp.mail.me.com", SMTPPort: 587,
		Pass: "app", Help: "https://account.apple.com"},
	{ID: "aol", Name: "AOL", Domains: []string{"aol.com", "aol.es"},
		IMAPHost: "imap.aol.com", IMAPPort: 993, SMTPHost: "smtp.aol.com", SMTPPort: 465,
		Pass: "app", Help: "https://login.aol.com/account/security"},
	{ID: "gmx", Name: "GMX", Domains: []string{"gmx.com", "gmx.us"},
		IMAPHost: "imap.gmx.com", IMAPPort: 993, SMTPHost: "mail.gmx.com", SMTPPort: 587,
		Pass: "normal"},
	{ID: "fastmail", Name: "Fastmail", Domains: []string{"fastmail.com", "fastmail.fm"},
		IMAPHost: "imap.fastmail.com", IMAPPort: 993, SMTPHost: "smtp.fastmail.com", SMTPPort: 465,
		Pass: "app", Help: "https://app.fastmail.com/settings/security/apps"},
	{ID: "fastmailjmap", Name: "Fastmail (JMAP)", Domains: []string{},
		Kind: "jmap", JMAPURL: "https://api.fastmail.com/jmap/session",
		Pass: "token", Help: "https://www.fastmail.help/hc/en-us/articles/5254602856719-API-tokens"},
	{ID: "jmap", Name: "JMAP", Domains: []string{}, Kind: "jmap", Pass: "normal"},
	{ID: "proton", Name: "Proton Mail", Domains: []string{"proton.me", "protonmail.com", "pm.me"},
		Pass: "normal", Blocked: true},
}

// presetByID is the provider picked in the dialog; nil for "" or "other".
func presetByID(id string) *mailPreset {
	for i := range mailPresets {
		if mailPresets[i].ID == id {
			return &mailPresets[i]
		}
	}
	return nil
}

// presetForEmail is the provider an address belongs to, by its domain.
func presetForEmail(email string) *mailPreset {
	at := strings.LastIndexByte(email, '@')
	if at < 0 {
		return nil
	}
	domain := strings.ToLower(email[at+1:])
	for i := range mailPresets {
		if contains(mailPresets[i].Domains, domain) {
			return &mailPresets[i]
		}
	}
	return nil
}

var errMailBadURL = errors.New("mail: that is not a JMAP server address")

// cleanJMAPURL makes a typed server into its session URL: "mail.x.org" ->
// "https://mail.x.org/.well-known/jmap" (RFC 8620 2.2); a full URL stays.
// Only https - plain http only to this machine (tests, a server at home).
func cleanJMAPURL(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", errMailBadURL
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || u.User != nil {
		return "", errMailBadURL
	}
	host := u.Hostname()
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", errMailBadURL
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/.well-known/jmap"
	}
	u.RawQuery, u.Fragment = "", ""
	return u.String(), nil
}
