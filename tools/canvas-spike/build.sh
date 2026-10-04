#!/usr/bin/env bash
# Build the Canvas-Editor bundle this spike runs on.
#
#     tools/canvas-spike/build.sh              la version fijada abajo
#     tools/canvas-spike/build.sh 1.2.0        otra version del editor
#     tools/canvas-spike/build.sh 1.2.0 1.1.0  y otra del plugin docx
#
# La evaluacion quedo aparcada el 17-09-2026 esperando a que el proyecto madure
# (sacan version cada dos semanas). Para retomarla: una version nueva aqui,
# smoke.mjs, y mirar si los dos fallos del README siguen ahi.
#
# Needs node + npm. Throwaway workdir, nothing installed globally, nothing
# outside tools/canvas-spike/ is touched - in particular NOT client/apps/write/.
#
# WHAT THIS IS FOR
#   A spike, not a migration. Write rode SuperDoc then (docx-editor.dev since 09-21), whose DOCX engine is
#   proprietary (so the bundle cannot live in this public repo) and weighs
#   10.7 MB + a 7.8 MB worker. Canvas-Editor is MIT and its official docx
#   plugin is MIT too. This builds them so the question can be answered by
#   opening real files instead of by reading READMEs.
#
# TWO THINGS THAT MAKE THIS SIMPLER THAN THE OLD build-superdoc.sh (deleted)
#
#   * Canvas-Editor inlines its four web workers as `data:` URLs, so there is
#     no worker file to ship and no __WORKER_URL__ pin to rewrite. (The Go
#     server sends no Content-Security-Policy - middleware.go says so on
#     purpose - so `data:` workers are allowed. If a CSP is ever added it
#     needs `worker-src data:`.)
#   * There is no CSS. The editor paints into a <canvas>.
#
# ONE THING THAT IS THE SAME
#   The docx plugin pulls in docx.js, which calls require("buffer") in the
#   `else` branch of `typeof atob == "function"` - dead code in a browser.
#   esbuild cannot know that, so it is aliased to buffer-stub.js, the same
#   trick as the old SuperDoc build's .peer-stub.js.
set -euo pipefail

HERE="$( cd "$( dirname "$0" )" && pwd )"

EDITOR_VERSION="${1:-1.0.3}"      # exact on purpose, as the old build-superdoc.sh did
DOCX_VERSION="${2:-1.0.0}"        # its peerDependency says >=0.9.42; 1.0.3 installs clean
ESBUILD_VERSION="0.28.2"    # the version build-docx-editor.sh uses

OUT="$HERE/lib/canvas-editor_v${EDITOR_VERSION}.min.js"
WORK="$( mktemp -d /tmp/canvas-spike-build.XXXXXX )"
trap 'rm -rf "$WORK"' EXIT

command -v npm >/dev/null || { echo "canvas-spike: npm not found" >&2; exit 1; }

echo "canvas-spike: installing canvas-editor $EDITOR_VERSION + docx plugin $DOCX_VERSION ..."
cd "$WORK"
printf '{ "name": "canvas-spike", "private": true, "type": "module" }\n' > package.json
npm install --silent --no-audit --no-fund \
    "@hufe921/canvas-editor@$EDITOR_VERSION" \
    "@hufe921/canvas-editor-plugin-docx@$DOCX_VERSION" \
    "esbuild@$ESBUILD_VERSION"

# One entry point re-exporting everything the spike page needs, so the page
# imports from a single file and esbuild can tree-shake the rest.
cat > entry.js <<'JS'
import Editor, { ElementType, EditorZone, PaperDirection, RowFlex, ListType, ListStyle } from '@hufe921/canvas-editor'
import docxPlugin from '@hufe921/canvas-editor-plugin-docx'
export { Editor, ElementType, EditorZone, PaperDirection, RowFlex, ListType, ListStyle, docxPlugin }
export default Editor
JS

./node_modules/.bin/esbuild entry.js \
    --bundle --format=esm --minify --target=es2022 \
    --alias:buffer="$HERE/buffer-stub.js" \
    --outfile="$OUT" \
    --log-level=warning

# spike.js importa el bundle por su nombre, que lleva la version dentro - la
# misma convencion que build-docx-editor.sh, y el mismo motivo para reescribirla
# aqui en vez de dejarla a mano.
sed -i -E "s|\./lib/canvas-editor_v[0-9.]+\.min\.js|./lib/canvas-editor_v${EDITOR_VERSION}.min.js|" "$HERE/spike.js"
ls "$HERE/lib/"canvas-editor_v*.min.js 2>/dev/null | grep -v "_v${EDITOR_VERSION}.min.js" | xargs -r rm -f

printf 'canvas-spike: %s\n  %s raw, %s gzipped\n' \
    "$( basename "$OUT" )" \
    "$( du -h "$OUT" | cut -f1 )" \
    "$( gzip -c "$OUT" | wc -c | awk '{ printf "%.0f KB", $1 / 1024 }' )"
