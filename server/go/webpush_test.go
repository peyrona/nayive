package main

// =============================================================================
// The correctness gate: RFC 8291 section 5 + Appendix A, verbatim.
// =============================================================================
//
// Fixed keys and a fixed salt, so the whole ECDH -> HKDF -> AES-GCM -> framing
// chain has exactly one right answer. This is the port of
// lib/webpush.py's self_test() and tools/check-webpush.py - the ONLY known
// answer test the project had, and now an ordinary `go test`.
//
// The RFC prints "Content-Length: 145" above a 144-byte body; the body is the
// correct part (86-byte header + 41 plaintext + 1 delimiter + 16 tag).

import (
	"crypto/ecdh"
	"strings"
	"testing"
	"time"
)

var rfc8291 = struct {
	uaPub, asPriv, asPub, auth, salt string
	plain                            string
	shared, ikm, cek, nonce, body    string
}{
	uaPub: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZ" +
		"GH6SRpkNtoIAiw4",
	asPriv: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	asPub: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8w" +
		"EqKK6PBru3jl7A8",
	auth:   "BTBZMqHH6r4Tts7J_aSIgg",
	salt:   "DGv6ra1nlYgDCS1FRnbzlw",
	plain:  "When I grow up, I want to be a watermelon",
	shared: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
	ikm:    "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
	cek:    "oIhVW04MRdy2XN9CiKLxTg",
	nonce:  "4h_95klXJ5E_qnoN",
	body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
}

// mustDec fails the test rather than returning an error nobody would check.
func mustDec(t *testing.T, txt string) []byte {
	t.Helper()
	raw, err := b64uDec(txt)
	if err != nil {
		t.Fatalf("decode %q: %v", txt, err)
	}
	return raw
}

// TestRFC8291Vector walks the whole chain, checking every intermediate - so a
// failure says WHICH step broke instead of just "the answer is wrong".
func TestRFC8291Vector(t *testing.T) {
	v := rfc8291

	asPriv, err := ecdh.P256().NewPrivateKey(mustDec(t, v.asPriv))
	if err != nil {
		t.Fatalf("as_priv: %v", err)
	}
	if got := b64u(asPriv.PublicKey().Bytes()); got != v.asPub {
		t.Fatalf("as_pub  = %s\n   want %s", got, v.asPub)
	}

	uaPub, err := ecdh.P256().NewPublicKey(mustDec(t, v.uaPub))
	if err != nil {
		t.Fatalf("ua_pub: %v", err)
	}
	shared, err := asPriv.ECDH(uaPub)
	if err != nil {
		t.Fatalf("ecdh: %v", err)
	}
	if got := b64u(shared); got != v.shared {
		t.Fatalf("shared = %s\n  want %s", got, v.shared)
	}

	keyInfo := append(append([]byte("WebPush: info\x00"), mustDec(t, v.uaPub)...),
		mustDec(t, v.asPub)...)
	ikm, err := hkdfExpand(mustDec(t, v.auth), shared, keyInfo, 32)
	if err != nil {
		t.Fatalf("hkdf ikm: %v", err)
	}
	if got := b64u(ikm); got != v.ikm {
		t.Fatalf("ikm = %s\n want %s", got, v.ikm)
	}

	salt := mustDec(t, v.salt)
	cek, _ := hkdfExpand(salt, ikm, []byte("Content-Encoding: aes128gcm\x00"), 16)
	if got := b64u(cek); got != v.cek {
		t.Fatalf("cek = %s\n want %s", got, v.cek)
	}
	nonce, _ := hkdfExpand(salt, ikm, []byte("Content-Encoding: nonce\x00"), 12)
	if got := b64u(nonce); got != v.nonce {
		t.Fatalf("nonce = %s\n   want %s", got, v.nonce)
	}

	body, err := encrypt([]byte(v.plain), v.uaPub, v.auth, salt, asPriv)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if got := b64u(body); got != v.body {
		t.Fatalf("body = %s\n  want %s", got, v.body)
	}
	if len(body) != 144 {
		t.Errorf("body is %d bytes, want 144", len(body))
	}
}

// TestVapidJWTShape checks the part every push service rejects with 401 when it
// is wrong: three base64url segments, and a RAW 64-byte r||s signature rather
// than the DER that most ECDSA APIs hand back.
func TestVapidJWTShape(t *testing.T) {
	priv, err := privFromScalar(mustDec(t, rfc8291.asPriv))
	if err != nil {
		t.Fatalf("privFromScalar: %v", err)
	}

	_, header, err := signVapid("https://push.example.net", "https://example.com",
		priv, pointBytes(&priv.PublicKey), time.Now())
	if err != nil {
		t.Fatalf("signVapid: %v", err)
	}

	if !strings.HasPrefix(header, "vapid t=") || !strings.Contains(header, ",k=") {
		t.Fatalf("header has the wrong shape: %s", header)
	}
	token := strings.SplitN(strings.TrimPrefix(header, "vapid t="), ",", 2)[0]
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT has %d segments, want 3", len(parts))
	}
	if sig := mustDec(t, parts[2]); len(sig) != 64 {
		t.Errorf("signature is %d bytes, want a raw 64-byte r||s", len(sig))
	}
}

// TestPrivFromScalarRoundTrip is the check that stops a corrupt vapid.json from
// being silently replaced: the stored point must belong to the stored scalar.
func TestPrivFromScalarRoundTrip(t *testing.T) {
	priv, err := privFromScalar(mustDec(t, rfc8291.asPriv))
	if err != nil {
		t.Fatalf("privFromScalar: %v", err)
	}
	if got := b64u(pointBytes(&priv.PublicKey)); got != rfc8291.asPub {
		t.Errorf("derived public key = %s, want %s", got, rfc8291.asPub)
	}
}

// TestValidateKeys is what /api/push calls before storing a subscription.
func TestValidateKeys(t *testing.T) {
	if err := ValidateKeys(rfc8291.uaPub, rfc8291.auth); err != nil {
		t.Errorf("a valid subscription was refused: %v", err)
	}
	// A point that is not on the P-256 curve: 65 bytes of the right shape,
	// wrong coordinates. crypto/ecdh is what catches this.
	bad := make([]byte, 65)
	bad[0] = 4
	bad[1] = 9
	if err := ValidateKeys(b64u(bad), rfc8291.auth); err == nil {
		t.Error("an off-curve point was accepted")
	}
	if err := ValidateKeys(rfc8291.uaPub, b64u(make([]byte, 15))); err == nil {
		t.Error("a 15-byte auth secret was accepted")
	}
}
