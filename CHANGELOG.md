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
- `token-tally` CLI with `migrate`, `ingest`, `doctor`, and `import legacy-pi`
  commands.
- Native macOS menu bar app (`clients/macos-tray`) showing live token/cost
  summary.
- Pi harness writer extension (`harnesses/pi/writer-extension`).
- Pi usage command client (`clients/pi-usage-command`) providing `/usage` and
  `/analytics` doctor commands.
- `make install` / `make uninstall` / `make doctor` / `make test` targets.
- Database schema versioning via numbered SQL migration files.

[Unreleased]: https://github.com/bohjak/token-tally/commits/main
