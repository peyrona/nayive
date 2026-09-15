#!/usr/bin/env bash
# ==============================================================================
# run.local — start the Nayive Go server on this machine
# ==============================================================================
# Runs server/go/ with store/ as the run-root and client/apps as the apps (see
# server/README.md) and opens http://localhost:4343/nayive/ in Chromium once
# the server answers (port set in store/config/server.json). Ctrl+C stops it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:4343/nayive/"
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
exec go run . -config "$ROOT/store/config/server.json"
