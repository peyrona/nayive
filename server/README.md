# `server/` - the server's SOURCE

Nothing in this folder is ever deployed or run from where it sits.

    server/
    └── go/       the server (Go; see docs/go-port.md)

The distinction the top folders make:

| | what it is | what lives in it |
|---|---|---|
| `server/` | **source** | code you edit |
| `client/` | **the apps** | `apps/`, what the browser loads - rsynced to the VPS |
| `store/` | **the run-root** | everything the server writes: `config/`, `homes/`, and the admin's `data/`, `.trash/`, `.thumbs/` |

Code and data never share a folder: a deploy only ever writes `client/apps/`,
and nothing the server writes lands there.

The server derives its run-root from the path of `config/server.json`
(`-config`, default `config/server.json`): the run-root is the folder above
`config/`. With `store/config/server.json` it runs *inside* `store/`, and the
admin's Drive is rooted there. The apps are found through `"apps_dir"` in the
same file (`"../client/apps"`; when it is unset, `apps/` inside the run-root).
(The Python server, which had to live inside the run-root, was removed on
2026-09-11.)

## Running it locally

```sh
export PATH=$HOME/sdk/go1.27.1/bin:$PATH
cd server/go
go run . -config ../../store/config/server.json   # http://localhost:4343/nayive/
```

## Building the Go server

```sh
export PATH=$HOME/sdk/go1.27.1/bin:$PATH
cd server/go
go test -race ./...
go build -o nayive .
```

Cross-compiling for the VPS (x86_64 Linux, no libc needed):

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o nayive .
```

See `docs/go-port.md` for the port itself.
