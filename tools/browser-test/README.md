# `tools/browser-test` — the item browser in every list app

```
node tools/browser-test/run.mjs          # every app
node tools/browser-test/run.mjs drive    # only drive.mjs
```

Checks the shared item browser (`client/apps/shared/browser.js`, docs/item-browser-plan.md) the way a
person uses it: real mouse clicks (Ctrl / Shift), keys, right-click, the header that fits (every action a
button when wide; on a phone the top ranks plus the one ⋮, `fitState`), drag onto the tree, and a phone
(touch: tap opens, long-press picks). Each `<app>.mjs` builds its own scratch server
through `../data-safety-test/lib.mjs` (user test/test, a `cp -a` copy of client/apps); nothing of the
real `store/` is touched. Every delete is checked on disk, and its Undo too.

`lib.mjs` adds the input helpers: `mouse`, `key`, `finger`, `drag`, `menuRows`, `fitState`, `seed`, `exists`.
