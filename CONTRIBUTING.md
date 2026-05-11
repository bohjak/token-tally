# Contributing to ToTally

Thanks for your interest in contributing! This project is in early development
and the scope is intentionally narrow for now.

## Before you start

- Check existing [issues](https://github.com/bohjak/token-tally/issues) and
  [pull requests](https://github.com/bohjak/token-tally/pulls) to avoid
  duplicate work.
- For significant changes (new harness integrations, schema changes, new
  features), open an issue first to discuss the approach.

## Development setup

```sh
git clone https://github.com/bohjak/token-tally
cd token-tally
pnpm install
```

To build and test the store package:

```sh
cd store
pnpm build
pnpm test
```

To build the macOS tray app:

```sh
swift build --package-path clients/macos-tray
swift test  --package-path clients/macos-tray
```

## Coding conventions

- TypeScript: follow the existing patterns; run `pnpm typecheck` before
  committing.
- Swift: follow the existing SwiftUI patterns in `clients/macos-tray/`.
- Shell scripts: POSIX-compatible where possible; use `shellcheck` if
  available.
- Keep commits atomic — one logical change per commit.

## Adding a new harness integration

See [`docs/plugin-authoring.md`](docs/plugin-authoring.md) for the integration
guide. New integrations live under `harnesses/<name>/` or `clients/<name>/`
following the Pi layout as a reference.

## Schema changes

Any change to the SQLite schema requires a new numbered migration file in
`store/schema/`. See [`docs/schema.md`](docs/schema.md) for the versioning
convention.

## Pull requests

- Target the `main` branch.
- Include a short description of what changed and why.
- Ensure `make doctor` passes on a clean install.
- Do not include generated files (`dist/`, `*.db`) in the PR.

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
