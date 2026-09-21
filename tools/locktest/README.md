# `tools/locktest` — the locked-document tests

What `shared/crypt.js` and the padlock in `shared/office.js` promise is that **no plaintext byte
ever leaves the browser** for a protected document. That is a claim about bytes, so the tests
check bytes: what lands in the "server", in the `.bak` beside it, in the papelera and in the
device draft.

```
node tools/locktest/run.mjs
```

Needs Node 18+ (global `fetch` and `WebSocket`) and `/usr/bin/chromium` (or Chrome). Nothing to
install. Exits non-zero on the first failing check, so it drops straight into a CI step or a
pre-deploy habit.

## How it works

- `serve.mjs` serves `client/apps/` on a 127.0.0.1 port the OS picks. It has to be a real HTTP
  origin: `crypto.subtle` does not exist in a `file://` page, and `shared/` only resolves from
  the apps root.
- `page.html` is copied in as `client/apps/_locktest.html` for the run and **deleted afterwards**
  (a `finally`), so a test page can never be rsynced to the VPS.
- `cdp.mjs` launches a headless Chromium and talks the DevTools protocol to it — no Puppeteer,
  no Playwright, no `node_modules`.
- The page stubs only `GumApi` and `NayiveStore`, with an in-memory server, `.bak/` and papelera.
  Everything above them — `crypt.js`, `office.js`, `ui.js`, the real sheets — is the shipping code.
  The tests answer the real password dialog by typing into `#askPw1` and clicking the real button.

## What is covered (69 checks)

| | |
|---|---|
| both body forms | bytes for Write/Calc (`NAYIVE-LOCK-BIN`), base64 for Text, whose store keeps text |
| round trips | lock → reopen → the content back byte for byte, accents and all |
| wrong password | asks again; cancelling does NOT put the document on screen |
| the `.bak` | sealed while locked, and put back in the clear by the key that is about to be dropped |
| the device draft | sealed in IndexedDB; a cancelled password asks before throwing it away |
| imports | a locked file opened from `?import=` stays locked and untitled |
| the warning | a document with a past warns first; a brand-new one goes straight to the password |
| "Copia limpia" | new name, old file **and its `.bak`** deleted and taken out of the papelera |
| the guards | cancel changes nothing; an abandoned clean copy never wipes on a later save-as |

## If you add to it

`page.html` holds the fake server and the helpers (`typePassword`, `pressTitled`, `clickConfirm`,
`dropDrafts`); `run.mjs` holds the checks. Two things bite:

- **Every session wires the same buttons.** `newSession()` replaces the wired nodes with clones of
  themselves first, or the previous test's session answers your click too.
- **Never `indexedDB.deleteDatabase`.** `office.js` keeps its drafts connection open, so a delete
  blocks and never settles. `dropDrafts()` clears the object store through an ordinary transaction.
