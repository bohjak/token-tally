# Local Data — ToTally

ToTally collects usage and cost analytics from coding-agent harnesses and stores
them in a local SQLite database. **No analytics data is transmitted anywhere.**
There is no cloud sync, no hosted service, and no telemetry pipeline.

The database lives at:

```text
~/.local/share/token-tally/events.db
```

Where `$XDG_DATA_HOME` is set, that prefix replaces `~/.local/share`.

---

## What ToTally stores by default

The central store holds aggregate usage metadata only. Every row is machine-local
and readable only by processes on this machine with access to the file.

**Stored by default:**

| Category | Examples |
|---|---|
| Timestamps | session start/end, turn start/end, message time |
| Harness identity | `pi`, `claude-code`, harness version, integration version |
| Provider / model | `anthropic`, `claude-opus-4`, `gpt-4o` |
| Token counts | input tokens, output tokens, cache read tokens, cache write tokens |
| Cost values | per-message cost breakdown and total in integer micros |
| Event IDs | session ID, turn ID, message ID, tool call ID |
| Repo / cwd metadata | working directory, repo owner, repo name, remote URL (credentials stripped — see below) |
| Tool names | name of tool invoked (e.g. `bash`, `read`, `edit`) |
| Error flags | whether a tool call ended in an error |
| Subscription periods | plan name, period dates, fixed fee, quota usage |

**Never stored by default:**

- User prompts and assistant responses
- Tool arguments (the inputs passed to tools)
- Tool outputs (stdout/stderr, file contents returned)
- File contents read or written by the harness
- Environment variables or secrets
- Any personally identifying information beyond repo/cwd metadata

This exclusion list applies to all tables, including `raw_events`.

---

## Cost representation

Costs are stored as **integer micro-dollars** (millionths of one USD, or
millionths of one unit of the row's `cost_currency`). The value `1.234567 USD`
is stored as `1234567`.

This format eliminates IEEE-754 floating-point drift in aggregations. Readers
convert to display units only at the UI boundary:

```text
display_cost = cost_total_micros / 1_000_000.0
```

Cost columns record the **list-price equivalent** of each message — what it
would cost on the provider's published pay-as-you-go rate — regardless of how
the user is actually billed. Subscription coverage is a separate layer applied
by readers (see the `subscriptions` table in `docs/schema.md`).

### Cost provenance (`cost_source`)

Every `llm_messages` row carries a `cost_source` value so readers can
distinguish reliable numbers from estimates:

| Value | Meaning |
|---|---|
| `harness` | The harness itself emitted the cost; writer stored it verbatim. |
| `writer` | The harness emitted token counts only; the writer computed cost from its own pricing logic. Traceability is `(harness_id, integration_version)`. |
| `subscription_covered` | Tokens were used under a flat-fee subscription. `cost_*` still holds the PAYG list-price equivalent; `subscription_id` links to the covering period. |
| `unknown` | Neither harness nor writer produced cost. Columns are `0` and must **not** be included in headline cost totals without a caveat. |

Readers must always expose an "unpriced messages" count alongside cost
aggregations so that `0` is never silently interpreted as "free."

---

## Subscription billing

When a harness operates under a flat-fee subscription (Claude Pro/Max,
Cursor Pro, etc.), writers record the subscription period in the
`subscriptions` table and link each covered message via
`llm_messages.subscription_id`. This enables readers to present three
distinct numbers per period:

1. **Fixed subscription fee** — the flat cost charged for the period.
2. **Pay-as-you-go spend** — cost of messages not covered by any subscription.
3. **PAYG equivalent of covered usage** — informational "what this would have
   cost on PAYG," shown separately to avoid double-counting.

Sessions can span subscription period boundaries. Readers must group
`llm_messages` by `subscription_id`, not by `session_id`, when computing
per-period totals.

---

## Repo remote URL sanitisation

Git remote URLs are sometimes configured with embedded credentials, for example
when a CI system uses HTTPS with a token:

```text
https://oauth2:ghp_mytoken@github.com/owner/repo.git
```

ToTally **strips the userinfo (`user:password@`) portion from HTTP and HTTPS
remote URLs before writing `repo_remote` to the database**. The stored value
retains only the scheme, host, path, and optional `.git` suffix:

```text
https://github.com/owner/repo.git
```

This sanitisation is applied both by the live writer (via `AnalyticsWriter.recordSession`)
and by the legacy Pi importer. SSH remotes (e.g. `git@github.com:owner/repo.git`)
are stored as-is because SSH does not embed passwords in the URL.

---

## Raw event capture (opt-in only)

The `raw_events` table exists as a forward-compatibility escape hatch for
harness events that the structured tables do not yet model. It is **disabled by
default** and must be explicitly enabled per harness in
`~/.config/token-tally/config.json`:

```json
{
  "harnesses": {
    "pi": { "captureRaw": true }
  }
}
```

When raw capture is enabled, all of the same data exclusions apply. Writers
must:

- Maintain a static allowlist of permitted `kind` values in code. Emitting a
  `kind` outside the allowlist is a writer bug.
- Never include prompts, tool arguments, tool outputs, file contents, or
  secrets in `payload_json`, even with `captureRaw` enabled.

`token-tally doctor` samples recent `raw_events` rows and flags payloads that
contain known-sensitive keys (`prompt`, `content`, `messages`, `arguments`,
`output`, `env`, and common secret patterns). Accidental capture is surfaced
quickly rather than silently accumulating.

Readers — including the ToTally tray — ignore `raw_events` for all
aggregations. It is a diagnostic and forward-compatibility table only.

---

## Data locations

| Purpose | Default path |
|---|---|
| Analytics database | `~/.local/share/token-tally/events.db` |
| Config | `~/.config/token-tally/config.json` |
| Install manifest | `~/.config/token-tally/install.json` |
| State / logs | `~/.local/state/token-tally/logs/` |
| NDJSON spool | `~/.local/share/token-tally/spool/` |

XDG environment variables (`$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`,
`$XDG_STATE_HOME`) override the `~/.local/share`, `~/.config`, and
`~/.local/state` prefixes respectively.

### NDJSON spool

When the database is temporarily unavailable, writers fall back to appending
events as NDJSON to the spool directory. Spool files follow the naming
convention `<harness>-<pid>.ndjson` while a writer process is active, and are
renamed to `<harness>-<pid>-<ts>.ndjson.closed` on rotation or clean shutdown.
Closed files are drained back into the database by the next writer that
successfully opens the DB, or manually via `token-tally ingest`.

The tray never touches spool files. It is strictly read-only.

---

## Legacy Pi data

If you have pre-ToTally Pi analytics data at `~/.pi/analytics/events.db`, you
can import it into the central store with a dedicated one-shot command:

```sh
token-tally import legacy-pi
```

The import is idempotent — running it multiple times is safe. The legacy file
is never modified or deleted by ToTally. See `docs/install.md` for details.

---

## Removing your data

`make uninstall` removes the installed app and extensions but **leaves all
analytics data in place** by default. To also remove the database, spool files,
and logs, pass `--purge`:

```sh
make uninstall  # safe: keeps ~/.local/share/token-tally/
# or
scripts/uninstall.sh --purge --yes  # removes all ToTally data
```

The legacy Pi database at `~/.pi/analytics/events.db` is never removed by
ToTally under any circumstances.
