#!/usr/bin/env bash
# Rebuild the vendored SuperDoc 2 bundle in apps/write/lib/superdoc/.
#
# Run BY HAND only, when bumping SuperDoc. deploy.sh never calls this.
# Needs: node + npm (uses a throwaway /tmp project; nothing installed globally).
#
# Usage:  tools/build-superdoc.sh [SUPERDOC_VERSION]
set -euo pipefail

SUPERDOC_VERSION="${1:-2.10.0}"
YJS_VERSION="^13.6.19"
ESBUILD_VERSION="0.28.2"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DST="$REPO/apps/write/lib/superdoc"
WORK="$(mktemp -d /tmp/build-superdoc.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "→ workdir $WORK"
cd "$WORK"
npm init -y >/dev/null
echo "→ installing superdoc@$SUPERDOC_VERSION (pulls vue, konva, pinia, @superdoc/docx-engine)…"
npm i --silent "superdoc@$SUPERDOC_VERSION" "yjs@$YJS_VERSION" "esbuild@$ESBUILD_VERSION"

printf "export * from 'superdoc';\n" > entry.js
cat > stub.js <<'JS'
const h = new Proxy(function(){}, { get: () => h, apply: () => h, construct: () => h });
export default h;
export { h as HocuspocusProvider, h as WebsocketProvider, h as Awareness,
         h as LiveblocksYjsProvider, h as createClient, h as getDocument, h as GlobalWorkerOptions };
JS

rm -rf "$DST"
mkdir -p "$DST/assets" "$DST/@superdoc/docx-engine"

echo "→ bundling…"
./node_modules/.bin/esbuild entry.js --bundle --format=esm --platform=browser --minify \
  --alias:pdfjs-dist=./stub.js --alias:@hocuspocus/provider=./stub.js \
  --alias:@liveblocks/client=./stub.js --alias:@liveblocks/yjs=./stub.js \
  --alias:react=./stub.js --alias:react-dom=./stub.js \
  --loader:.svg=text --loader:.png=dataurl --loader:.woff=dataurl \
  --loader:.woff2=dataurl --loader:.ttf=dataurl \
  --outfile="$DST/superdoc.min.js"

cp node_modules/superdoc/dist/style.css              "$DST/superdoc.css"
cp node_modules/@superdoc/docx-engine/dist/style.css "$DST/engine.css"
cp node_modules/@superdoc/docx-engine/dist/style.css "$DST/@superdoc/docx-engine/style.css"
cp node_modules/@superdoc/docx-engine/dist/assets/browser-worker-entry-*.js      "$DST/assets/"
cp node_modules/@superdoc/docx-engine/dist/assets/review-index-worker-entry-*.js "$DST/assets/"
cp node_modules/@superdoc/docx-engine/dist/DOCX-ENGINE-LICENSE.md "$DST/"
cp stub.js "$DST/.peer-stub.js"

WORKER="$(cd "$DST/assets" && ls browser-worker-entry-*.js)"
echo
echo "✓ built  $(du -sh "$DST" | cut -f1)  →  $DST"
echo "  superdoc      $(node -p "require('$WORK/node_modules/superdoc/package.json').version")"
echo "  docx-engine   $(node -p "require('$WORK/node_modules/@superdoc/docx-engine/package.json').version")  (proprietary)"
echo "  yjs           $(node -p "require('$WORK/node_modules/yjs/package.json').version")"
echo "  edit worker   $WORKER"
echo
echo "  If the worker filename changed, update __SUPERDOC_V2_BROWSER_WORKER_URL__ in apps/write/index.html"
echo "  Then update the version table in $DST/BUILD.md"
