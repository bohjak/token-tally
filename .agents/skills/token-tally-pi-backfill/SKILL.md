---
name: token-tally-pi-backfill
description: Backfill ToTally/token-tally when the Pi writer extension was disabled, missed usage, or needs reconciliation from Pi session logs. Use this skill whenever the user says the writer extension was off, asks to backfill the DB, import Pi sessions, recover missed token usage, compare the ToTally DB to Pi logs, or fix gaps in today's Pi analytics.
---

# Token Tally Pi Backfill

Use this runbook to recover usage data from Pi session logs into the ToTally SQLite database after the Pi writer extension was disabled or missed events.

## Key facts

- Pi session logs are the source of truth for backfill: `~/.pi/agent/sessions`.
- The central DB defaults to `~/.local/share/token-tally/events.db`.
- The importer is designed to be idempotent. Re-running the same import should not double-count already-imported rows.
- Active Pi sessions can keep changing while you work. If the user is currently using Pi, expect a second import to catch a few new messages.
- Prefer explicit date/window bounds. Do not run an unbounded import unless the user asks for full history.

## Workflow

### 1. Determine the window

If the user says “today”, use the current UTC date unless local-day semantics are clearly intended. For a full day, use:

```sh
token-tally import pi-sessions --from YYYY-MM-DD --to YYYY-MM-DD --dry-run
```

`--to` is exclusive. For example, to import June 15, 2026:

```sh
token-tally import pi-sessions --from 2026-06-15 --to 2026-06-16 --dry-run
```

If the user knows when the writer was re-enabled, add `--until <ISO-8601 timestamp>` to avoid overlapping live writes:

```sh
token-tally import pi-sessions --from 2026-06-15 --to 2026-06-16 --until 2026-06-15T15:30:00Z --dry-run
```

### 2. Preview first

Run a dry-run import and inspect the totals:

```sh
token-tally import pi-sessions --from YYYY-MM-DD --to YYYY-MM-DD --dry-run
```

Look for:

- sessions discovered
- messages that would be imported
- boundary skips, which are expected for rows already captured by the writer
- replay skips, which are expected for fork/resume duplicate response IDs
- malformed lines, which may need investigation if non-zero

### 3. Apply the import

If the dry run looks reasonable, run the same command without `--dry-run`:

```sh
token-tally import pi-sessions --from YYYY-MM-DD --to YYYY-MM-DD
```

If Pi is still active, run the import once more at the end to catch messages appended during the first pass.

### 4. Verify with doctor

Compare the database against Pi session logs for the same window:

```sh
token-tally doctor --compare-pi-sessions --from YYYY-MM-DD --to YYYY-MM-DD
```

Interpretation:

- `boundary_skipped` during import usually means “already present in DB,” not a problem.
- Small doctor deltas can be expected when logs contain replayed response IDs from older sessions; the importer avoids double-counting these.
- “Extra in DB” rows with synthesized IDs may come from earlier writer captures before canonical provider IDs were available.
- Missing fresh, non-replayed messages after a second import should be investigated.

If doctor suggests synthesized Pi IDs need repair, preview first:

```sh
token-tally doctor --compare-pi-sessions --repair-canonical-ids --from YYYY-MM-DD --to YYYY-MM-DD
```

Only apply with `--yes` if the preview clearly matches rows to update:

```sh
token-tally doctor --compare-pi-sessions --repair-canonical-ids --from YYYY-MM-DD --to YYYY-MM-DD --yes
```

## Reporting back

Summarize concisely:

- the import window
- DB path
- number of messages imported and estimated cost
- whether a follow-up import was needed
- doctor verification result and any residual deltas/risk

Example:

```text
Backfilled Pi sessions for 2026-06-15 into ~/.local/share/token-tally/events.db.
Imported 601 messages ($42.632711), then a follow-up run caught 8 active-session messages ($0.469871).
Doctor compare still shows a small delta; sampled missing rows are replayed response IDs from older logs, so they were intentionally not double-counted.
```
