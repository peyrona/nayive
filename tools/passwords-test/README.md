# `tools/passwords-test` — the Passwords app in real browsers

```
node tools/passwords-test/run.mjs
```

Needs Node 24 (`crypto.argon2Sync`), Go (`GO=/path/to/go` if it is not on the PATH, or
`~/sdk/go1.27.1`), Chromium and the internet (the leak check asks api.pwnedpasswords.com).
Exits non-zero when a check fails. Screenshots stay in `/tmp/passwords-shots-*` (printed).

It uses the data-safety harness (`../data-safety-test/lib.mjs`): a scratch server built from
`server/go` with its own run-root in `/tmp` (users `test` and `ana`), headless Chromium over the
DevTools protocol. The real `store/` is never touched.

Covered: the vendored Argon2id against RFC 9106 (SIMD and plain builds) · set-up rules (short,
pattern, typed differently, leaked) · the reminder phrase (every word of the master password refused,
some of them warned; sealed with the Nayive password, which the server checks first; Node opens
it on its own; the lock screen asks the Nayive password; Settings changes / re-seals / removes
it; a changed Nayive password; kept by a new master password; its own part in the merge) · the recovery key's shape · entries through the
real sheet · **Node opens the file on its own** (Argon2id + HKDF + AES-GCM: a second
implementation of the format) · no password in the list, search never inside passwords ·
history, no-op saves, delete + Undo of a folder, favourites, move, a folder into itself ·
lock leaves nothing in the page · wrong passwords never write, the wait after five · auto-lock
(idle, screen locker) · the clipboard toast (the wipe itself only where headless Chromium has a
clipboard) · no secret in IndexedDB, localStorage, title, address, .bak · tampering (a byte, two
entries swapped, a weaker KDF, below the floor, a newer version) · two devices (add / add, edit /
edit, delete / edit) · two vaults made at once · change master password, recovery key, new
recovery key · CSV imports (Chrome, KeePassXC with groups, Bitwarden with fields and notes),
duplicates, encrypted backup round trip, CSV export behind the master password · generator
statistics and word list · no exception, no CSP violation, no request but its server + HIBP ·
phone and dark screenshots.

The same data-safety properties are in `../data-safety-test/ds-passwords.mjs` (the suite).
