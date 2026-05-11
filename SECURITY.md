# Security Policy

This is a public personal project with no ongoing maintenance or support
commitment. Use it at your own risk.

## Supported versions

There are no formally supported versions. The latest commit on `main` is simply
the current public state of the project.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

If you choose to report a security issue, use
[GitHub private vulnerability reporting](https://github.com/bohjak/token-tally/security/advisories/new)
when available. Reports may not be acknowledged, investigated, or fixed.
There is no response-time or remediation guarantee.

## Scope

ToTally is a local-only tool. It writes no data to the network. The primary
attack surface is:

- The SQLite database at `~/.local/share/token-tally/events.db`
- The NDJSON spool files at `~/.local/share/token-tally/spool/`
- The `token-tally` CLI binary installed via pnpm

All of these are owned by and accessible only to the local user who ran
`make install`.
