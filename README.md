# ToTally

A local analytics platform for coding-agent harnesses. ToTally collects token
usage and cost data from agents like [Pi](https://github.com/j-bohacek/pi) into
a central SQLite database on your machine and shows a glanceable summary in the
macOS menu bar.

```
Σ 284k · $1.42
```

**All data stays local.** ToTally never transmits analytics data anywhere.

---

## Quick start

```sh
git clone https://github.com/<owner>/token-tally
cd token-tally
make install
```

`make install` builds and installs everything:

- creates the central database at `~/.local/share/token-tally/events.db`
- builds and installs `/Applications/ToTally.app`, then launches it
- registers the app as a login item (enabled by default; change in Settings)
- installs the Pi writer and usage-command extensions

Run `make doctor` to confirm everything is healthy.

### Updating

```sh
git pull
make install
```

`make install` is idempotent. Run it after every `git pull` — it migrates the
database, rebuilds the app, and updates extension symlinks automatically.

---

## Requirements

- **macOS 13 or later**
- **Command Line Tools for Xcode** (or full Xcode) — for the Swift build
- **Node.js ≥ 20** — for the store CLI
- **pnpm** — installed by `npm install -g pnpm` if absent

The installer checks for these and prints a clear error if anything is missing.

---

## What gets installed

| Component | Location |
|---|---|
| Central database | `~/.local/share/token-tally/events.db` |
| Tray app | `/Applications/ToTally.app` |
| Pi writer extension | `~/.pi/agent/extensions/token-tally-writer` → `<repo>/harnesses/pi/writer-extension` |
| Pi usage client | `~/.pi/agent/extensions/token-tally-usage` → `<repo>/clients/pi-usage-command` |
| CLI binary | `~/.local/share/pnpm/token-tally` (via pnpm global link) |
| Install manifest | `~/.config/token-tally/install.json` |

All extension paths are symlinks back to the repo, so `git pull && make install`
picks up code changes without reinstalling.

---

## Diagnostics

```sh
make doctor   # check all components
make test     # run Swift and store tests
```

`make doctor` checks the CLI binary, database health, tray app installation, Pi
extension symlinks, and the install manifest.

---

## Importing legacy Pi analytics data

If you used Pi's built-in analytics extension before installing ToTally, your
historical data is at `~/.pi/analytics/events.db`. It is **never touched or
deleted** by the installer. To migrate it into the central store:

```sh
token-tally import legacy-pi
```

The import is idempotent — running it more than once is safe. It maps the old
schema to the central ToTally schema and records import metadata so `make doctor`
can surface the status. The legacy file is left in place after import.

This command is **never run automatically by the installer**. It is an explicit
user action.

---

## Data stored by ToTally

ToTally stores **aggregate usage metadata only**. By default:

**Stored:** timestamps, harness name/version, provider/model, token counts, cost
values, session/turn/message IDs, repo owner/name/remote URL, tool names, error
flags.

**Never stored:** prompts, assistant responses, tool arguments, tool outputs,
file contents, environment variables, secrets.

See [`docs/local-data.md`](docs/local-data.md) for the complete data model.

---

## Uninstall

```sh
make uninstall
```

Removes the tray app, Pi extension symlinks, and the install manifest. **User
data is kept** — the database, spool files, and logs at `~/.local/share/token-tally/`
are printed but not deleted. The legacy Pi database at `~/.pi/analytics/events.db`
is never touched.

To also remove all ToTally analytics data:

```sh
scripts/uninstall.sh --purge --yes
```

See [`docs/install.md`](docs/install.md) for the full uninstall reference.

---

## Repository layout

```text
token-tally/
  Makefile                    ← orchestrator: install / uninstall / doctor / test
  scripts/                    ← component install/uninstall/doctor scripts

  store/                      ← shared writer library and token-tally CLI
    schema/                   ← SQL migration files
    src/                      ← TypeScript source
    cli/                      ← CLI entry point

  harnesses/
    pi/writer-extension/      ← Pi hook-based writer extension

  clients/
    macos-tray/               ← native macOS menu bar app (Swift/SwiftUI)
    pi-usage-command/         ← Pi /usage and /analytics doctor commands

  docs/
    schema.md                 ← database schema reference
    local-data.md             ← what data is and isn't stored
    install.md                ← detailed install/uninstall reference
    plugin-authoring.md       ← guide for writing new harness integrations
```

---

## Adding more harnesses

Claude Code, OpenCode, Cursor, and other harnesses are planned for future
releases. The central store is designed for multi-harness use from day one.
See [`docs/plugin-authoring.md`](docs/plugin-authoring.md) to write an
integration for a new harness.
