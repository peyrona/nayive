#!/usr/bin/env bash
#
# pack.sh - build nayive.zip, the thing a person downloads to install nayive.
#
# The zip mirrors the repo (no wrapper folder):
#
#     install.sh
#     client/apps/         what the browser loads
#     server/go/nayive     the server: one static Linux binary built from server/go/
#     store/config/server.example.json   what install.sh turns into server.json
#
# To install:
#
#     unzip nayive.zip -d nayive
#     cd nayive
#     ./install.sh
#
# The zip deliberately leaves OUT the rest of  store/  (config/ and homes/) -
# install.sh makes it fresh from the example, with an empty admin account.
#
# Usage:
#   ./pack.sh [output.zip]        default: ./nayive.zip
#
# Env:
#   GOARCH   CPU of the machine it will run on (default amd64; arm64 for a
#            Raspberry Pi 4/5 or an ARM VPS)
#
# Needs Go 1.27.1 or newer: ~/sdk/go1.27.1 is used when present, else `go` on the
# PATH (Ubuntu's apt golang is 1.18 - too old, never use it).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUT="${1:-nayive.zip}"
SRC="client"                       # the apps: client/apps/ (the run-root is store/)
GOSRC="server/go"                    # the Go server's source
EXAMPLE="store/config/server.example.json"

if [ -x "$HOME/sdk/go1.27.1/bin/go" ]; then
    export PATH="$HOME/sdk/go1.27.1/bin:$PATH"
fi
command -v go  >/dev/null || { echo "error: 'go' not found (install Go 1.27.1+ in ~/sdk, not from apt)" >&2; exit 1; }
command -v zip >/dev/null || { echo "error: 'zip' is not installed (sudo apt install zip)" >&2; exit 1; }
[[ -f "$GOSRC/go.mod" ]] || { echo "error: $GOSRC/go.mod not found" >&2; exit 1; }
[[ -d "$SRC/apps"     ]] || { echo "error: $SRC/apps not found"     >&2; exit 1; }
[[ -f install.sh      ]] || { echo "error: install.sh not found"    >&2; exit 1; }
[[ -f $EXAMPLE        ]] || { echo "error: $EXAMPLE not found"      >&2; exit 1; }

# The same checks and generated files as deploy.sh (gofmt, vet, tests,
# check-i18n, check-docx-editor, sw.js, .gz) - one list, tools/prebuild.sh.
# shellcheck source=tools/prebuild.sh
. tools/prebuild.sh
for step in "${PREBUILD_STEPS[@]}"; do
    echo "==> pre-build: $step"
    ( eval "$step" ) || { echo "error: pre-build step failed: $step" >&2; exit 1; }
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Same build as deploy.sh: static (no libc), reproducible, no network.
echo "==> building the server (linux/${GOARCH:-amd64})"
mkdir -p "$STAGE/$GOSRC" "$STAGE/$SRC"
( cd "$GOSRC" && CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" GOPROXY=off \
    go build -trimpath -ldflags='-s -w' -o "$STAGE/$GOSRC/nayive" . )

cp    install.sh       "$STAGE/install.sh"
cp -r "$SRC/apps"      "$STAGE/$SRC/apps"
mkdir -p "$STAGE/$(dirname "$EXAMPLE")"
cp    "$EXAMPLE"       "$STAGE/$EXAMPLE"
chmod +x "$STAGE/install.sh" "$STAGE/$GOSRC/nayive"

# Drop things that must not ship:
#  - editor / OS cruft
#  - every dot path, at any depth (.bak snapshots, write/lib/.docx-editor-prev/):
#    zip's -x '.*' below matches only the top level
find "$STAGE" \( -name '*~' -o -name '*.swp' -o -name '*.swo' -o -name '.DS_Store' \) -delete
find "$STAGE" -mindepth 1 -name '.*' -prune -exec rm -rf {} +
OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
rm -f "$OUT_ABS"
( cd "$STAGE" && zip -qr "$OUT_ABS" . -x '.*' )

echo "wrote $OUT_ABS  ($(du -h "$OUT_ABS" | cut -f1))"
echo
echo "contents:"
( cd "$STAGE" && find . -maxdepth 3 -mindepth 1 ! -path "./$SRC/apps/*" | sed 's|^\./|  |' | sort )
