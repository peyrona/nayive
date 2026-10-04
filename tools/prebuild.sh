# shellcheck shell=bash
# ==============================================================================
# prebuild.sh - what must pass or run before deploy.sh ships and before pack.sh
# zips. SOURCED by both, never run: it only fills PREBUILD_STEPS.
#
# Each entry is run from the repo root; a non-zero exit aborts the caller.
# deploy.sh appends its own Android step after these.
# ==============================================================================
PREBUILD_STEPS=(
    "cd server/go && test -z \"\$(gofmt -l .)\""   # formatting is not a matter of opinion
    "cd server/go && go vet ./..."                  # the built-in static analyser
    "cd server/go && go test ./..."                 # the whole suite (Go caches a pass: unchanged Go code = instant)
    "node tools/data-safety-test/run.mjs"       # the sealed CRUD code: user data is never lost (CLAUDE.md)
    "go -C tools run ./check-i18n"              # every dictionary must agree with es.json
    "go -C tools run ./check-docx-editor"       # the docx-editor.dev engine vs docx-editor.lock.json, and the refs to it
    "go -C tools run ./build-precache"          # refresh apps/sw.js: precache file list + CACHE_VERSION
    "go -C tools run ./build-gzip"              # .gz sidecar beside every text asset (server sends them as-is)
)
