# Nayive

Personal web apps you host yourself: Drive, Planner (calendar, tasks and habits),
eMail, Chat (with calls), Office (Write, Calc, Text), Records (Contacts, Bookmarks,
Passwords), Photos, Music, Movies, Trips, Split and Games.

<p align="center"><img src=".github/launcher.png" alt="The Nayive launcher" width="340"></p>

- One static Go binary (`server/go/`) serves the apps and a small JSON file API.
- Multi-user. Each user's data is plain files (`.ics`, `.vcf`, `.json`) in their own folder.
- No database, no framework, no build step for the apps.
- Installable as a PWA, with native notifications (Web Push).
- A desktop mode on big screens: windows, a task bar, tiling.
- An Android app (`android/`) for location sharing and photo upload.

## Install

```sh
./pack.sh                 # builds nayive.zip (needs Go 1.27+ and zip)
unzip nayive.zip -d nayive
cd nayive
./install.sh              # writes store/config/server.json and a systemd unit
```

Then open `http://localhost:4343/nayive/admin.html` and create the admin account.

## Run from source

```sh
mkdir -p store/config store/homes
cp store/config/server.example.json store/config/server.json
cd server/go
go run . -config ../../store/config/server.json   # http://localhost:4343/nayive/
```

## Write's editor bundle

Write is built on [docx-editor.dev](https://github.com/eigenpal/docx-editor)
(`@docx-editor.dev/core`, Apache-2.0, with metric-compatible OFL fonts). The bundle
**is** in this repository, so a clone needs nothing extra. To rebuild it, or move to
a newer release (needs `node` + `npm`; nothing is installed globally):

```sh
tools/build-docx-editor.sh            # rebuild the pinned version
tools/build-docx-editor.sh 2.21.0     # bump
tools/build-docx-editor.sh --restore  # put the previous build back
```

The version, every bundled package and a sha256 per file live in
`client/apps/write/lib/docx-editor/docx-editor.lock.json`;
`tools/check-docx-editor` holds the folder to it on every deploy. See
`client/apps/write/lib/docx-editor/BUILD.md`.

## Deploy to your own server

```sh
cp deploy.local.sh.example deploy.local.sh   # your VPS user, host and SSH port
./deploy.sh
```

## Layout

| Folder | What it holds |
|---|---|
| `server/go/` | the server (Go) |
| `client/` | `apps/`: what the browser loads |
| `store/` | the run-root: settings and every user's data (git-ignored) |
| `tools/` | build and check helpers (Go) |

## License

[Apache 2.0](LICENSE)
