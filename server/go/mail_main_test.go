package main

import (
	"os"
	"testing"
)

// The mail tests' servers (in-memory IMAP, fake JMAP) live on 127.0.0.1,
// which mailDialer refuses in real use (mail_net.go). TestMailNetGuard turns
// it back on for itself.
func TestMain(m *testing.M) {
	mailNetGuard = false
	os.Exit(m.Run())
}
