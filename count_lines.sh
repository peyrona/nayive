#!/usr/bin/env bash
# ==============================================================================
# Count Lines (not LoC) in files in this project.
# Counting is made per file type for: .html, .css, .js, .py and .go
# At end shows a table with the results.
# ==============================================================================

set -euo pipefail

# Run from the project root (the dir this script lives in).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Dirs to skip: vendored libraries, caches, per-user data, VCS.
PRUNE=(
    -name .git
    -o -name __pycache__
    -o -name node_modules
    -o -path './todeploy/apps/*/lib'      # vendored front-end libs (TinyMCE, FullCalendar, ...)
    -o -path './todeploy/homes'           # per-user data and files
    -o -path './todeploy/files'           # runtime file storage
    -o -path './todeploy/config'          # runtime config
    -o -path './server/go/vendor'         # vendored Go module (x/text), not ours
)

EXTS=(html css js py go)

printf '%-8s %10s %14s\n' "Type" "Files" "Lines"
printf '%-8s %10s %14s\n' "----" "-----" "-----"

total_files=0
total_lines=0

for ext in "${EXTS[@]}"; do
    files=0
    lines=0
    while IFS= read -r -d '' f; do
        n=$(wc -l < "$f")
        files=$((files + 1))
        lines=$((lines + n))
    done < <(find . \( "${PRUNE[@]}" \) -prune -o -type f -name "*.${ext}" -print0)

    printf '%-8s %10d %14d\n' ".${ext}" "$files" "$lines"
    total_files=$((total_files + files))
    total_lines=$((total_lines + lines))
done

printf '%-8s %10s %14s\n' "----" "-----" "-----"
printf '%-8s %10d %14d\n' "TOTAL" "$total_files" "$total_lines"
