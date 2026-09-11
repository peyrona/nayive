# Nayive

Personal web apps you host yourself: Drive, Planner (calendar, tasks and habits),
Contacts, Write, Calc, Text, Photos, Music, Movies, Trips, Split and Games.

![The Nayive launcher](docs/launcher.png)

- One static Go binary (`server/go/`) serves the apps and a small JSON file API.
- Multi-user. Each user's data is plain files (`.ics`, `.vcf`, `.json`) in their own folder.
- No database, no framework, no build step for the apps.
- Installable as a PWA, with native notifications (Web Push).

## Install

```sh
./pack.sh                 # builds nayive.zip (needs Go 1.24+ and zip)
unzip nayive.zip -d nayive
cd nayive
./install.sh              # writes config/server.json and a systemd unit
```

Then open `http://localhost:4343/nayive/admin.html` and create the admin account.

## Run from source

```sh
cp todeploy/config/server.example.json todeploy/config/server.json
mkdir -p todeploy/homes
cd server/go
go run . -config ../../todeploy/config/server.json   # http://localhost:4343/nayive/
```

## Deploy to your own server

```sh
cp deploy.local.sh.example deploy.local.sh   # your VPS user, host and SSH port
./deploy.sh
```

## Layout

| Folder | What it holds |
|---|---|
| `server/go/` | the server (Go) |
| `todeploy/` | the run-root: `apps/` is what the browser loads |
| `tools/` | build and check helpers (Go) |
| `docs/` | design notes, one per app — start at [docs/README.md](docs/README.md) |

## License

[Apache 2.0](LICENSE)
