package main

import (
	"testing"
)

// TestDeviceEnrolEndpointChecked: enrolment keeps only a real push service's
// endpoint - anything else is dropped (the phone still enrols, without push),
// as the PUT route refuses it. IPv6 literals and zones included.
func TestDeviceEnrolEndpointChecked(t *testing.T) {
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	for i, bad := range []string{"", "https://127.0.0.1/x", "https://intranet.local/x",
		"https://[::ffff:127.0.0.1%25.google.com]/x"} {
		tok := phoneToken + string(rune('a'+i))
		var out struct{ ID string }
		jsonCall(t, client, "POST", ts.URL+"/api/device/enrol",
			`{"t":"`+tok+`","name":"móvil","endpoint":"`+bad+`"}`, 200, &out)
		for _, row := range srv.devices.List("ana") {
			if row.ID == out.ID && row.Endpoint != "" {
				t.Errorf("enrol with %q kept endpoint %q", bad, row.Endpoint)
			}
		}
	}
}
