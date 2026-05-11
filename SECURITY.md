# Security Policy

## Supported versions

Only the latest commit on the `main` branch is actively maintained.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report security issues by emailing the maintainer directly (see the commit
history for contact details) or by using
[GitHub private vulnerability reporting](https://github.com/bohjak/token-tally/security/advisories/new).

Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a minimal proof-of-concept
- Any relevant environment details (macOS version, Node.js version, etc.)

You can expect an acknowledgement within **72 hours** and a fix or mitigation
plan within **14 days** for confirmed issues.

## Scope

ToTally is a local-only tool. It writes no data to the network. The primary
attack surface is:

- The SQLite database at `~/.local/share/token-tally/events.db`
- The NDJSON spool files at `~/.local/share/token-tally/spool/`
- The `token-tally` CLI binary installed via pnpm

All of these are owned by and accessible only to the local user who ran
`make install`.
