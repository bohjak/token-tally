# Installation — ToTally

This document covers the full install, update, and uninstall lifecycle for
ToTally. For the quick-start, see the [README](../README.md).

---

## Prerequisites

| Requirement | Version | How to install |
|---|---|---|
| macOS | 13 or later | — |
| Command Line Tools / Xcode | current | `xcode-select --install` |
| Node.js | ≥ 20 | `n lts` or [nodejs.org](https://nodejs.org) |
| pnpm | any | `npm install -g pnpm` |
| SQLite | bundled with macOS | — |

The installer checks for Node.js and pnpm and prints a clear error if either is
missing. The Swift build requires Command Line Tools or full Xcode.

---

## Installing

```sh
git clone https://github.com/<owner>/token-tally
cd token-tally
make install
```

The installer is a thin Make target that calls `scripts/install.sh`. It runs
each component in order:

1. **Store & CLI** — installs pnpm workspace dependencies, builds the
   `@token-tally/store` TypeScript package, links the `token-tally` binary
   globally via pnpm, and creates or migrates the central database.

2. **Tray app** — builds `clients/macos-tray` in release mode, assembles
   `ToTally.app`, installs it atomically to `/Applications/ToTally.app`, and
   launches it. The app registers itself as a login item on first launch
   (see [Launch at login](#launch-at-login)).

3. **Pi integration** — creates two symlinks under
   `~/.pi/agent/extensions/`:
   - `token-tally-writer` → `<repo>/harnesses/pi/writer-extension`
   - `token-tally-usage` → `<repo>/clients/pi-usage-command`

4. **Manifest** — writes `~/.config/token-tally/install.json` with the
   repo path, component status, database path, and schema version.

A failure in step 1 (store) aborts the run — it is the foundation. Failures in
steps 2 or 3 are reported and printed, but the other components still complete.

### Directories created

```text
~/.local/share/token-tally/           # analytics database and spool files
~/.local/share/token-tally/spool/     # NDJSON write-ahead spool
~/.config/token-tally/                # config and install manifest
~/.local/state/token-tally/logs/      # log files
```

Where `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`, or `$XDG_STATE_HOME` are set, those
prefixes are honoured instead of `~/.local/share`, `~/.config`, and
`~/.local/state`.

---

## Updating

`make install` is the update mechanism. After pulling new commits:

```sh
git pull
make install
```

The installer is fully idempotent:

- an already-migrated database is left unchanged unless there are new migrations
- the tray app is rebuilt and reinstalled (a running instance is quit first)
- extension symlinks are verified and recreated if pointing elsewhere
- the install manifest is updated with the new `updatedAt` timestamp

There is no separate `make update` command.

---

## Diagnostics

```sh
make doctor
```

Checks:

- `token-tally` binary is on PATH and resolves
- Central database is reachable and schema version is current
- `/Applications/ToTally.app` is installed and matches the manifest version
- Pi extension symlinks exist and point to the repo
- Install manifest is present

```sh
make test
```

Runs the Swift test suite (`swift test --package-path clients/macos-tray`) and
the store test suite once store tests are committed.

---

## Launch at login

`ToTally.app` registers itself as a login item on first launch using
`SMAppService`. Launch at login is **enabled by default**. To change it:

- Open the app and go to **Settings → Launch at login**, or
- Use `make uninstall` and skip re-installing the app.

When `make install` is re-run on a machine where the app is already installed,
the login-item state is not modified — existing preferences are preserved.

---

## If `/Applications` is not writable

If the current user cannot write to `/Applications`, the installer exits with a
clear error:

```
✗  /Applications is not writable.
   Re-run with elevated permissions or grant write access:
     sudo make install
```

ToTally does **not** silently fall back to `~/Applications`. The store CLI and
Pi extensions are still installed even when the tray step fails.

---

## Importing legacy Pi analytics data

If you previously used Pi's built-in analytics extension, historical data may
exist at:

```text
~/.pi/analytics/events.db
```

To import it into the central ToTally store:

```sh
token-tally import legacy-pi
```

The command:

- opens the legacy database **read-only** — it is never modified or deleted
- maps old schema rows to the central ToTally schema
- preserves cost provenance where the legacy data allows; uses `unknown` where
  it cannot
- is idempotent — running it again imports nothing new (delta = 0)
- records import metadata in `schema_metadata` so `make doctor` can surface it

Optional flags:

```sh
token-tally import legacy-pi \
  --source ~/.pi/analytics/events.db \   # default
  --db ~/.local/share/token-tally/events.db  # default
```

The installer **never runs this automatically**. It prints a notice if the
legacy database is detected and shows the command, but the import is always an
explicit user action.

---

## Uninstall

```sh
make uninstall
```

Default behaviour:

- Quits ToTally if it is running.
- Removes `/Applications/ToTally.app` (if installed by this repo).
- Removes Pi extension symlinks `~/.pi/agent/extensions/token-tally-*`.
- Removes the install manifest `~/.config/token-tally/install.json`.
- **Prints** the paths of user data but does **not** delete them.
- **Never touches** `~/.pi/analytics/events.db`.

### Keeping specific components

```sh
scripts/uninstall.sh --keep-app      # skip tray app removal
scripts/uninstall.sh --keep-pi       # skip Pi extension removal
```

### Removing analytics data (purge)

To also delete the analytics database, spool files, and logs:

```sh
scripts/uninstall.sh --purge
```

This asks for interactive confirmation before deleting. To skip the prompt:

```sh
scripts/uninstall.sh --purge --yes
```

Purge deletes:

```text
~/.local/share/token-tally/    # database and spool files
~/.local/state/token-tally/    # logs
```

It does **not** delete `~/.config/token-tally/` (config files) or the legacy
Pi database. Delete those manually if needed.

---

## Manual operations

### Migrate the database without re-installing

```sh
token-tally migrate
```

Safe to run repeatedly. Applies any pending schema migrations and exits.

### Drain spool files manually

If a writer crashed and left `.ndjson.closed` files unprocessed:

```sh
token-tally ingest
```

Drains all closed spool files from the default spool directory into the central
database. Pass a specific file path to drain a single file.

### Run the store doctor directly

```sh
token-tally doctor
token-tally doctor --json   # machine-readable; exits non-zero on anomalies
```

### Build the tray app without installing

```sh
swift build --package-path clients/macos-tray
swift test  --package-path clients/macos-tray
```

---

## Paths reference

| Path | Purpose |
|---|---|
| `~/.local/share/token-tally/events.db` | Central analytics database |
| `~/.local/share/token-tally/spool/` | NDJSON write-ahead spool |
| `~/.config/token-tally/install.json` | Install manifest |
| `~/.config/token-tally/config.json` | Runtime config (future) |
| `~/.local/state/token-tally/logs/` | Log files |
| `/Applications/ToTally.app` | macOS tray app |
| `~/.pi/agent/extensions/token-tally-writer` | Pi writer extension symlink |
| `~/.pi/agent/extensions/token-tally-usage` | Pi usage client symlink |

All paths honour the `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`, and
`$XDG_STATE_HOME` environment variables as prefixes where set.
