# `tools/bookmarks-test` — the Bookmarks app in a real browser

```
node tools/bookmarks-test/run.mjs                       # the committed fixtures
node tools/bookmarks-test/run.mjs ~/my-chrome-export.html   # + your own exports (never commit them)
```

Needs Node 18+, Go (`GO=/path/to/go` if it is not on the PATH), `/usr/bin/chromium` and the
internet (page titles and site icons are fetched for real). Exits non-zero when a check fails.

What it does: builds `server/go` into a scratch run-root under `/tmp` (its own config, one user
`test`, a `cp -a` copy of `client/apps`), starts it on a free port, drives headless Chromium over
the DevTools protocol (`../cdp.mjs`), then deletes the run-root. The real `store/` is
never touched. Screenshots stay in `/tmp/bookmarks-shots-*` (the path is printed).

Covered: empty screen · add / edit, title autofill (domain, then the page's own), duplicate
note, `javascript:` refused · folders, Move to…, a folder into its own subfolder refused · drag
onto tree rows, folder cards and crumbs · **tree reorder** (top / bottom edge of a row = before /
after, an open folder's bottom edge = first inside, own-subfolder refused, cards only go inside,
the order is saved) · open, tag chip, search, the × that replaces the magnifier, Esc, Ctrl+/ ·
delete + Undo · import of the Chrome- and Firefox-shaped fixtures (TAGS, `<DD>`, a folder's list
inside its `<DD>`, `place:` / `javascript:` skipped, microsecond dates) · export → import gives
the same counts · duplicates + Undo · Replace all + Undo · selection · filters, list / grid ·
site icons over the initials, no icon keeps the initial · dark · 375 and 320 px phones · touch
long-press · the help card · offline reload from the service worker · no console errors · **Phase B
(docs/audit/bookmarks.md)**: host:port addresses, script links however spelled (typed,
imported, opened), Undo of only what went, note lines through export → import, whole-tag
chips, the filed copy kept, unknown dates, not-read screen + edits, quiet no-op moves, the
late page title, tree keys, open-folder pruning, Add-import Undo, emptied folders removed,
export into a Nayive folder, a save merged with another device's change (the file written
behind the page's back; the 412 in the console is expected), `?add=` and a dropped link.

`fixtures/` holds made-up exports of public sites only.
