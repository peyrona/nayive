package main

// =============================================================================
// Stored passwords: PBKDF2-SHA256, salted, in the same "password" field.
// =============================================================================
//
// A stored password is one of two shapes:
//
//	"$pbkdf2-sha256$600000$<salt>$<key>"   hashed (base64url, no padding)
//	"secreto"                               plaintext, from before hashing
//
// The plaintext shape still signs in - otherwise every account that existed
// before this change would be locked out - and the first good sign-in rewrites
// it hashed (Users.Authenticate). Every place that STORES a password (the
// user's own change, the admin panel, the admin's setup) stores the hashed
// shape. "" stays "": no password yet, the person picks one at sign-in.
//
// The iteration count travels in the string, so it can be raised later: an
// older count still verifies, and is rewritten at the next good sign-in.
//
// ROLLBACK: a binary from before this change (or the Python server) compares
// plaintext, so every account rewritten hashed is locked out of it - back up
// config/server.json and homes/*/data/config.json before deploying. To let one
// account in again, put a plaintext password back in its JSON by hand: it signs
// in, and this code hashes it again.
//
// java: crypto/pbkdf2 is javax.crypto's PBKDF2WithHmacSHA256, in the standard
// library since Go 1.24 - no x/crypto needed.

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"
	"sync"
)

const (
	pwHashPrefix = "$pbkdf2-sha256$"
	pwHashIter   = 600000 // OWASP's figure for PBKDF2-SHA256; ~0.15 s here
	pwSaltLen    = 16
	pwKeyLen     = 32
)

// hashPassword is the stored form of `plain`. "" stays "" (no password).
func hashPassword(plain string) string {
	if plain == "" {
		return ""
	}
	salt := make([]byte, pwSaltLen)
	if _, err := rand.Read(salt); err != nil {
		panic(err) // crypto/rand never fails on a supported OS
	}
	key, err := pbkdf2.Key(sha256.New, plain, salt, pwHashIter, pwKeyLen)
	if err != nil {
		panic(err) // only for a key length FIPS mode refuses; ours is fixed
	}
	enc := base64.RawURLEncoding
	return pwHashPrefix + strconv.Itoa(pwHashIter) + "$" + enc.EncodeToString(salt) + "$" + enc.EncodeToString(key)
}

// pwDummyHash is what a name with no account is checked against, so a wrong
// name takes as long as a wrong password (no telling who has an account).
var pwDummyHash = sync.OnceValue(func() string { return hashPassword("-") })

// isHashedPassword tells the two stored shapes apart.
func isHashedPassword(stored string) bool {
	return strings.HasPrefix(stored, pwHashPrefix)
}

// checkPassword reports whether `typed` opens `stored`, and whether `stored`
// should be rewritten (plaintext, or fewer iterations than today's). A blank
// `stored` never matches here: "no password yet" is the caller's rule.
func checkPassword(typed, stored string) (ok, rehash bool) {
	if stored == "" {
		return false, false
	}
	if !isHashedPassword(stored) {
		return sameSecret(typed, stored), true
	}
	parts := strings.Split(strings.TrimPrefix(stored, pwHashPrefix), "$")
	if len(parts) != 3 {
		return false, false
	}
	iter, err := strconv.Atoi(parts[0])
	if err != nil || iter < 1 || iter > 10_000_000 {
		return false, false
	}
	enc := base64.RawURLEncoding
	salt, err1 := enc.DecodeString(parts[1])
	want, err2 := enc.DecodeString(parts[2])
	if err1 != nil || err2 != nil || len(want) == 0 {
		return false, false
	}
	got, err := pbkdf2.Key(sha256.New, typed, salt, iter, len(want))
	if err != nil {
		return false, false
	}
	return sameSecret(string(got), string(want)), iter < pwHashIter
}
