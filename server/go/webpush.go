package main

// =============================================================================
// Web Push: the OS-level notification for a calendar event about to start.
// =============================================================================
//
// The BROWSER hands us a "subscription" (an https URL owned by Google/Apple/
// Mozilla plus two keys), we encrypt a short JSON message so that only that
// browser can read it, and POST it to that URL. The push service holds the
// message and wakes the device - even with the app closed - and the service
// worker (apps/sw.js) turns it into a real OS notification.
//
// Three separate things have to be right, and each has its own RFC:
//
//	RFC 8030  the POST itself: where it goes, the TTL and Urgency headers.
//	RFC 8291  the encryption: ECDH against the browser's key, HKDF to a content
//	          key, AES-128-GCM. The push service NEVER sees the plaintext.
//	RFC 8292  VAPID: an ES256 JWT that says "this really is Nayive", signed with
//	          a keypair the server generates once (see vapidKeys).
//	RFC 8188  the "aes128gcm" body framing that wraps the ciphertext.
//
// THE DEPENDENCY THAT IS NO LONGER HERE
// -----------------------------------------------------------------------------
// lib/webpush.py needed python3-cryptography from apt - the one non-stdlib
// import in the whole Python server, and the reason install.sh could refuse to
// install. Go's standard library has all four primitives:
//
//	crypto/ecdh    the ECDH exchange and the on-curve point check
//	crypto/ecdsa   the ES256 signature
//	crypto/hkdf    HKDF-SHA256            (stdlib since Go 1.24)
//	crypto/aes + crypto/cipher   AES-128-GCM
//
// So this file has no _BROKEN flag and no "notifications are disabled because a
// package is missing" path: the code is either compiled in or the binary does
// not exist. The self-test is now an ordinary Go test (webpush_test.go).
//
// THE FAILURE MODE TO FEAR
// -----------------------------------------------------------------------------
// Get the encryption subtly wrong and the push service answers 201 Created, the
// browser silently discards the message, and NOTHING appears in any log. It is
// indistinguishable from "no events matched". That is why webpush_test.go runs
// the RFC 8291 section 5 worked example - fixed keys, fixed salt, known answer.

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	recordSize   = 4096 // RFC 8188 "rs": we always send exactly one record
	maxPlaintext = 3800 // 4096 - 86 header - 16 tag - 1 delimiter, rounded down
	pushTimeout  = 15 * time.Second
	jwtLifetime  = 12 * time.Hour // RFC 8292 caps this at 24 h; Apple rejects longer
	jwtRenew     = 60 * time.Second
	ttlMin       = 60
)

// -----------------------------------------------------------------------------
// base64url, unpadded - the encoding every one of these RFCs speaks
// -----------------------------------------------------------------------------

// java: base64.RawURLEncoding is exactly "URL-safe alphabet, no = padding".
// Python has to strip and re-add the padding by hand; here it is a constant.
func b64u(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

// b64uDec decodes with or without padding, because browsers send both.
func b64uDec(txt string) ([]byte, error) {
	if n := len(txt) % 4; n != 0 {
		txt += "===="[n:]
	}
	return base64.URLEncoding.DecodeString(txt)
}

// hkdfExpand is HKDF-SHA256 (RFC 5869): mix `ikm` with `salt`, stretch to `length`.
func hkdfExpand(salt, ikm, info []byte, length int) ([]byte, error) {
	return hkdf.Key(sha256.New, ikm, salt, string(info), length)
}

// -----------------------------------------------------------------------------
// The server's VAPID keypair
// -----------------------------------------------------------------------------

// VapidStore owns config/vapid.json: the ES256 keypair every push is signed
// with, generated on first use and NEVER regenerated.
//
// Regenerating it invalidates EVERY subscription on EVERY device: each browser
// bound its subscription to this exact public key, and the push service rejects
// a JWT signed by any other. Every user would have to re-enable notifications
// by hand, one device at a time, with no sign that anything broke. Treat
// config/vapid.json like a private key, because it is one.
//
// config/ is never rsynced by deploy.sh, so the VPS makes its own on first
// start and then keeps it across every deploy. That is deliberate.
type VapidStore struct {
	mu      sync.Mutex
	path    string
	contact string // the JWT "sub" claim
	loaded  bool
	priv    *ecdsa.PrivateKey
	pubRaw  []byte // the 65-byte uncompressed point
	jwts    map[string]cachedJWT
	client  *http.Client
	log     Logger
}

type cachedJWT struct {
	expires time.Time
	value   string
}

// vapidFile is the on-disk shape of config/vapid.json.
type vapidFile struct {
	Private string `json:"private"`
	Public  string `json:"public"`
	Created int64  `json:"created"`
}

// NewVapidStore does no I/O - the key is loaded on first use, like Python's
// lazy vapid_keys().
//
// contact is the JWT "sub" claim, "push_contact" in server.json: an https: or
// mailto: address of whoever runs this server. Push services (Apple's above
// all) reject a missing or malformed one, so an empty setting falls back to
// the project's own page.
func NewVapidStore(configDir, contact string, log Logger) *VapidStore {
	if contact == "" {
		contact = "https://github.com/peyrona/nayive"
	}
	return &VapidStore{
		path:    filepath.Join(configDir, "vapid.json"),
		contact: contact,
		jwts:    make(map[string]cachedJWT),
		client:  &http.Client{Timeout: pushTimeout},
		log:     log,
	}
}

// keys returns the keypair, loading or creating it on first call.
func (v *VapidStore) keys() (*ecdsa.PrivateKey, []byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if v.loaded {
		return v.priv, v.pubRaw, nil
	}
	priv, pub, err := v.loadOrCreate()
	if err != nil {
		return nil, nil, err
	}
	v.priv, v.pubRaw, v.loaded = priv, pub, true
	return priv, pub, nil
}

// PublicKey is the base64url public key the browser passes as
// applicationServerKey.
func (v *VapidStore) PublicKey() (string, error) {
	_, pub, err := v.keys()
	if err != nil {
		return "", err
	}
	return b64u(pub), nil
}

func (v *VapidStore) loadOrCreate() (*ecdsa.PrivateKey, []byte, error) {
	raw, err := os.ReadFile(v.path)
	if err == nil {
		// A corrupt file must NOT be silently replaced - overwriting it would
		// kill every subscription on the server. Fail loudly instead.
		priv, pub, perr := parseVapid(raw)
		if perr != nil {
			return nil, nil, fmt.Errorf(
				"%s is unreadable (%w). Refusing to replace it: a new keypair would "+
					"silently disable notifications on every device. Restore it from a "+
					"backup, or delete it deliberately to start over", v.path, perr)
		}
		return priv, pub, nil
	}
	if !os.IsNotExist(err) {
		return nil, nil, err
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	pub := pointBytes(&priv.PublicKey)
	if err := atomicWriteJSON(v.path, vapidFile{
		Private: b64u(priv.D.FillBytes(make([]byte, 32))),
		Public:  b64u(pub),
		Created: time.Now().Unix(),
	}, 4); err != nil {
		return nil, nil, err
	}
	// Best effort: the key is a secret, so keep it to its owner.
	_ = os.Chmod(v.path, 0o600)
	v.log.Warn("webpush: generated a NEW VAPID keypair - every existing subscription "+
		"(if any) is now invalid", "path", v.path)
	return priv, pub, nil
}

// parseVapid rebuilds the keypair from the stored 32-byte scalar and checks
// that the stored public key really belongs to it.
func parseVapid(raw []byte) (*ecdsa.PrivateKey, []byte, error) {
	var f vapidFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, nil, err
	}
	d, err := b64uDec(f.Private)
	if err != nil {
		return nil, nil, err
	}
	pub, err := b64uDec(f.Public)
	if err != nil {
		return nil, nil, err
	}
	priv, err := privFromScalar(d)
	if err != nil {
		return nil, nil, err
	}
	if len(pub) != 65 || !bytes.Equal(pointBytes(&priv.PublicKey), pub) {
		return nil, nil, errors.New("public key does not match the private key")
	}
	return priv, pub, nil
}

// privFromScalar rebuilds an ECDSA key from its 32-byte private scalar.
//
// java: crypto/ecdh parses a raw scalar and derives the point for us; the
// result is then copied into an ecdsa.PrivateKey, which is the type that can
// SIGN. The two packages hold the same key in two shapes: ecdh does key
// agreement, ecdsa does signatures, and neither will do the other's job.
func privFromScalar(d []byte) (*ecdsa.PrivateKey, error) {
	if len(d) != 32 {
		return nil, errors.New("private scalar must be 32 bytes")
	}
	ek, err := ecdh.P256().NewPrivateKey(d)
	if err != nil {
		return nil, err
	}
	point := ek.PublicKey().Bytes() // 0x04 || X || Y
	priv := &ecdsa.PrivateKey{D: new(big.Int).SetBytes(d)}
	priv.PublicKey.Curve = elliptic.P256()
	priv.PublicKey.X = new(big.Int).SetBytes(point[1:33])
	priv.PublicKey.Y = new(big.Int).SetBytes(point[33:])
	return priv, nil
}

// pointBytes is the public key as the 65-byte uncompressed X9.62 point
// (0x04 || X || Y).
func pointBytes(pub *ecdsa.PublicKey) []byte {
	out := make([]byte, 65)
	out[0] = 4
	pub.X.FillBytes(out[1:33])
	pub.Y.FillBytes(out[33:])
	return out
}

// -----------------------------------------------------------------------------
// RFC 8291 encryption + RFC 8188 framing
// -----------------------------------------------------------------------------

// ValidateKeys rejects anything that is not a real Web Push key pair: a 65-byte
// point that is actually ON the P-256 curve, and a 16-byte auth secret.
//
// Called when a device registers, so a malformed subscription is refused at the
// door. Without it a bad entry would sit in push.json and fail on every tick
// forever, at a moment when nobody is watching the log.
func ValidateKeys(p256dh, auth string) error {
	raw, err := b64uDec(p256dh)
	if err != nil {
		return err
	}
	// java: NewPublicKey RETURNS AN ERROR for a point that is not on the curve.
	// That is exactly the validation /api/push needs, so we get it for free.
	if _, err := ecdh.P256().NewPublicKey(raw); err != nil {
		return err
	}
	secret, err := b64uDec(auth)
	if err != nil {
		return err
	}
	if len(secret) != 16 {
		return errors.New("auth secret must be 16 bytes")
	}
	return nil
}

// encrypt builds the `aes128gcm` body of ONE push message, for the browser that
// owns `p256dh` (its public key) and `auth` (a 16-byte shared secret).
//
// salt and asPriv exist ONLY so the RFC 8291 section 5 vector can be injected
// by the test. Production callers pass nil for both and get fresh randomness
// for every single message - reusing either would be a real crypto flaw.
func encrypt(plaintext []byte, p256dh, auth string, salt []byte, asPriv *ecdh.PrivateKey) ([]byte, error) {
	uaPubRaw, err := b64uDec(p256dh)
	if err != nil {
		return nil, err
	}
	uaPub, err := ecdh.P256().NewPublicKey(uaPubRaw)
	if err != nil {
		return nil, err
	}
	authRaw, err := b64uDec(auth)
	if err != nil {
		return nil, err
	}
	if len(authRaw) != 16 {
		return nil, errors.New("auth secret must be 16 bytes")
	}

	if asPriv == nil {
		if asPriv, err = ecdh.P256().GenerateKey(rand.Reader); err != nil {
			return nil, err
		}
	}
	if salt == nil {
		salt = make([]byte, 16)
		if _, err := rand.Read(salt); err != nil {
			return nil, err
		}
	}
	asPubRaw := asPriv.PublicKey().Bytes()

	shared, err := asPriv.ECDH(uaPub)
	if err != nil {
		return nil, err
	}

	// The single most common Web Push bug lives on the next line: the USER
	// AGENT key comes first and the sender's second. Swap them and the push
	// service still answers 201, but the browser silently drops the message.
	keyInfo := append(append([]byte("WebPush: info\x00"), uaPubRaw...), asPubRaw...)

	ikm, err := hkdfExpand(authRaw, shared, keyInfo, 32)
	if err != nil {
		return nil, err
	}
	cek, err := hkdfExpand(salt, ikm, []byte("Content-Encoding: aes128gcm\x00"), 16)
	if err != nil {
		return nil, err
	}
	// With a single record the RFC's sequence number is 0, so the XOR it
	// describes is a no-op and the derived nonce is used as-is.
	nonce, err := hkdfExpand(salt, ikm, []byte("Content-Encoding: nonce\x00"), 12)
	if err != nil {
		return nil, err
	}

	if len(plaintext) > maxPlaintext {
		plaintext = plaintext[:maxPlaintext]
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	// 0x02 marks the LAST record. We never emit 0x01 (a non-last record),
	// because RFC 8291 allows exactly one record per push message.
	ciphertext := gcm.Seal(nil, nonce, append(plaintext, 0x02), nil)

	header := make([]byte, 0, 21+len(asPubRaw)+len(ciphertext))
	header = append(header, salt...)
	header = binary.BigEndian.AppendUint32(header, recordSize)
	header = append(header, byte(len(asPubRaw)))
	header = append(header, asPubRaw...)
	return append(header, ciphertext...), nil
}

// -----------------------------------------------------------------------------
// RFC 8292 VAPID
// -----------------------------------------------------------------------------

// authHeader is the Authorization value for `endpoint`, cached per push service.
//
// Signing is cheap, but the JWT is valid for 12 h and identical for every device
// behind the same push service, so caching turns thousands of signatures into a
// handful.
func (v *VapidStore) authHeader(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	origin := u.Scheme + "://" + u.Host

	v.mu.Lock()
	hit, found := v.jwts[origin]
	v.mu.Unlock()
	if found && time.Until(hit.expires) > jwtRenew {
		return hit.value, nil
	}

	priv, pub, err := v.keys()
	if err != nil {
		return "", err
	}
	expires, value, err := signVapid(origin, v.contact, priv, pub, time.Now())
	if err != nil {
		return "", err
	}

	v.mu.Lock()
	v.jwts[origin] = cachedJWT{expires: expires, value: value}
	v.mu.Unlock()
	return value, nil
}

// signVapid builds one signed Authorization value. Split out so the test can
// exercise it with a throwaway key - running the tests must never create
// config/vapid.json as a side effect.
func signVapid(origin, contact string, priv *ecdsa.PrivateKey, pub []byte, now time.Time) (time.Time, string, error) {
	expires := now.Add(jwtLifetime)

	head, err := json.Marshal(map[string]string{"typ": "JWT", "alg": "ES256"})
	if err != nil {
		return time.Time{}, "", err
	}
	claims, err := json.Marshal(map[string]any{
		"aud": origin, "exp": expires.Unix(), "sub": contact,
	})
	if err != nil {
		return time.Time{}, "", err
	}
	signingInput := b64u(head) + "." + b64u(claims)

	// java: a JWT wants the raw 64-byte r||s, but ecdsa.SignASN1 produces DER.
	// ecdsa.Sign hands back r and s as big.Int, and FillBytes left-pads each to
	// exactly 32 bytes. Getting this wrong produces a token every push service
	// rejects with 401 - and 401 is NOT a reason to drop a subscription.
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		return time.Time{}, "", err
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])

	value := "vapid t=" + signingInput + "." + b64u(signature) + ",k=" + b64u(pub)
	return expires, value, nil
}

// -----------------------------------------------------------------------------
// The POST
// -----------------------------------------------------------------------------

// Send delivers one push message. It returns the HTTP status the push service
// answered with, or 0 when we never reached it (DNS, TCP, TLS, timeout). The
// caller MUST tell those apart:
//
//	2xx        delivered
//	404, 410   this subscription is dead - drop it
//	401, 403   OUR VAPID is wrong - log loudly, drop NOTHING (dropping here
//	           would wipe every subscription on the box in one tick)
//	413        payload too large (our bug)
//	429, 5xx   the push service is busy - keep it, try again next tick
//	0          transport failure - keep it, never mistake this for "dead"
func (v *VapidStore) Send(endpoint, p256dh, auth string, payload []byte, ttl int) (int, error) {
	body, err := encrypt(payload, p256dh, auth, nil, nil)
	if err != nil {
		return 0, fmt.Errorf("encrypt failed: %w", err)
	}
	header, err := v.authHeader(endpoint)
	if err != nil {
		return 0, err
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", header)
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	// TTL is REQUIRED by Mozilla and Apple. It is how long the push service
	// holds the message for a device that is offline; past the reminder window
	// the notification would be stale, so that is exactly the right value.
	if ttl < ttlMin {
		ttl = ttlMin
	}
	req.Header.Set("TTL", itoa(ttl))
	req.Header.Set("Urgency", "high")

	resp, err := v.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	// java: drain before closing, or the connection cannot be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp.StatusCode, nil
	}
	return resp.StatusCode, fmt.Errorf("%d %s", resp.StatusCode, resp.Status)
}

// SendJSON is Send for one stored subscription.
func (v *VapidStore) SendJSON(sub PushSub, payload any, ttl int) (int, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	return v.Send(sub.Endpoint, sub.Keys.P256dh, sub.Keys.Auth, raw, ttl)
}
