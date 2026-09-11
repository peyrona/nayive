#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup_nayive.sh — daily off-site backup of everything the Nayive users create:
# zip it, then copy the zip to Google Drive with rclone.
#
# Runs ON THE VPS from a systemd timer (backup-nayive.timer -> OnCalendar=01:30).
#
# What goes in the zip (paths relative to the nayive run-root):
#   homes/               every user's data/ AND files/ —
#                          data/   calendar.ics, tasks.json, contacts.vcf,
#                                  contacts-meta.json, config.json,
#                                  trips/<trip>/trip.json
#                          files/  all calc / write / text documents
#   config/             admin name+password, port, TLS paths, and vapid.json —
#                          so a restore is complete without rebuilding it by
#                          hand. vapid.json especially: it is the Web Push
#                          signing key, and a lost one silently invalidates
#                          every device's notifications with no error anywhere.
#
# Each user's  .trash/  papelera (deleted-but-not-purged items) is EXCLUDED.
# The apps themselves (apps/) are not backed up — they come from the repo via
# deploy.sh.
#
# Zip name:  yyyy-mm-dd_hh-mm_nayive_backup.zip   e.g. 2026-09-01_01-30_nayive_backup.zip
#
# ---- One-time setup on the VPS ----------------------------------------------
#   sudo apt install -y zip rclone
#   rclone config
#       n) new remote            name> gdrive            storage> drive
#       scope> 3   (drive.file — rclone only ever sees files it created)
#       "Use auto config?" > n   (headless: it prints a URL — open it on your
#                                 laptop, approve, paste the token back)
#   rclone mkdir gdrive:nayive-backups
#   # then install backup-nayive.service + backup-nayive.timer (see server/README.md)
#
# The nayive run-root on the VPS is  ~/nayive  (deploy.sh REMOTE_BASE). $HOME is
# the VPS user's home: systemd sets it from User= in backup-nayive.service.
# ---------------------------------------------------------------------------
set -uo pipefail

# --- CONFIG ----------------------------------------------------------------
NAYIVE="$HOME/nayive"               # the server run-root (holds homes/ and config/)
REMOTE="gdrive:nayive-backups"        # rclone  remote:folder
WORKDIR="$HOME/server/backup-tmp"
LOG="$HOME/server/backup_nayive.log"
KEEP_LOCAL_DAYS=3                   # local zips kept this many days (safety net)
KEEP_REMOTE_DAYS=60                 # Drive zips deleted after this many days (0 = keep forever)
# -------------------------------------------------------------------------

log()  { printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

fail() {
    log "FAIL: $*"
    exit 1
}

STAMP="$(date +%F_%H-%M)"                       # 2026-09-01_01-30
ZIP="$WORKDIR/${STAMP}_nayive_backup.zip"

command -v zip    >/dev/null 2>&1 || fail "'zip' not installed (sudo apt install zip)"
command -v rclone >/dev/null 2>&1 || fail "'rclone' not installed (sudo apt install rclone)"
mkdir -p "$WORKDIR"
cd "$NAYIVE" 2>/dev/null || fail "nayive run-root not found: $NAYIVE"
[ -d homes ] || fail "no homes/ dir under $NAYIVE"

# Zip the whole homes/ tree + the server config, skipping every user's papelera.
# (homes/.trash/* also covers the admin trash if it ever lands there.)
zip -qrX "$ZIP" homes config \
    -x 'homes/*/.trash/*' 'homes/.trash/*' || fail "zip failed"
[ -s "$ZIP" ] || fail "zip is empty"

# Copy to Google Drive.
rclone copy "$ZIP" "$REMOTE" || fail "rclone upload failed"

log "OK: $(basename "$ZIP")  $(du -h "$ZIP" | cut -f1)"

# Retention — local and (optionally) remote.
find "$WORKDIR" -name '*_nayive_backup.zip' -mtime +"$KEEP_LOCAL_DAYS" -delete 2>/dev/null || true
[ "$KEEP_REMOTE_DAYS" -gt 0 ] && rclone delete --min-age "${KEEP_REMOTE_DAYS}d" "$REMOTE" 2>/dev/null || true

exit 0
