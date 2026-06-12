# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does **not** currently follow Semantic Versioning — it is
pre-release (`0.x`) and breaking changes may occur between any two commits.

---

## [Unreleased]

### Added

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
