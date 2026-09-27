# `tools/email-test` — the eMail app in a real browser

```
node tools/email-test/run.mjs
```

Needs Go (`GO=/path/to/go`, default `~/sdk/go1.27.1/bin/go`) and Chromium. Nothing to install,
no internet, nothing of the real `store/` touched.

## How it works

- `go test -run TestMailE2EServe` (`server/go/mail_e2e_test.go`) serves a whole Nayive — the real
  `client/apps` — on a free port, with the user `ana` / `abc` and one mail account on go-imap's
  in-memory IMAP server. The SMTP is a fake that keeps what is "sent". A few `/e2e/...` routes let
  the driver make draft saves slow or fail, read what was sent, and see which "pictures" were
  fetched and whether they carried the session cookie.
- `run.mjs` drives headless Chromium over the DevTools protocol (`tools/locktest/cdp.mjs`).
- Screenshots go to a temp folder, named at the end of the run.

## What is covered (61 checks)

The clip's panel (Chat's, three choices), the writer (a file added during a save, a failed save
keeps the text, Discard + Undo, Bcc), the message frame (no allow-same-origin, sized by its own
script, its own pictures as `data:`, nothing sent with the session cookie after "Show pictures",
links in a new tab), files (their real size, Save to Nayive), picking (select all, delete for good
+ Undo), settings (new password, "always show pictures"), a start without the server, and sign-out
by POST.
