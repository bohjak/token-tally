# Contributions

This repository is public so people can inspect, use, and fork the code under
the MIT License. It is not necessarily an actively maintained open-source
project, and it does not currently carry an expectation that outside
contributions will be reviewed or accepted.

Please assume:

- issues and feature requests may not be read or answered;
- pull requests may not be reviewed, merged, or discussed;
- there is no support commitment, roadmap, release cadence, or compatibility
  guarantee;
- maintainers may close, ignore, or leave submissions unanswered for any reason.

If you want changes, the most reliable path is to fork the project and maintain
those changes yourself.

## Development notes for forks

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

General conventions:

- TypeScript: follow the existing patterns; run `pnpm typecheck` before
  committing.
- Swift: follow the existing SwiftUI patterns in `clients/macos-tray/`.
- Shell scripts: POSIX-compatible where possible; use `shellcheck` if
  available.
- Keep commits atomic — one logical change per commit.

For harness integrations, see [`docs/plugin-authoring.md`](docs/plugin-authoring.md).
For schema changes, see [`docs/schema.md`](docs/schema.md).

## License

Any contributions that are accepted are licensed under the project's
[MIT License](LICENSE).
