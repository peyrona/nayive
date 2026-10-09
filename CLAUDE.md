# Nayive - rules for Claude

## Sealed CRUD code (data safety)

Every file that writes, moves or deletes user data starts with a `SEALED` line
(`grep -rl "SEALED - a user-data write path" server client` lists them; the
full list with functions and tests is docs/sealed-crud.md, kept local).

The seal guards the DATA CODE inside the file, not every line of it. Many
sealed files also hold help, labels and layout. What decides is the diff.

**Data change** - the full rule applies. The diff touches anything that can
change what reaches disk or the server, or when:
- a sealed function (docs/sealed-crud.md) or code that calls one;
- save / upload / move / copy / delete / rename / bin / restore / undo logic;
- file names, paths, ids, versions, conflict checks, outbox, cache, retries,
  autosave timing, error handling around a write;
- server handlers, store.js, gum-api.js, office.js, upload.go, trash.go, sandbox.go;
- renaming, removing or re-ordering shared names that data code uses.

**Not a data change** - no data-safety run. The diff touches only help text,
i18n strings, labels, tooltips, icons, CSS, comments, or layout that calls no
data code. Say in one line at the end: "sealed file, help/UI only - no
data-safety run".

**When unsure, it is a data change.**

For a data change:
1. Say so first, and why.
2. Keep the change minimal.
3. NEVER run the data-safety suite yourself. At the end, tell him he has to run
   `node tools/data-safety-test/run.mjs` - it must end ALL GREEN.
   (`deploy.sh --all-tests` and `pack.sh` run it too: never launch those either;
   plain `deploy.sh` skips it.)
4. Several data changes in one task: tell him once, at the end.

New code that writes user data goes through the sealed helpers
(shared/store.js, shared/gum-api.js, shared/office.js; server upload.go,
trash.go, sandbox.go), never around them, and gets a `ds-*` test.
