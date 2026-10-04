package main

// =============================================================================
// eMail: the one way out to a mail server - never into this server's own
// network.
// =============================================================================
//
// The servers of a mail account are typed by the user (Other: IMAP and SMTP
// host and port; JMAP: its address, and then whatever URLs its session names).
// Left alone, that lets any user make Nayive open a connection to 127.0.0.1,
// the LAN or a cloud's metadata address (169.254.169.254) - and a JMAP
// "download" would even hand the answer back. So every mail connection dials
// through mailDialer, whose Control refuses, AFTER the name is resolved, any
// address that is not public: loopback, private, link-local, CGNAT,
// unspecified, multicast - and this machine's own public IP (bmOwnIP, as the
// Bookmarks fetcher): from the machine itself it gets past the firewall. The tests, whose servers live on 127.0.0.1, turn
// the guard off (mail_main_test.go).

import (
	"errors"
	"net"
	"syscall"
)

var errMailPrivateNet = errors.New("mail: that server is on a private network")

// mailNetGuard: false only in tests.
var mailNetGuard = true

var mailCGNAT = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// mailPublicIP: may a mail connection go there?
func mailPublicIP(ip net.IP) bool {
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() || mailCGNAT.Contains(ip))
}

// mailDialControl runs with the resolved address, just before the connect.
func mailDialControl(network, address string, _ syscall.RawConn) error {
	if !mailNetGuard {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return errMailPrivateNet
	}
	ip := net.ParseIP(host)
	if ip == nil || !mailPublicIP(ip) || bmOwnIP(ip) {
		return errMailPrivateNet
	}
	return nil
}

// mailDialer is the dialer of every mail connection (IMAP, SMTP, JMAP).
func mailDialer() *net.Dialer {
	return &net.Dialer{Timeout: mailDialTime, Control: mailDialControl}
}
