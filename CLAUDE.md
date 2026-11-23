# Nayive - rules for Claude

## Ayni is the source of the UI (FUNDAMENTAL)

Nayive USES Ayni (github.com/peyrona/ayni); it does not own a copy of it.
`client/apps/shared/ayni/` IS the Ayni repo (a git submodule; ~/proyectos/ayni
is a symlink to it), never a fork. Every UI change (controls, styles, icons,
Ayni i18n keys, anything in shared/ayni/) may be built and tested in Nayive,
but once it works it is committed in Ayni in the same task, before it is
called done, and Nayive records that commit (`git add client/apps/shared/ayni`).
`tools/check-ayni.sh` (in the pre-build) fails while Ayni has uncommitted
changes or Nayive records another Ayni commit. Ayni's own rules:
client/apps/shared/ayni/CLAUDE.md. A fresh clone needs
`git submodule update --init`.

## Sealed CRUD code (data safety)

Every file that writes, moves or deletes user data starts with a `SEALED` line,
or a `DATA:` line in `client/apps/shared/ayni/` (Ayni is public: ayni-net.js, ayni-store.js, ayni-doc.js,
ayni-vault.js, ayni-deskpage.js and formats/ical.js are sealed code too)
(`grep -rlE "SEALED - a user-data write path|^// DATA:" server client` lists them; the
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
(shared/ayni/ayni-store.js, shared/ayni/ayni-net.js, shared/ayni/ayni-doc.js; server upload.go,
trash.go, sandbox.go), never around them, and gets a `ds-*` test.
