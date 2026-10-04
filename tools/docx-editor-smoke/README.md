# `tools/docx-editor-smoke` — the gate for a new docx-editor.dev release

Runs a folder of real `.docx` files through the **vendored** engine
(`client/apps/write/lib/docx-editor/`), headless,
and prints what was kept and what was lost. After
`tools/build-docx-editor.sh <new version>` the numbers must be the same as with
the previous version, or better — otherwise `tools/build-docx-editor.sh --restore`.

```sh
CORPUS=<folder of .docx> node tools/docx-editor-smoke/smoke.mjs          # every file
CORPUS=<folder of .docx> node tools/docx-editor-smoke/smoke.mjs Report   # names containing "Report"
CORPUS=<folder of .docx> node tools/docx-editor-smoke/serve.mjs          # by hand: open the printed URL, ?f=<name>
```

Needs Chromium, Go (for zipdiff), pandoc and poppler-utils (`pdfinfo`, `pdftotext`).
The files in `CORPUS` are only read; everything written goes to a temp folder
that is removed at the end (`KEEP=1` keeps it, `JSON=<file>` dumps every row).
`tools/` is never deployed.

## What it checks, per file

1. **Open** — and compare what the `.docx` holds (read straight from the zip)
   with what was painted: header, footer, a live page number, a paragraph fill,
   a watermark; and whether the layout used real font metrics (the packaged
   fonts and the HarfBuzz wasm were found beside the bundle).
2. **Save untouched** — the two zips compared part by part by *meaning*
   (`zipdiff/`: the engine re-serialises every XML part, so bytes always
   differ), plus an integrity check (undeclared `mc:Ignorable` prefixes, broken
   relationships) and pandoc's reading of the text.
3. **Type and save** — Spanish typed at the start with real key events; pandoc
   must read the old text plus exactly that, and only one block may change.
4. **Print** — to PDF: the page count equals the screen's, and the text is real.
5. **Spell-check ids** — what Write's spell-check overlay relies on: a painted
   span's `data-paragraph-id` + `data-start` locate the same word that
   `findMatches()` returns (`TextMatch.blockId` / `.start`).

The yardstick is always the file itself or pandoc, never another editor — and
never SuperDoc: its engine licence (§1.6) forbids using its behaviour or output
to build a replacement.

## Files

| file | what it is |
|---|---|
| `smoke.mjs` | the run and the table |
| `serve.mjs` | the repo over HTTP, `/engine/` = the vendored engine, `/corpus/` = `CORPUS` |
| `index.html` + `page.js` | the engine alone on a page, loaded by the names in its lock file; open / save / print by hand |
| `zipdiff/` | two `.docx` compared part by part by meaning, and the integrity check (Go; `go -C tools run ./docx-editor-smoke/zipdiff a.docx b.docx`) |

## Results

| date | version | open | save untouched | type + save | print | real metrics | spell-check ids |
|---|---|---|---|---|---|---|---|
| 2026-09-18 | 2.20.0 | 34/35 | 34/34 | 34/34 | 34/34 | 34/34 | 719/719 |
| 2026-09-18 | 2.21.0 | 34/35 | 34/34 | 34/34 | 34/34 | 34/34 | 719/719 |

The one file that does not open carries a non-XML extra part (Synology Office's
`synoDoc.xml`); the engine refuses the whole file (`parse-error: /synoDoc.xml`).
