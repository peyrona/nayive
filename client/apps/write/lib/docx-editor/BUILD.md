# `lib/docx-editor` — the vendored docx-editor.dev engine

Write's editor: `@docx-editor.dev/core` (Apache-2.0) with its packaged fonts
(`@docx-editor.dev/fonts`, OFL / GUST). Built by `tools/build-docx-editor.sh`,
**kept in git** (every file here is under an open licence), and described by
`docx-editor.lock.json`. The paid part, `@docx-editor.dev/pro` (comments,
tracked changes, collaboration), is never installed: its licence forbids
production use.

## Build or bump

```sh
tools/build-docx-editor.sh            # rebuild the version in docx-editor.lock.json
tools/build-docx-editor.sh 2.21.0     # bump
tools/build-docx-editor.sh --restore  # put the previous build back
```

Needs `node` + `npm`. It uses a throwaway workdir and installs nothing globally.
The script owns every step:

- installs core, fonts and i18n at **exactly** the same version (core asks for
  i18n with a caret) and refuses a build where npm resolved anything else;
- generates the entry module, bundles it with esbuild, and writes the lock file:
  the versions, every npm package that went into the bundle, a sha256 per file;
- names every file after the version — `docx-editor_v2.20.0.min.js`,
  `harfbuzz_v2.20.0.wasm`, `fonts_v2.20.0/` — because the server sends a
  year-long `immutable` header for everything under `lib/`;
- stops if a bundled package carries a licence outside its allowed list, and
  writes `THIRD_PARTY_NOTICES.md` with each package's licence text;
- rewrites `write.js`'s import and `index.html`'s `<link>` (once they exist);
- keeps the outgoing build in `lib/.docx-editor-prev/` (git-ignored) for `--restore`;
- refreshes `sw.js`'s precache list and the `.gz` sidecars.

`tools/check-docx-editor` (run by `deploy.sh`) holds this folder to the lock file.

## What is here

| file | what it is |
|---|---|
| `docx-editor_v<ver>.min.js` | the engine + the entry below, one ES module |
| `docx-editor_v<ver>.css` | the engine's stylesheet (no `url()` inside) |
| `harfbuzz_v<ver>.wasm` | the text shaper: Word-accurate line breaks |
| `fonts_v<ver>/` | Carlito, Caladea, Liberation…, the metric twins of Word's fonts, with their licences |
| `LICENSE`, `licenses/` | the core's Apache licence, HarfBuzz's, the core's own notices |
| `THIRD_PARTY_NOTICES.md` | generated: every package in the bundle and its licence |
| `docx-editor.lock.json` | generated: versions, packages, hashes |
| `BUILD.md` | this file (hand-written, not hashed) |

The entry exports only the public API Write uses: `createDocxEditor`,
`blankDocumentBytes`, `runToolbarCommand`, `toolbarCommandState(s)`,
`CHROME_MENUS`, `applyTableChromePick`, `runTableChromeCommand`,
`executeImageCommand` + `canExecuteImageCommand` (an image insert is async and
`exec` refuses it), `setHarfBuzzWasmUrl` and `packagedFonts` - plus `unzipSync`, `zipSync`,
`strFromU8`, `strToU8` from fflate, the zip library the engine bundles anyway
(docx-patch.js uses them where the engine has no command). Importing it points HarfBuzz at
`harfbuzz_v<ver>.wasm`; its `packagedFonts()` fetches from `fonts_v<ver>/`.
Both resolve against the bundle's own URL, so a page only imports the bundle.

**Fonts are fetched on demand** (his choice, 2026-09-18): only the families a
document names, and they are NOT in the service worker's precache. Offline, a
document whose fonts were never fetched lays out with the engine's estimated
metrics — line and page breaks off until back online. Precached: the bundle,
the stylesheet and the wasm.

## Taking a new release

1. Read the release notes (github.com/eigenpal/docx-editor/releases). Check the
   features Write uses are still in the Apache core, not moved to `pro`.
2. `tools/build-docx-editor.sh <new>`
3. `CORPUS=<folder of .docx> node tools/docx-editor-smoke/smoke.mjs` — the same
   numbers or better, or `--restore`.
4. Walk `quirks.js`: delete what the new release fixed.
5. Add a row below.

## Versions

| date | docx-editor.dev | note |
|---|---|---|
| 2026-09-18 | 2.20.0 | first build (plan Phase 0); smoke: 34/35 open, 34/34 saves same, 34/34 type+save, 34/34 print |
| 2026-09-18 | 2.21.0 | content controls, one undo step per formatting gesture, page borders, empty-paragraph formatting kept; smoke: same numbers, same page counts |
