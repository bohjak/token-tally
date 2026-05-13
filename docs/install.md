# Installation — ToTally

This document covers the full install, update, and uninstall lifecycle for
ToTally. For the quick-start, see the [README](../README.md).

---

## Prerequisites

| Requirement | Version | How to install |
|---|---|---|
| macOS | 14 or later | — |
| Command Line Tools / Xcode | current | `xcode-select --install` |
| Node.js | ≥ 24 | `n lts` or [nodejs.org](https://nodejs.org) |
| pnpm | any | `npm install -g pnpm` |
| SQLite | bundled with macOS | — |

The installer checks for Node.js and pnpm and prints a clear error if either is
missing. The Swift build requires Command Line Tools or full Xcode; Swift tests
(`make test`) require full Xcode because they need `xctest`.

---

## Installing

```sh
git clone https://github.com/bohjak/token-tally
cd token-tally
make install
```

The installer is a thin Make target that calls `scripts/install.sh`. When run
from a terminal it first shows an interactive component picker so you can review
what will be installed and skip optional integrations. Use arrow keys to move,
Space to toggle an optional component, and Enter to install the selected set.

For unattended installs, run `scripts/install.sh --all` (or set
`TOKEN_TALLY_INSTALL_NO_TUI=1`) to skip the picker and use the default component
set. Non-interactive shells do the same. Optional harness integrations are not
offered or installed when their harness is not detected.

The installer then runs each selected component in order:

1. **Store & CLI** — installs pnpm workspace dependencies, builds the
   `@token-tally/store` TypeScript package, links the `token-tally` binary
   globally via pnpm, and creates or migrates the central database. The global
   binary location depends on your pnpm configuration (typically
   `~/.local/share/pnpm/` or `~/.pnpm/`).

2. **Tray app** — builds `clients/macos-tray` in release mode, assembles
   `ToTally.app`, stops any running instance, installs it atomically to
   `/Applications/ToTally.app`, and launches it. The app registers itself as a
   login item on first launch (see [Launch at login](#launch-at-login)).

3. **Pi integration** (optional) — if Pi is detected, creates two symlinks
   under `~/.pi/agent/extensions/`:
   - `token-tally-writer` → `<repo>/harnesses/pi/writer-extension`
   - `token-tally-usage` → `<repo>/clients/pi-usage-command`

   Pi is not required. The tray app and CLI work independently of any harness.

4. **Claude Code integration** (optional) — if Claude Code is detected, builds the
   Claude Code writer, symlinks `~/.local/bin/token-tally-claude-hook` to the
   compiled hook binary, and merges ToTally-owned hook commands into
   `~/.claude/settings.json`. The installer backs up an existing settings file
   before modifying it and preserves all non-ToTally hooks and settings.

5. **Cursor integration** (optional) — if Cursor is detected, builds the
   Cursor writer, symlinks `~/.local/bin/token-tally-cursor-hook` to the
   compiled hook binary, and merges ToTally-owned hook commands into
   `~/.cursor/hooks.json`. Cursor uses lower-camel event names and flat hook
   entries — the installer writes the native Cursor config shape, not the
   Claude Code settings format. The installer backs up an existing
   `hooks.json` before modifying it and preserves all non-ToTally hooks.

6. **Manifest** — writes `~/.config/token-tally/install.json` with the
   repo path, component status, database path, and schema version.

A failure in step 1 (store) aborts the run — it is the foundation and is always
installed. Failures in steps 2, 3, or 4 are reported and printed, but the other
selected components still complete. Skipped optional components are recorded as
not installed in the install summary and manifest.

### Gatekeeper and unsigned app

ToTally.app is not signed with an Apple Developer certificate. On first launch
macOS Gatekeeper may block it with a message like "ToTally cannot be opened
because the developer cannot be verified."

To allow it:

1. Open **System Settings → Privacy & Security**.
2. Scroll to the **Security** section.
3. Click **Open Anyway** next to the ToTally entry.

You only need to do this once.

### Directories created

```text
~/.local/share/token-tally/           # analytics database and spool files
~/.local/share/token-tally/spool/     # NDJSON write-ahead spool
~/.config/token-tally/                # config and install manifest
~/.local/state/token-tally/logs/      # log files
~/.local/state/token-tally/claude-code/ # Claude Code hook offsets/counters
~/.local/state/token-tally/cursor/    # Cursor hook session state files
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
- the tray app is rebuilt and reinstalled (a running instance is stopped first)
- extension symlinks are verified and recreated if pointing elsewhere
- Claude Code hook settings are re-merged idempotently
- Cursor hook settings are re-merged idempotently
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
- Pi extension symlinks exist and point to the repo (skipped if Pi is absent)
- Claude Code hook symlink and settings entries are present (skipped with warnings if Claude Code is absent)
- Cursor hook symlink and `hooks.json` entries are present (skipped with warnings if Cursor is absent)
- Install manifest is present

```sh
make test
```

Runs the store test suite, the Claude Code writer test suite, the Cursor
writer test suite, and the Swift tray test suite
(`swift test --package-path clients/macos-tray`).

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
✗  /Applications is not writable by the current user.
   Do NOT run 'sudo make install' — that runs the entire build chain as root.
```

ToTally does **not** silently fall back to `~/Applications`. The store CLI and
Pi extensions are still installed even when the tray step fails. To install the
already-built app bundle only, either copy it with administrator privileges or
open `clients/macos-tray/dist/` in Finder and drag `ToTally.app` into
`/Applications` when prompted.

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
- records import metadata in `schema_metadata` for diagnostics

Optional flags:

```sh
token-tally import legacy-pi \
  --source ~/.pi/analytics/events.db \   # default
  --db ~/.local/share/token-tally/events.db  # default
```

The installer **never runs this automatically**. The import is always an
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
- Removes the Claude Code hook symlink and ToTally-owned entries from
  `~/.claude/settings.json`.
- Removes the Cursor hook symlink and ToTally-owned entries from
  `~/.cursor/hooks.json`.
- Removes the install manifest `~/.config/token-tally/install.json`.
- **Prints** the paths of user data but does **not** delete them.
- **Never touches** `~/.pi/analytics/events.db`.

### Keeping specific components

```sh
scripts/uninstall.sh --keep-app          # skip tray app removal
scripts/uninstall.sh --keep-pi           # skip Pi extension removal
scripts/uninstall.sh --keep-claude-code  # skip Claude Code hook removal
scripts/uninstall.sh --keep-cursor       # skip Cursor hook removal
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

Safe to run repeatedly. Applies any pending schema migrations and exits. See
[`docs/schema.md`](schema.md) for the schema and versioning reference.

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
| `~/.local/bin/token-tally-cursor-hook` | Cursor hook binary symlink |
| `~/.local/state/token-tally/cursor/` | Cursor hook per-session state files |

All paths honour the `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`, and
`$XDG_STATE_HOME` environment variables as prefixes where set.
