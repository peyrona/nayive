#!/usr/bin/env bash
#
# pack.sh - build nayive.zip, the thing a person downloads to install nayive.
#
# The zip has  install.sh ,  nayive  (the server: one static Linux binary built
# from server/go/) and  apps/  at its top level (no wrapper folder). To install:
#
#     unzip nayive.zip -d nayive
#     cd nayive
#     ./install.sh
#
# The zip deliberately leaves OUT  config/  and  homes/  - install.sh makes
# those fresh, with an empty admin account.
#
# Usage:
#   ./pack.sh [output.zip]        default: ./nayive.zip
#
# Env:
#   GOARCH   CPU of the machine it will run on (default amd64; arm64 for a
#            Raspberry Pi 4/5 or an ARM VPS)
#
# Needs Go 1.24 or newer: ~/sdk/go1.27.1 is used when present, else `go` on the
# PATH (Ubuntu's apt golang is 1.18 - too old, never use it).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUT="${1:-nayive.zip}"
SRC="todeploy"                       # the server run-root inside the repo
GOSRC="server/go"                    # the Go server's source

if [ -x "$HOME/sdk/go1.27.1/bin/go" ]; then
    export PATH="$HOME/sdk/go1.27.1/bin:$PATH"
fi
command -v go  >/dev/null || { echo "error: 'go' not found (install Go 1.24+ in ~/sdk, not from apt)" >&2; exit 1; }
command -v zip >/dev/null || { echo "error: 'zip' is not installed (sudo apt install zip)" >&2; exit 1; }
[[ -f "$GOSRC/go.mod" ]] || { echo "error: $GOSRC/go.mod not found" >&2; exit 1; }
[[ -d "$SRC/apps"     ]] || { echo "error: $SRC/apps not found"     >&2; exit 1; }
[[ -f install.sh      ]] || { echo "error: install.sh not found"    >&2; exit 1; }

# Refresh generated files (apps/sw.js precache list, .gz sidecars).
for helper in build-precache build-gzip; do
    echo "==> pre-build: $helper"
    go -C tools run "./$helper" >/dev/null
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Same build as deploy.sh: static (no libc), reproducible, no network.
echo "==> building the server (linux/${GOARCH:-amd64})"
( cd "$GOSRC" && CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" GOPROXY=off \
    go build -trimpath -ldflags='-s -w' -o "$STAGE/nayive" . )

cp    install.sh       "$STAGE/install.sh"
cp -r "$SRC/apps"      "$STAGE/apps"
chmod +x "$STAGE/install.sh" "$STAGE/nayive"

# Drop things that must not ship:
#  - editor / OS cruft
#  - per-user data written live on a running server (never in a fresh install)
#  - .bak snapshot folders
find "$STAGE" \( -name '*~' -o -name '*.swp' -o -name '*.swo' -o -name '.DS_Store' \) -delete
find "$STAGE/apps" \( -name 'calendar.ics' -o -name 'contacts.vcf' \
        -o -name 'contacts-meta.json' -o -name 'tasks.json' \) -delete
find "$STAGE" -type d -name '.bak' -exec rm -rf {} + 2>/dev/null || true

OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
rm -f "$OUT_ABS"
( cd "$STAGE" && zip -qr "$OUT_ABS" . -x '.*' )

echo "wrote $OUT_ABS  ($(du -h "$OUT_ABS" | cut -f1))"
echo
echo "contents (top level):"
( cd "$STAGE" && find . -maxdepth 1 -mindepth 1 | sed 's|^\./|  |' | sort )
