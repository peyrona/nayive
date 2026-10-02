#!/usr/bin/env bash
# ==============================================================================
# run.local — start the Nayive Go server on this machine
# ==============================================================================
# Runs server/go/ with store/ as the run-root and client/apps as the apps (see
# server/README.md) and opens http://localhost:<port>/nayive/ in Chromium once
# the server answers (the port is read from store/config/server.json; 4343 when
# it sets none). Ctrl+C stops it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$ROOT/store/config/server.json"
PORT="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$CFG" 2>/dev/null | grep -oE '[0-9]+$' || true)"
URL="http://localhost:${PORT:-4343}/nayive/"
export PATH="$HOME/sdk/go1.27.1/bin:$PATH"

# Wait (up to 60 s, go run compiles first) for the server, then open the browser.
(
    for _ in $(seq 1 60); do
        if curl -s -o /dev/null "$URL"; then
            chromium "$URL" > /dev/null 2>&1 &
            exit 0
        fi
        sleep 1
    done
    echo "[!] server did not answer at $URL - browser not opened" >&2
) &

cd "$ROOT/server/go"
exec go run . -config "$CFG"
