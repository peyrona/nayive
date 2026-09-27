package main

import (
	"net/http/httptest"
	"testing"
)

// TestRequestOriginIgnoresForwardedProto: nothing proxies Nayive, so a request
// that says "X-Forwarded-Proto: https" over plain HTTP is still plain HTTP.
func TestRequestOriginIgnoresForwardedProto(t *testing.T) {
	r := httptest.NewRequest("GET", "http://nayive.test/api/location/k/gpslogger", nil)
	r.Header.Set("X-Forwarded-Proto", "https")
	if got := requestOrigin(r); got != "http://nayive.test" {
		t.Fatalf("requestOrigin = %q, want http://nayive.test", got)
	}
}
