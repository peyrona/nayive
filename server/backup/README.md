# server/

Scripts that run **on the VPS** (not part of `deploy.sh`, which only rsyncs `apps/`).
Copy them to `~/server/` (the VPS user's home) by hand and wire them into a **systemd timer**
(system units in `/etc/systemd/system/`, `Type=oneshot`, `User=<the VPS user>`).

## check_ics.sh — REMOVED (2026-08-31)

The "event about to start" reminder is now done **inside the server**
(`server/go/reminders.go`, a background goroutine) — no cron, no state file. It sends a
native OS notification via Web Push; each user turns it on per device from "Mi cuenta"
in the launcher, and the subscriptions live in `homes/<user>/data/push.json`. See
[../docs/web-push.md](../docs/web-push.md).

`check_ics.sh`, `check-ics.service` and `check-ics.timer` were deleted. On the VPS,
once redeployed:

```
sudo systemctl disable --now check-ics.timer
sudo rm /etc/systemd/system/check-ics.{service,timer} ~/server/check_ics.sh
sudo systemctl daemon-reload
```

## backup_nayive.sh

Daily off-site backup. At 01:30 it zips everything the users create as
`yyyy-mm-dd_hh-mm_nayive_backup.zip` and copies it to Google Drive with **rclone**.
Paths are relative to the nayive run-root (`~/nayive` on the VPS):

- the whole **`homes/`** tree — every user's `data/` (calendar / tasks /
  contacts / trips / their `config.json`) and `files/` (all calc / write / text
  documents)
- **`config/server.json`** — admin name+password, port, TLS paths, so a restore
  is complete without rebuilding it by hand

Each user's `.trash/` papelera is **skipped**. The apps (`apps/`) are not backed
up — they come from the repo via `deploy.sh`.

Keeps 3 days of zips locally and 60 days on Drive; failures are written to
`backup_nayive.log` (there is no alert channel any more). Hostinger's weekly VPS
backup is the real safety net — this is the extra copy of just the user data.

The zip includes all of `config/`, **`config/vapid.json` especially**: that is the
Web Push signing key, and losing it silently invalidates every device's
notifications with no error anywhere.

Ships with `backup-nayive.service` + `backup-nayive.timer`.

### Install

**A. On your PC** (it has a browser) — set up rclone once:

```
sudo apt install -y rclone
rclone config
    n  -> name: gdrive  -> storage: drive
    client_id / client_secret: <blank>
    scope: 3            (drive.file — rclone only sees files it creates)
    Edit advanced: n
    Use auto config: y  (browser opens -> pick account -> Allow;
                         click through the "unverified app" warning)
    Shared Drive: n  ->  keep remote: y  ->  q
rclone mkdir gdrive:nayive-backups
```

**B. Push everything to the VPS** (from the `nayive/` repo dir):

```
. ./deploy.local.sh            # REMOTE_USER, REMOTE_HOST, REMOTE_PORT
VPS="$REMOTE_USER@$REMOTE_HOST"
ssh -p "$REMOTE_PORT" "$VPS" 'mkdir -p ~/server ~/.config/rclone'
scp -P "$REMOTE_PORT" server/backup_nayive.sh                       "$VPS":~/server/
scp -P "$REMOTE_PORT" server/backup-nayive.service server/backup-nayive.timer  "$VPS":/tmp/
scp -P "$REMOTE_PORT" ~/.config/rclone/rclone.conf                "$VPS":~/.config/rclone/
```

**C. On the VPS:**

```
ssh -p "$REMOTE_PORT" "$VPS"
sudo apt install -y zip rclone
chmod 600 ~/.config/rclone/rclone.conf
chmod +x  ~/server/backup_nayive.sh
timedatectl | grep 'Time zone'          # want Europe/Madrid; if not:
#   sudo timedatectl set-timezone Europe/Madrid

~/server/backup_nayive.sh                 # real test run
cat ~/server/backup_nayive.log            # expect an "OK: ..." line
rclone ls gdrive:nayive-backups           # expect <date>_nayive_backup.zip

sed -i "s/YOUR_USER/$USER/g" /tmp/backup-nayive.service   # the unit ships with a placeholder
sudo mv /tmp/backup-nayive.service /tmp/backup-nayive.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now backup-nayive.timer
systemctl list-timers backup-nayive.timer   # NEXT = tomorrow 01:30
```

Later checks: `journalctl -u backup-nayive.service` or `~/server/backup_nayive.log`.
Failures are logged there and nowhere else — check the log if a backup matters.

Config (paths, remote, retention) is at the top of the script.
