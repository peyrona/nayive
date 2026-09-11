#!/usr/bin/env bash
# ==============================================================================
# deploy — Nayive (personal cloud apps), GO server
# ==============================================================================
# Pushes two things to the VPS:
#
#   1. the server         server/go/  -> built here into ONE static Linux binary
#                         -> ${REMOTE_BASE}/nayive
#      (no Python, no apt packages: `go build` needs no network, the only
#       dependency is vendored - see docs/go-port.md)
#   2. the apps           todeploy/apps/  -> ${REMOTE_BASE}/apps/
#      (calc, calendar, contact, drive, habits, planner, tasks, text, trips, write,
#       index.html launcher, login.html, admin.html and the shared/ code every
#       app loads — theme, store, gum-api, ui, ical; see docs/shared-modules.md)
#
# The Python server was removed from this repo and from the VPS on 2026-09-11;
# there is no Python rollback any more.
#
# config/ and homes/ are NEVER touched — those hold live server settings and the
# per-user data written by the running server.
#
# THE SERVICE MUST ALREADY RUN THE BINARY. /etc/systemd/system/nayive.service
# (the same unit install.sh writes) has, in [Service]:
#
#   ExecStart=/home/<user>/nayive/nayive -config /home/<user>/nayive/config/server.json
#   AmbientCapabilities=CAP_NET_BIND_SERVICE
#
# Changing the unit needs sudo, so it is never done here.
#
# ffmpeg MUST BE INSTALLED ON THE VPS for Drive's "convert uploaded videos to
# MP4" (server/go/convert.go). Also a one-time, by-hand step (sudo):
#
#   sudo apt install ffmpeg
#
# Without it the server still runs; the startup log says "video conversion OFF"
# and Drive never offers the conversion. See docs/avi-to-mp4.md.
#
# LibreOffice is the same kind of by-hand step, for Drive's .odt/.ods ->
# .docx/.xlsx conversion (server/go/office.go):
#
#   sudo apt install --no-install-recommends libreoffice-writer-nogui libreoffice-calc-nogui
#
# Without it the log says "LibreOffice conversion OFF" and Drive uploads those
# files as they are. Installed on the VPS 2026-09-11.
#
# If the service does not run the binary, this script copies it but does NOT
# restart anything, and prints what to change instead.
#
# If the binary actually changed, the deploy restarts the service:
#   ssh ... sudo systemctl restart nayive.service
# (needs passwordless sudo for that unit, or an interactive password prompt).
# The build is reproducible (-trimpath), so an unchanged server/go/ gives the
# same bytes and no restart. Pushing only apps/ changes needs no restart either
# — the server serves them as static files.
#
# Before anything is copied, the Go code must pass gofmt, go vet and its whole
# test suite; any failure aborts the deploy. A few generated app files
# (apps/sw.js's precache list, the .gz sidecars) are refreshed too. All of it is
# in the PRE-BUILD section below — add any new must-run-every-deploy step there,
# nowhere else.
#
# Usage:
#   ./deploy.sh          Pre-build + build + rsync. No questions.
#   ./deploy.sh -y       The same thing (kept so an old habit still works).
#   ./deploy.sh --help   Print this header.
#
# Needs Go 1.24 or newer: ~/sdk/go1.27.1 is used when present, else `go` on the
# PATH (Ubuntu's apt golang is 1.18 — too old, never use it).
#
# REMOTE_USER, REMOTE_HOST and REMOTE_PORT are private, so they live in
# deploy.local.sh, which git ignores. Copy deploy.local.sh.example to make it.
#
# Needs working SSH auth for ${REMOTE_USER}@${REMOTE_HOST} on port ${REMOTE_PORT};
# if the key is not installed yet, run once:
#   ssh-copy-id -p ${REMOTE_PORT} ${REMOTE_USER}@${REMOTE_HOST}
#
# Hidden/editor files (.*, *~, *.swp) are excluded from
# apps/, and so are the per-app USER-DATA files (calendar.ics, contacts.vcf,
# contacts-meta.json, tasks.json) — those are written live on the server and
# must never be overwritten by a stale local copy.
# Additive: files removed locally are NOT deleted on the server.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# REMOTE_USER, REMOTE_HOST, REMOTE_PORT - private, never in the repo.
LOCAL_CFG="$SCRIPT_DIR/deploy.local.sh"
[ -f "$LOCAL_CFG" ] || { echo "ERROR: $LOCAL_CFG not found - copy deploy.local.sh.example and fill it in." >&2; exit 1; }
# shellcheck source=/dev/null
. "$LOCAL_CFG"
: "${REMOTE_USER:?set it in deploy.local.sh}" "${REMOTE_HOST:?set it in deploy.local.sh}" "${REMOTE_PORT:?set it in deploy.local.sh}"
REMOTE_BASE="/home/${REMOTE_USER}/nayive" # the server run-root on the VPS
REMOTE_APPS_DIR="$REMOTE_BASE/apps"
REMOTE_BIN="$REMOTE_BASE/nayive"          # the Go binary on the VPS
SERVICE="nayive.service"

SRC_ROOT="$SCRIPT_DIR/todeploy"             # the server run-root in the repo
APPSSRC="$SRC_ROOT/apps"
GOSRC="$SCRIPT_DIR/server/go"               # the Go server's source

SSH_OPTS=(-p "$REMOTE_PORT" -o StrictHostKeyChecking=accept-new)
RSYNC_RSH="ssh -p $REMOTE_PORT -o StrictHostKeyChecking=accept-new"

# No confirmation prompt: running this script IS the confirmation. `-y` / `--yes`
# are still accepted so an old habit or an alias does not fail, but they change
# nothing.
case "${1:-}" in
    -y|--yes)  ;;
    "")        ;;
    -h|--help) grep -E '^# ' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         echo "Unknown option: $1 (use -y | --yes | --help)" >&2; exit 2 ;;
esac

command -v rsync >/dev/null 2>&1 || { echo "ERROR: 'rsync' not found (needed to deploy)." >&2; exit 1; }

# The Go toolchain: the official tarball in ~/sdk first, then whatever is on PATH.
if [ -x "$HOME/sdk/go1.27.1/bin/go" ]; then
    export PATH="$HOME/sdk/go1.27.1/bin:$PATH"
fi
command -v go >/dev/null 2>&1 || { echo "ERROR: 'go' not found (install Go 1.24+ in ~/sdk, not from apt)." >&2; exit 1; }

[ -d "$APPSSRC" ]        || { echo "ERROR: local apps source not found: $APPSSRC" >&2; exit 1; }
[ -f "$GOSRC/go.mod" ]   || { echo "ERROR: Go server source not found: $GOSRC" >&2; exit 1; }

echo "==> Deploying  server/go/ + $APPSSRC/  ->  $REMOTE_USER@$REMOTE_HOST:$REMOTE_BASE/"
echo "==> Using $(go version)"

# ------------------------------------------------------------------------------
# PRE-BUILD — everything that MUST pass or run on every deploy.
# Each entry is run from $SCRIPT_DIR; a non-zero exit aborts the deploy.
# Add any further must-run-every-deploy step to this list.
# ------------------------------------------------------------------------------
PREBUILD_STEPS=(
    "cd server/go && test -z \"\$(gofmt -l .)\""   # formatting is not a matter of opinion
    "cd server/go && go vet ./..."                  # the built-in static analyser
    "cd server/go && go test -count=1 ./..."        # the whole suite, incl. the RFC 8291 push vector
    "go -C tools run ./check-i18n"              # every dictionary must agree with es.json
    "go -C tools run ./check-superdoc-worker"   # write/index.html's pinned worker hash vs the file on disk
    "go -C tools run ./build-precache"          # refresh apps/sw.js: precache file list + CACHE_VERSION
    "go -C tools run ./build-gzip"              # .gz sidecar beside every text asset (server sends them as-is)
)

for step in "${PREBUILD_STEPS[@]}"; do
    echo "==> pre-build: $step"
    ( cd "$SCRIPT_DIR" && eval "$step" ) || { echo "ERROR: pre-build step failed: $step" >&2; exit 1; }
done

# ------------------------------------------------------------------------------
# BUILD — one static Linux binary, into a temp folder (never into the repo).
# CGO_ENABLED=0: no libc, so it runs on the VPS whatever its glibc. -trimpath:
# no local paths inside, which also makes the build reproducible. GOPROXY=off:
# proves the vendored dependency is enough - no network, ever.
# The VPS is x86_64 (check: ssh ... uname -m).
# ------------------------------------------------------------------------------
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
echo "==> Building the Go server (linux/amd64)"
( cd "$GOSRC" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOPROXY=off \
    go build -trimpath -ldflags='-s -w' -o "$BUILD_DIR/nayive" . ) \
    || { echo "ERROR: go build failed." >&2; exit 1; }
echo "==> Built $(du -h "$BUILD_DIR/nayive" | cut -f1) binary"

# Fail fast with a helpful hint if SSH auth / the remote dirs aren't ready.
ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" "test -d '$REMOTE_BASE' && test -d '$REMOTE_APPS_DIR'" \
    || { echo "ERROR: remote run-root not found or SSH auth failed: $REMOTE_BASE"                  >&2
         echo "       Install nayive there first (unzip nayive.zip -d nayive && ./install.sh),"      >&2
         echo "       and if the key isn't installed yet: ssh-copy-id -p $REMOTE_PORT $REMOTE_USER@$REMOTE_HOST" >&2
         exit 1; }

# ------------------------------------------------------------------------------
# 1. Server — the binary -> $REMOTE_BIN
# -c: compare by CHECKSUM, so an identical build is not re-sent and triggers no
# restart. No -t on purpose: every build has a fresh mtime, and with -t rsync
# would "update" that time on an identical binary, report it as a change and
# restart for nothing. rsync writes to a temp name and renames it into place, so the
# running server keeps its own (old) copy until the restart below - replacing
# a running binary this way is safe on Linux.
# --chmod=F755: executable, whatever the local umask made of it.
# ------------------------------------------------------------------------------
echo "==> Deploying the server binary  ->  $REMOTE_USER@$REMOTE_HOST:$REMOTE_BIN"
if ! BIN_CHANGES="$(rsync -zc --chmod=F755 --itemize-changes \
        -e "$RSYNC_RSH" \
        "$BUILD_DIR/nayive" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_BIN")"; then
    echo "ERROR: binary rsync to $REMOTE_USER@$REMOTE_HOST:$REMOTE_BIN failed." >&2
    exit 1
fi
[ -n "$BIN_CHANGES" ] && printf '%s\n' "$BIN_CHANGES"

# ------------------------------------------------------------------------------
# 2. Apps — todeploy/apps/ -> $REMOTE_APPS_DIR/  (recursive, additive)
# -rltz: recurse, keep symlinks + mtimes, compress; no owner/group/perms.
# ------------------------------------------------------------------------------
echo "==> Deploying apps  $APPSSRC/  ->  $REMOTE_USER@$REMOTE_HOST:$REMOTE_APPS_DIR/"
if ! rsync -rltz --itemize-changes \
      --exclude='.*' --exclude='*~' --exclude='*.swp' \
      --exclude='calendar.ics' --exclude='contacts.vcf' --exclude='contacts-meta.json' --exclude='tasks.json' \
      -e "$RSYNC_RSH" \
      "$APPSSRC/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_APPS_DIR/"; then
    echo "ERROR: apps rsync to $REMOTE_USER@$REMOTE_HOST:$REMOTE_APPS_DIR/ failed." >&2
    exit 1
fi

# Stamp the launcher's build date: the local apps/index.html always ships the
# literal "ver.yy-mm-dd" (bottom-right corner); replace it with today's date on
# the server so the local file stays a clean template.
STAMP="ver.$(date +%y-%m-%d)"
echo "==> Stamping launcher version: $STAMP"
# The stamp rewrites index.html, so its .gz sidecar (built locally, before the
# stamp) is now older than the file and the server would ignore it: rebuild it
# on the VPS. `gzip -k` keeps the original; -f overwrites the old sidecar.
ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" \
    "sed -i 's/ver\\.yy-mm-dd/$STAMP/' '$REMOTE_APPS_DIR/index.html' && gzip -kf9 '$REMOTE_APPS_DIR/index.html'" \
    || { echo "ERROR: could not stamp the launcher version on the server." >&2; exit 1; }

# ------------------------------------------------------------------------------
# Restart the service only if the binary actually changed (apps/ alone is
# static and needs no restart) - and only if the service really runs it.
# ------------------------------------------------------------------------------
if [ -z "$BIN_CHANGES" ]; then
    echo "==> Server binary unchanged — service not restarted."
elif ! ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" \
        "systemctl show -p ExecStart '$SERVICE' | grep -qF '$REMOTE_BIN '"; then
    echo "==> NOT restarted: $SERVICE does not run $REMOTE_BIN."                  >&2
    echo "    The binary is in place. On the VPS, set in /etc/systemd/system/$SERVICE:" >&2
    echo "      ExecStart=$REMOTE_BIN -config $REMOTE_BASE/config/server.json"      >&2
    echo "      AmbientCapabilities=CAP_NET_BIND_SERVICE"                           >&2
    echo "    then: sudo systemctl daemon-reload && sudo systemctl restart $SERVICE" >&2
else
    echo "==> Server binary changed — restarting $SERVICE"
    # -t: allocate a remote TTY so 'sudo' can prompt for a password if this user
    # doesn't have passwordless sudo for the unit. To skip the prompt entirely,
    # on the VPS: echo "$REMOTE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE, /usr/bin/systemctl status $SERVICE" | sudo tee /etc/sudoers.d/nayive
    ssh -t "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" \
        "sudo systemctl restart '$SERVICE' && systemctl --no-pager --lines=0 status '$SERVICE'" \
        || { echo "ERROR: could not restart $SERVICE — restart it by hand:" >&2
             echo "       ssh -t -p $REMOTE_PORT $REMOTE_USER@$REMOTE_HOST sudo systemctl restart $SERVICE" >&2
             exit 1; }
fi

echo "==> Deploy complete."
