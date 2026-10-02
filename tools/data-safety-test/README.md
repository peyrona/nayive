# `tools/data-safety-test` — user work is never lost

```
node tools/data-safety-test/run.mjs            # the whole suite (Go + browser)
node tools/data-safety-test/run.mjs office     # browser tests whose file name holds "office"
node tools/data-safety-test/run.mjs --go-only  # only the Go tests
```

Needs Go (`GO=/path/to/go`, default `~/sdk/go1.27.1/bin/go`) and `/usr/bin/chromium`. Nothing of the
real `store/` is touched: every test builds `server/go` into a scratch run-root in `/tmp`.

This suite guards every path that writes, moves or deletes user data (the "sealed" code). It MUST be
green before and after any change to that code.

## Layout

- **Go:** `server/go/ds_<theme>_test.go`, functions `TestDS_<item>_<what>` (item = the line in the
  data-safety audit, e.g. `TestDS_F1_DamagedConfigNotRewritten`). `go test -run TestDS ./...`.
- **Browser:** `ds-<topic>.mjs` here, found by name (no list to keep). Each one:

```js
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
const s = await server();                 // user test/test (or { ana: "abc", beto: "xyz" })
const c = await browser( s );             // signed in; c.tab() opens a second tab
section( "TWO TABS" );
await c.open( "/nayive/text/?file=files/a.txt", "/nayive/text/" );
ok( await c.until( "..." ), "what it proves" );
await done( c, s );
```

`lib.mjs` also has `s.client()` (a second device over plain HTTP: get / put / post / del),
`until()` (wait for a condition — never a fixed sleep), `type()`, `click()` (a real mouse click) and
`onDisk()` (the file as the server holds it).
