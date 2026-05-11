# pi Analytics Extension

The analytics extension captures rich usage data for every pi session — tokens consumed, cost, tool calls, latency, files touched, git branch and commit context, and PR associations — and stores it locally in SQLite and NDJSON. Everything is surfaced through a single command, `/usage`, with a tabbed interactive UI and a `--json` flag for scripting. No data leaves your machine in v1.

> **For design rationale, architecture decisions, and schema details, see [PLAN.md](../../../PLAN.md).**

---

## Quick install

```sh
# The extension directory is already part of ~/.pi — just install deps:
cd ~/.pi/agent/extensions/analytics
npm install

# Restart pi — the extension is auto-discovered on next session startup.
```

The extension looks for `config.json` next to `package.json`. Defaults are sane out of the box; override any key by editing `config.json`.

---

## Configuration

`~/.pi/agent/extensions/analytics/config.json`:

```jsonc
{
  "local": {
    "enabled": true,
    "dbPath": "~/.pi/analytics/events.db",   // SQLite database path
    "rawLogDir": "~/.pi/analytics/raw"        // NDJSON append-log directory
  },
  "privacy": {
    "storePrompts": "hashed",       // "full" | "hashed" | "none"
    "storeToolArgs": "summary",     // "full" | "summary" | "none"
    "storeToolOutputs": "size-only",// "full" | "size-only" | "none"
    "redactPatterns": [             // extra regex patterns to scrub
      "api[_-]?key",
      "bearer\\s+\\S+",
      "ghp_\\w+"
    ]
  },
  "git": {
    "enabled": true,        // capture repo/branch/SHA/PR at session start/end
    "fetchPR": true,        // run `gh pr view` at session_start (non-blocking)
    "ghTimeoutMs": 2000     // max ms to wait for gh CLI calls
  }
}
```

### Config key reference

| Key | Default | Description |
|-----|---------|-------------|
| `local.enabled` | `true` | Master switch. Set `false` to disable all capture. |
| `local.dbPath` | `~/.pi/analytics/events.db` | SQLite file path. `~` is expanded. |
| `local.rawLogDir` | `~/.pi/analytics/raw` | Directory for per-day NDJSON logs. |
| `privacy.storePrompts` | `"hashed"` | How to store prompt text. `"full"` keeps the text (after redaction); `"hashed"` keeps length + SHA-256 only; `"none"` drops both. |
| `privacy.storeToolArgs` | `"summary"` | How to store tool input arguments. `"full"` keeps args (after redaction); `"summary"` keeps the first ~200 chars; `"none"` drops text. |
| `privacy.storeToolOutputs` | `"size-only"` | How to store tool output. `"size-only"` records byte count only; `"full"` keeps text (after redaction); `"none"` drops even byte counts. |
| `privacy.redactPatterns` | *(see above)* | Extra regex strings applied on top of the built-in rules. Matches are replaced with `[REDACTED:<rule>]`. |
| `git.enabled` | `true` | Capture repo root, remote URL, branch, HEAD SHA, dirty count, and commits made during the session. |
| `git.fetchPR` | `true` | At `session_start`, call `gh pr view` to link an open PR to the session. Skipped silently if `gh` is absent. |
| `git.ghTimeoutMs` | `2000` | Hard timeout (ms) for any `gh` CLI call. |

---

## Commands

### `/usage` — interactive tabbed dashboard

Opens a tabbed UI in the pi terminal:

| Tab | Contents |
|-----|----------|
| **Summary** | Today / this week / all-time totals: cost (USD), tokens, turns; top model |
| **Models** | Cost + token breakdown per model, share of turns, avg tokens/turn |
| **Repos** | Cost per repository, session count, files touched, top tool |
| **Tools** | Call count, total + p50/p95 duration, error rate — per tool name |
| **PRs** | Per-PR roll-up across all linked sessions (planning / impl / fixup split) |
| **Daily** | Sparkline + table of cost and tokens per calendar day |

**Navigation:** arrow keys or `[` / `]` to switch tabs, `q` / `Esc` to close.

### `/usage --json` — machine-readable output

```sh
# Default: summary tab
/usage --json

# Specific tab
/usage --json --tab=models
/usage --json --tab=repos
/usage --json --tab=tools
/usage --json --tab=prs
/usage --json --tab=daily

# Time window (applies to all tabs)
/usage --json --since=24h
/usage --json --since=7d
/usage --json --since=month
/usage --json --since=all      # default

# Combine
/usage --json --tab=daily --since=7d
```

Summary tab JSON shape:
```json
{
  "today":   { "cost_usd": 0.42, "input_tokens": 18000, "output_tokens": 4200, "turns": 12, "sessions": 2 },
  "week":    { "cost_usd": 2.71, "input_tokens": 95000, "output_tokens": 21000, "turns": 67, "sessions": 9 },
  "allTime": { "cost_usd": 9.10, "input_tokens": 312000, "output_tokens": 74000, "turns": 234, "sessions": 31 },
  "top_model": { "id": "claude-sonnet-4-5", "cost_usd": 6.80, "share": 0.75 }
}
```

### `/analytics doctor` — DB health check

Runs invariants against the live database and reports:

- Orphaned FK rows (e.g., `tool_calls` referencing missing turns)
- Stale open turns/sessions (no `ended_at`, older than 24h — indicates a crashed pi)
- `llm_messages` where the sum of component costs doesn't match `cost_total`
- NDJSON-vs-SQLite count drift (today's append log vs the DB)
- Disk usage of `events.db` and the `raw/` directory
- **Redaction telemetry** — top rules fired in the last 7 days (e.g., `github-token: 47`). Counts only, never the matched text.

```sh
/analytics doctor          # human-readable summary
/analytics doctor --json   # machine-readable; exit 1 if anomalies found
```

---

## Data location

| Path | Format | Purpose |
|------|--------|---------|
| `~/.pi/analytics/events.db` | SQLite (WAL mode) | Queryable index for `/usage` and the PR linker |
| `~/.pi/analytics/raw/events-YYYY-MM-DD.ndjson` | NDJSON, one file per UTC day | Durable append log; schema-flexible; replayable |

To wipe all analytics data:
```sh
rm -rf ~/.pi/analytics/
```

The extension recreates both paths automatically on the next session start.

### Querying the database directly

```sh
# List tables
sqlite3 ~/.pi/analytics/events.db ".tables"

# Today's spend
sqlite3 ~/.pi/analytics/events.db \
  "SELECT round(sum(cost_total),4) AS usd FROM llm_messages
   WHERE ts > strftime('%s','now','-1 day')*1000;"

# Sessions by repo
sqlite3 ~/.pi/analytics/events.db \
  "SELECT repo_name, count(*) AS sessions, round(sum(m.cost_total),4) AS usd
   FROM sessions s
   JOIN turns t ON t.session_id = s.id
   JOIN llm_messages m ON m.turn_id = t.id
   GROUP BY repo_name ORDER BY usd DESC;"
```

---

## Privacy

Privacy is controlled per field-type. The defaults are conservative:

| What | Default | What's stored |
|------|---------|---------------|
| Prompt text | `"hashed"` | Length + SHA-256 only. Use `"full"` to keep text (after redaction). |
| Tool arguments | `"summary"` | First ~200 chars of redacted args + hit counts. |
| Tool outputs | `"size-only"` | Byte count only. |
| Sensitive-path content | always dropped | Path is recorded; content is never stored regardless of mode. |

**Built-in redaction rules** (always active, run before any privacy-mode truncation):

| Rule | Pattern |
|------|---------|
| `github-token` | `ghp_*`, `gho_*`, `ghs_*`, `ghu_*`, `ghr_*` |
| `openai-key` | `sk-…`, `sk-proj-…` |
| `anthropic-key` | `sk-ant-…` |
| `aws-access-key` | `AKIA[A-Z0-9]{16}` |
| `gcp-api-key` | `AIza…` |
| `gitlab-pat` | `glpat-…` |
| `slack-token` | `xox[abprs]-…` |
| `stripe-key` | `sk_live_…`, `pk_test_…`, etc. |
| `jwt` | Three-part base64url tokens |
| `private-key-block` | `-----BEGIN … PRIVATE KEY-----` |
| `bearer-header` | `Authorization: Bearer …` (header name preserved) |
| `db-conn-string` | `postgres://…`, `mysql://…` (scheme/host preserved) |
| `cli-password-flag` | `--password=…` (flag name preserved) |

Plus any patterns in `privacy.redactPatterns`. Matched values are replaced with `[REDACTED:<rule-name>]`.

**Sensitive paths** (content always suppressed, regardless of `storeToolOutputs`):
`.env`, `.env.*`, `~/.aws/`, `~/.ssh/`, `~/.kube/`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`, `credentials.json`, and similar.

---

## Architecture overview

```
hot path (events)              persistence              surfaces
─────────────────────          ─────────────            ─────────
session_start ─┐
input          │              ┌── SQLite (WAL) ──┐    /usage  (tabbed TUI)
turn_*         │   redact     │  events.db       │
message_end    ├──► sinks ────┤                  │    /usage --json
tool_*         │              └──────────────────┘
session_end    │
               │              ┌── NDJSON ────────┐    [future] OTLP sink
               └──────────────┤  events-YYYY-... │
                              └──────────────────┘
```

Events flow from pi's hook system → a `MultiSink` that fans out to `SqliteSink` and `NdjsonSink`. Adding an `OtlpSink` later is a drop-in — no hook changes needed. See [PLAN.md](../../../PLAN.md) for the full architecture, SQLite schema, git/PR collation logic, and OTLP design notes.

---

## Out of scope for v1

The following are explicitly deferred. See PLAN.md *Non-goals (v1)* and *Future* sections:

- **OTLP / remote telemetry export** — architecture is ready (`AnalyticsSink` interface + NDJSON replay), but the `OtlpSink` is not built.
- **System tray widget** — `/usage --json` is the designed feed for it.
- **Multi-machine sync** — data is local only. Manual rsync of `~/.pi/analytics/` works if needed.
- **Multi-user / team aggregation** — no server component.
- **`analytics export` CLI** — CSV/JSON dump command is future work.
- **Schema migration tooling** — migrations run automatically; a standalone migration CLI is future.
