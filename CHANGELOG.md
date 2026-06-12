# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does **not** currently follow Semantic Versioning — it is
pre-release (`0.x`) and breaking changes may occur between any two commits.

---

## [Unreleased]

### Added

- `@token-tally/queries` shared read-only query package: single source of truth
  for all TypeScript aggregation logic (models, sessions, repos, tools, daily
  cost). Both `clients/web-explorer` and `clients/pi-usage-command` now
  delegate entirely to this package. Fixes five correctness bugs: share
  denominator now uses a full-window ungrouped total, empty repo owners can no
  longer produce `"/"` group keys, `avg_tokens_per_turn` is defined
  consistently as `billable_tokens / turns`, `queryTabTools` O(n×m) scan is
  replaced by a single SQL group, and `cache_savings_usd` is floored at 0.
- `@token-tally/harness-kit` shared writer scaffolding package: config loading,
  monthly period computation, git-repo capture, atomic JSON state I/O, hook
  stdin/dispatch wrapper, and provider inference. Claude Code and Cursor writers
  now import from this kit instead of maintaining local copies.
- Store `./pricing` subpath export (`@token-tally/store/pricing`): a
  dependency-free pricing lookup and cost compute module now shared by the
  Claude Code and Pi writers. Removes three divergent in-process pricing tables.
  Fixes the Pi writer's unguarded prefix-walk that could assign unknown Claude
  models Opus-level rates (`cost_source='writer'`).
- Unified spool-drain engine (`store/src/drain-engine.ts`): the
  transactional prepared-statement path is now canonical for both
  `AnalyticsWriter`-internal drains and `ingestFile`/`ingestDir`. T10 legacy
  `spool:*` cross-reference repair logic is now applied consistently regardless
  of which path drains a `.closed` file.
- macOS tray degraded-schema banner: when the database schema version is newer
  than the installed tray app's `maxKnown`, a non-blocking banner is shown
  in the popover: "Database schema is newer than this app — run `make install`
  to update ToTally".
- Schema constant parity gate (`scripts/check-schema-constants.sh`): added to
  `scripts/release-check.sh`; fails the release check when Swift and TypeScript
  schema version constants (`minSupported`, `maxKnown`, `schemaForwardWindow`)
  diverge.
- `@token-tally/queries`, `@token-tally/harness-kit`, and the Pi writer test
  suite are now included in `make test` and `scripts/release-check.sh`.

### Fixed

- Hook commands registered with absolute symlink paths instead of bare names;
  `doctor.sh` and `uninstall.sh` match both old bare-name entries and new
  absolute-path entries so existing installs converge correctly on next
  `make install`.
- Daemon installer now uses `launchctl bootout`/`bootstrap` (macOS 14 API)
  instead of deprecated `launchctl unload`/`load -w`.
- Daemon log rotation: `token-tally daemon` rotates `daemon.log` →
  `daemon.log.1` when the log exceeds 10 MiB; `make doctor` warns when the
  live log is oversized.
- Git repository capture in Claude Code and Cursor writer hook processes now
  awaits the capture result before the hook exits, eliminating a race condition
  where repo metadata was silently lost.
- Malformed hook stdin no longer echoes raw payload bytes to stderr; only byte
  length and parse-error position are logged.
- State file temp names are now pid-suffixed (`${path}.${pid}.tmp`) to prevent
  concurrent hook processes from clobbering each other's write.
- Session-ID components used in state file paths are sanitized to prevent
  path-separator characters from creating unexpected subdirectories.
- `docs/plugin-authoring.md` subscription example corrected: removed
  non-existent `id:` field, changed period values to Unix milliseconds, and
  showed the returned subscription `id` for linkage. Cursor `preCompact`
  raw-event field list updated to match actual emitted keys.
- `docs/schema.md` subscription quota row scoped to "intended rendering for
  future reader support" (no reader currently displays subscription data).

- Initial public release of ToTally.
- Central SQLite store (`@token-tally/store`) with write-ahead NDJSON spool.
- `token-tally` CLI with `migrate`, `ingest`, `doctor`, `daemon`, `explore`,
  and `import legacy-pi` commands. Installed as a Node.js SEA binary at
  `~/.local/share/token-tally/bin/` (symlinked from `~/.local/bin/`).
- Drain daemon (`token-tally daemon`) registered with launchd (macOS) or
  systemd --user (Linux); drains spool files every 30 s and promotes
  abandoned files left by crashed writer processes.
- Native macOS menu bar app (`clients/macos-tray`) showing live token/cost
  summary.
- Web Explorer (`clients/web-explorer`): local-only browser dashboard backed
  by the central SQLite database; launched via `token-tally explore`.
- Pi harness writer extension (`harnesses/pi/writer-extension`).
- Pi usage command client (`clients/pi-usage-command`) providing `/usage` and
  `/analytics` doctor commands.
- Claude Code writer (`harnesses/claude-code/writer`): hook subprocess that
  drains the JSONL transcript for token counts and computes costs from the
  Anthropic pricing table.
- Cursor writer (`harnesses/cursor/writer`): hook subprocess that captures
  sessions, turns, and tool calls; best-effort token backfill via transcript
  or Cursor's private `state.vscdb`.
- `make install` / `make uninstall` / `make doctor` / `make test` targets.
- Database schema versioning via numbered SQL migration files.

[Unreleased]: https://github.com/bohjak/token-tally/commits/main
