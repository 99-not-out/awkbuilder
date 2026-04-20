# awkbuilder

Local web UI for visually constructing, tracing, and verifying awk programs.

## Setup

Requires Go 1.26+.

```sh
go install github.com/99-not-out/awkbuilder@latest
```

Or from a clone:

```sh
git clone https://github.com/99-not-out/awkbuilder.git
cd awkbuilder
go build ./...
```

## Run

```sh
awkbuilder [flags] [files-or-globs...]
```

Flags:

- `-port N` — listen on port `N` (default `0` picks a free port)
- `-no-open` — don't auto-open the browser
- `-limit N` — cap records read per input file (default `0` = no cap)

Example with the bundled samples:

```sh
awkbuilder samples/access.log samples/users.csv
```

The server prints the URL it's bound to, and (unless `-no-open`) opens it in your default browser.
