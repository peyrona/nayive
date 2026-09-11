# apps/write/lib/superdoc — vendored SuperDoc 2 bundle

Produced once, by hand, and committed here as pinned vendored files (same policy as
`apps/write/lib/tinymce`). **Nothing in `deploy.sh` builds this.** Rebuild only when
bumping SuperDoc.

## Pinned versions (last build 2026-08-28)

| package | version |
|---|---|
| `superdoc` | 2.10.0 |
| `@superdoc/docx-engine` (transitive, **proprietary** — see `DOCX-ENGINE-LICENSE.md`) | 0.9.0 |
| `yjs` (bundled in — MIT; `superdoc.es.js` statically imports it) | 13.6.32 |
| `esbuild` (build tool only) | 0.28.2 |

## Why a build step at all

`superdoc@2` ships only a bundler-oriented ESM entry (`dist/superdoc.es.js`) that
externalises `vue`, `pinia`, `konva`, `@superdoc/docx-engine`, `yjs`, code-split chunks,
etc. Its `dist-cdn/superdoc.min.js` is not self-contained either — it fetches
`docx-engine.es.js` from a remote CDN at runtime. Neither is usable under Nayive's
"no build, no external hosts, works offline" rules. So we bundle it ourselves, once.

## Files here

| file | what |
|---|---|
| `superdoc.min.js` | the whole editor + `@superdoc/docx-engine` + vue + pinia + konva + yjs, one ESM file (~10.7 MB / ~3.1 MB gz) |
| `assets/browser-worker-entry-Jt3Z1Jtz.js` | DOCX-engine Web Worker (edit). Loaded at runtime via `new URL('./assets/…', import.meta.url)` **or** the `__SUPERDOC_V2_BROWSER_WORKER_URL__` global. ~7.8 MB / ~2 MB gz |
| `assets/review-index-worker-entry--TnQQT8x.js` | DOCX-engine Web Worker (track-changes review sidecar). ~0.15 MB gz |
| `superdoc.css` | `superdoc/dist/style.css` verbatim |
| `engine.css` | `@superdoc/docx-engine/dist/style.css` verbatim |
| `@superdoc/docx-engine/style.css` | same file again, at the literal path the engine resolves at runtime relative to `superdoc.min.js` |
| `.peer-stub.js` | Proxy stub aliased in for the optional peers we don't use (`pdfjs-dist`, `@hocuspocus/provider`, `@liveblocks/*`, `react`). Reference copy — esbuild already inlined it. |
| `DOCX-ENGINE-LICENSE.md` | the proprietary licence the transitive engine is under. Keep it. |

The worker file name has a content hash — **if it changes on a rebuild, update the
`__SUPERDOC_V2_BROWSER_WORKER_URL__` line in `apps/write/index.html`.**
`tools/check-superdoc-worker.py` compares the two and aborts `deploy.sh` when they
disagree, so a forgotten update fails the build instead of the editor.

(The bundle *does* resolve the worker on its own through `import.meta.url` — verified
headless on 2026-09-08, the app boots fine with the global removed — but the pin is kept
because BUILD.md's original reason, hosts where that resolution drifts, still stands.)

## Rebuild

```sh
# from repo root
tools/build-superdoc.sh            # writes apps/write/lib/superdoc/
```

or by hand:

```sh
mkdir -p /tmp/sd && cd /tmp/sd
npm init -y
npm i superdoc@2.10.0 yjs@^13.6.19 esbuild@0.28.2
printf "export * from 'superdoc';\n" > entry.js
cat > stub.js <<'JS'
const h = new Proxy(function(){}, { get: () => h, apply: () => h, construct: () => h });
export default h;
export { h as HocuspocusProvider, h as WebsocketProvider, h as Awareness,
         h as LiveblocksYjsProvider, h as createClient, h as getDocument, h as GlobalWorkerOptions };
JS
DST=<repo>/apps/write/lib/superdoc
mkdir -p "$DST/assets" "$DST/@superdoc/docx-engine"
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
cp node_modules/@superdoc/docx-engine/dist/assets/browser-worker-entry-*.js       "$DST/assets/"
cp node_modules/@superdoc/docx-engine/dist/assets/review-index-worker-entry-*.js  "$DST/assets/"
cp node_modules/@superdoc/docx-engine/dist/DOCX-ENGINE-LICENSE.md "$DST/"
cp stub.js "$DST/.peer-stub.js"
```

## Phase 0 verification (2026-08-28, headless Chromium)

- mounts on a blank DOCX, full toolbar renders, page canvas is paper-white
- `superdoc.export({ exportType:['docx'], triggerDownload:false })` → valid `.docx`
  (ZIP magic `50 4b 03 04`, well-formed parts, inserted text present)
- `onEditorUpdate` / `superdoc.on('editor-update')` fire on edits
- custom `proofing.provider` renders red squiggles (`kind: 'spelling' | 'grammar' | 'style'`)
- **zero external network requests** — fully offline once vendored
