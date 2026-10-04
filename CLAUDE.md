# Nayive - rules for Claude

## Sealed CRUD code (data safety)

Every file that writes, moves or deletes user data starts with a `SEALED` line
(`grep -rl "SEALED - a user-data write path" server client` lists them; the
full list with functions and tests is docs/sealed-crud.md, kept local).

Before changing a sealed file:
1. Say so first, and why.
2. Keep the change minimal.
3. Afterwards run `node tools/data-safety-test/run.mjs` - it must end ALL GREEN.
   (`deploy.sh` runs it too, through tools/prebuild.sh.)

New code that writes user data goes through the sealed helpers
(shared/store.js, shared/gum-api.js, shared/office.js; server upload.go,
trash.go, sandbox.go), never around them, and gets a `ds-*` test.
