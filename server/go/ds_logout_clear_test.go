// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// Data-safety seal: the sign-out tells the browser to delete what Nayive keeps
// there (Clear-Site-Data) ONLY for a session that is not the user's own
// device - "Keep me signed in" off, or on but the sign-out's "Is this your
// device?" answered "No" (X-Nayive-Not-Mine), never the admin's - or when the
// login page asks for it with no session left. Never on the user's own
// device: its unsent saves live there (apiLogout, SOMEONE ELSE'S PC).

import (
	"net/http"
	"strings"
	"testing"
)

func logoutClears(t *testing.T, client *http.Client, base string, headers map[string]string) bool {
	t.Helper()
	resp := do(t, client, "POST", base+"/api/logout", nil, headers)
	resp.Body.Close()
	return resp.Header.Get("Clear-Site-Data") != ""
}

func TestDS_LogoutClearSiteData(t *testing.T) {
	_, ts, client := newTestServer(t)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	login := func(remember bool) {
		body := `{"user":"ana","password":"abc","remember":false}`
		if remember {
			body = strings.Replace(body, "false", "true", 1)
		}
		resp := do(t, client, "POST", ts.URL+"/api/login", strings.NewReader(body),
			map[string]string{"Content-Type": "application/json"})
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("sign-in failed: %d", resp.StatusCode)
		}
	}
	forget := map[string]string{"X-Nayive-Forget": "1"}

	login(true)
	if logoutClears(t, client, ts.URL, nil) {
		t.Fatal("own device (remembered): sign-out sent Clear-Site-Data")
	}
	login(true)
	if logoutClears(t, client, ts.URL, forget) {
		t.Fatal("own device (remembered) + X-Nayive-Forget: sign-out sent Clear-Site-Data")
	}

	// "Is this your device?" - "No, delete everything" (shared/ui.js signOut).
	notMine := map[string]string{"X-Nayive-Not-Mine": "1"}
	login(true)
	if !logoutClears(t, client, ts.URL, notMine) {
		t.Fatal("remembered + X-Nayive-Not-Mine: sign-out did not send Clear-Site-Data")
	}

	login(false)
	if !logoutClears(t, client, ts.URL, nil) {
		t.Fatal("not remembered: sign-out did not send Clear-Site-Data")
	}

	// The admin: never, "Keep me signed in" off or not, header or not - its
	// sign-out asks nothing, and the browser may hold another account's
	// unsent saves (D1).
	adminIn := func(remember bool) {
		body := `{"user":"jefe","password":"secreto","remember":false}`
		if remember {
			body = strings.Replace(body, "false", "true", 1)
		}
		resp := do(t, client, "POST", ts.URL+"/api/login", strings.NewReader(body),
			map[string]string{"Content-Type": "application/json"})
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("admin sign-in failed: %d", resp.StatusCode)
		}
	}
	adminIn(false)
	if logoutClears(t, client, ts.URL, nil) {
		t.Fatal("admin (not remembered): sign-out sent Clear-Site-Data")
	}
	adminIn(false)
	if logoutClears(t, client, ts.URL, notMine) {
		t.Fatal("admin (not remembered) + X-Nayive-Not-Mine: sign-out sent Clear-Site-Data")
	}
	adminIn(true)
	if logoutClears(t, client, ts.URL, notMine) {
		t.Fatal("admin (remembered) + X-Nayive-Not-Mine: sign-out sent Clear-Site-Data")
	}

	// No session: only with the login page's header (another site's form
	// cannot set it) - never with the sign-out's.
	if logoutClears(t, client, ts.URL, nil) {
		t.Fatal("no session, no header: Clear-Site-Data sent")
	}
	if logoutClears(t, client, ts.URL, notMine) {
		t.Fatal("no session + X-Nayive-Not-Mine: Clear-Site-Data sent")
	}
	if !logoutClears(t, client, ts.URL, forget) {
		t.Fatal("no session + X-Nayive-Forget: Clear-Site-Data not sent")
	}
}
