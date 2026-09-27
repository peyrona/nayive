package main

// =============================================================================
// Review of batch 3: the push allow-list cannot be walked around with IP
// literals, zones or redirects, and the push client never dials inside (#19).
// =============================================================================

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// TestPushHostNoLiteralsOrZones: the reviewer's endpoints, and more of their
// kind, are no push service; the real ones still are.
func TestPushHostNoLiteralsOrZones(t *testing.T) {
	for e, want := range map[string]bool{
		"https://[::1%25.google.com]/fcm/send/x":         false,
		"https://[::ffff:127.0.0.1%25.push.apple.com]/x": false,
		"https://[::ffff:10.0.0.1%25.google.com]/x":      false,
		"https://[::1]/x":                                false,
		"https://[2001:db8::1]/x":                        false,
		"https://127.0.0.1/x":                            false,
		"https://evil.google.com/x":                      false,
		"https://jmt.google.com/x":                       false,
		"https://jmt17x.google.com/x":                    false,
		"https://www.google.com/url?q=http://10.0.0.1/":  false,
		"https://jmt17.google.com/fcm/send/abc":          true,
		"https://jmt0.google.com/fcm/send/abc":           true,
		"https://fcm.googleapis.com/fcm/send/abc":        true,
		"https://android.googleapis.com/gcm/send/abc":    true,
		"https://web.push.apple.com/QGx":                 true,
		"https://updates.push.services.mozilla.com/w/x":  true,
		"https://wns2-db5p.notify.windows.com/w/?token=": true,
	} {
		if got := chatPushHostOK(e); got != want {
			t.Errorf("chatPushHostOK(%q) = %v, want %v", e, got, want)
		}
	}
}

// TestPushDialRefusesInside: whatever a push host resolves to, the client
// never connects to loopback, a private or link-local network, or nowhere.
func TestPushDialRefusesInside(t *testing.T) {
	for addr, ok := range map[string]bool{
		"127.0.0.1:443":              false,
		"[::1]:443":                  false,
		"10.1.2.3:443":               false,
		"192.168.1.1:443":            false,
		"172.16.0.1:443":             false,
		"100.64.0.1:443":             false,
		"169.254.169.254:443":        false,
		"0.0.0.0:443":                false,
		"[::]:443":                   false,
		"[::ffff:10.0.0.1]:443":      false,
		"[::ffff:127.0.0.1]:443":     false,
		"[fe80::1%eth0]:443":         false,
		"[fc00::1]:443":              false,
		"224.0.0.1:443":              false,
		"142.250.184.10:443":         true,
		"[2a00:1450:4003::200a]:443": true,
	} {
		if err := pushDialControl("tcp", addr, nil); (err == nil) != ok {
			t.Errorf("pushDialControl(%q) = %v, want allowed=%v", addr, err, ok)
		}
	}
}

// TestPushClientGuarded: the client VapidStore really sends with neither
// follows a redirect nor reaches a server on this machine.
func TestPushClientGuarded(t *testing.T) {
	v := NewVapidStore(t.TempDir(), "", nil)
	if v.client.CheckRedirect == nil ||
		!errors.Is(v.client.CheckRedirect(nil, nil), http.ErrUseLastResponse) {
		t.Error("the push client follows redirects")
	}

	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer local.Close()
	tr, ok := v.client.Transport.(*http.Transport)
	if !ok || tr.DialContext == nil {
		t.Fatal("the push client has no guarded dialer")
	}
	u, _ := url.Parse(local.URL)
	if c, err := tr.DialContext(context.Background(), "tcp", u.Host); err == nil {
		c.Close()
		t.Fatalf("the push client dialled %s", u.Host)
	} else if !errors.Is(err, errPushInside) {
		t.Errorf("dial %s failed, but not by the guard: %v", u.Host, err)
	}
	// Through the name, too - "localhost" resolves to loopback.
	_, port, _ := net.SplitHostPort(u.Host)
	if c, err := tr.DialContext(context.Background(), "tcp", "localhost:"+port); err == nil {
		c.Close()
		t.Fatal("the push client dialled localhost")
	}
}

// localPush lets `v` push to a fake service on this machine: the real client
// refuses every non-public address (pushDialControl).
func localPush(v *VapidStore) {
	v.client = &http.Client{Timeout: pushTimeout}
}
