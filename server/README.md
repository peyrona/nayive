# `server/` - the server's SOURCE

Nothing in this folder is ever deployed or run from where it sits.

    server/
    ├── go/       the server (Go; see docs/go-port.md)
    └── backup/   the systemd unit + script that back the VPS up nightly

The distinction this folder exists to make:

| | what it is | what lives in it |
|---|---|---|
| `server/` | **source** | code you edit |
| `client/` | **the run-root** | exactly what runs, locally and on the VPS |

`client/` is rsynced to the VPS as-is and the server runs *inside* it, so
anything put there is deployed - and the admin's Drive is rooted there, so it
also shows up as a folder in the Drive app. Source code belongs in neither.

The server derives its run-root from the path of `config/server.json`
(`-config`, default `config/server.json`): the run-root is the folder above
`config/`. So its source lives here and only the built binary ever goes near
`client/`. (The Python server, which had to live inside `client/`, was
removed on 2026-09-11.)

## Running it locally

```sh
export PATH=$HOME/sdk/go1.27.1/bin:$PATH
cd server/go
go run . -config ../../client/config/server.json   # http://localhost:4343/nayive/
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
