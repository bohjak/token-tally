# ToTally Central Store — Schema Reference

**Database path (default):** `~/.local/share/token-tally/events.db`
*(Honors `$XDG_DATA_HOME` when set; see `store/src/paths.ts`.)*

**Current schema version:** 1

---

## Contents

1. [Overview](#overview)
2. [Connection requirements](#connection-requirements)
3. [Tables](#tables)
   - [schema_metadata](#schema_metadata)
   - [harnesses](#harnesses)
   - [subscriptions](#subscriptions)
   - [sessions](#sessions)
   - [turns](#turns)
   - [llm_messages](#llm_messages)
   - [tool_calls](#tool_calls)
   - [raw_events](#raw_events)
4. [Indexes](#indexes)
5. [Cost semantics](#cost-semantics)
6. [Idempotency and upsert keys](#idempotency-and-upsert-keys)
7. [Schema versioning and compatibility](#schema-versioning-and-compatibility)
8. [Concurrency model](#concurrency-model)
9. [Writer expectations](#writer-expectations)
10. [Reader expectations](#reader-expectations)
11. [Migration guidelines](#migration-guidelines)

---

## Overview

The ToTally central store is a single SQLite database shared by all harness integrations and all clients. Harness integrations (Pi, Claude Code, etc.) write to it through the `@token-tally/store` library or the `token-tally` CLI. Clients (the macOS tray app, `/usage` commands) read from it.

The store is the **stable data contract** between writers and readers. Neither side should bypass it with direct schema assumptions. Writers use the library's typed APIs; readers query the documented columns and must tolerate unknown columns added by future migrations.

---

## Connection requirements

These settings must be applied immediately after opening a connection. The store library applies them automatically; direct SQLite connections must do the same.

| PRAGMA | Writers | Readers (tray) | Notes |
|---|---|---|---|
| `PRAGMA foreign_keys = ON` | ✅ required | ✅ required | SQLite ships with FK enforcement off by default |
| `PRAGMA journal_mode = WAL` | ✅ required | ❌ do not set | WAL allows concurrent readers alongside a writer |
| `PRAGMA synchronous = NORMAL` | ✅ required | ❌ do not set | Safe with WAL; faster than FULL |
| `PRAGMA busy_timeout = 5000` | ✅ required | ❌ optional | 5 s writer busy timeout; see [Concurrency model](#concurrency-model) |
| `PRAGMA query_only = 1` | ❌ never | ✅ required | Prevents any write through an open tray connection |

**Why `query_only` instead of `mode=ro`?** A strict `mode=ro` URI flag cannot read a WAL-mode database because it lacks write access to the `-wal`/`-shm` sidecar files. `query_only = 1` gives equivalent write-safety without the WAL incompatibility.

---

## Tables

### `schema_metadata`

Stores migration bookkeeping as key/value pairs.

```sql
CREATE TABLE schema_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Required keys:**

| Key | Description |
|---|---|
| `schema_version` | Current schema version as a decimal string (e.g. `"1"`) |
| `created_at` | Unix milliseconds when the database was first created |
| `last_migrated_at` | Unix milliseconds of the most recent migration run |

Readers check `schema_version` on open to determine compatibility. See [Schema versioning and compatibility](#schema-versioning-and-compatibility).

---

### `harnesses`

One row per harness integration.

```sql
CREATE TABLE harnesses (
  name                TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  version             TEXT,
  integration_version TEXT,
  first_seen_at       INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL
);
```

| Column | Notes |
|---|---|
| `name` | Stable lowercase slug: `pi`, `claude-code`, `opencode`, `cursor`. This is the FK target in all child tables (referred to as `harness_id`). There is intentionally no separate UUID id — name is already globally unique and human-readable. |
| `display_name` | Human-readable label shown in UI: `"Pi"`, `"Claude Code"`, etc. |
| `version` | Version of the harness application itself (e.g. `"1.4.2"`). |
| `integration_version` | Version of this repo's writer plugin for this harness. Together with `harness_id`, this is the provenance for `cost_source = 'writer'` records. |
| `first_seen_at` | Unix ms; written once on first check-in. Never updated. |
| `last_seen_at` | Unix ms; updated on every writer check-in. |

Writers upsert this row at the start of each session using
`INSERT INTO ... ON CONFLICT(name) DO UPDATE SET display_name=excluded.display_name,
version=excluded.version, integration_version=excluded.integration_version,
last_seen_at=excluded.last_seen_at`.
**Do not use `INSERT OR REPLACE`** — that would delete-then-insert, clobbering
`first_seen_at` and violating `ON DELETE RESTRICT` foreign key constraints from child tables.

---

### `subscriptions`

Records flat-fee subscription periods (Claude Pro/Max, Cursor Pro, etc.).

```sql
CREATE TABLE subscriptions (
  id           TEXT NOT NULL PRIMARY KEY,
  harness_id   TEXT NOT NULL,
  plan_name    TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end   INTEGER NOT NULL,
  fixed_cost   REAL NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  quota_limit  INTEGER,
  quota_used   INTEGER,
  quota_unit   TEXT,
  FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
  UNIQUE (harness_id, plan_name, period_start)
);
```

| Column | Notes |
|---|---|
| `plan_name` | Writer-defined slug: `claude-pro`, `claude-max-20x`, `cursor-pro`. Not an enum at the schema level. |
| `period_start` / `period_end` | Unix ms boundaries of the billing period. Writers update `period_end` and `quota_used` as the period progresses. |
| `fixed_cost` | Flat fee for this period in `currency`. |
| `quota_limit` / `quota_used` / `quota_unit` | Optional quota counter. Intended rendering for future reader support (`"{used} / {limit} {unit}"`); no reader currently displays subscriptions. |

This table is created before `llm_messages` because `llm_messages` has a FK to `subscriptions(id)`.

**Period boundary rule for readers:** a session can cross a subscription period boundary. Readers must group `llm_messages` by `subscription_id` when computing per-period totals, never by `session_id` alone. See [Reader expectations](#reader-expectations).

---

### `sessions`

One row per harness session (a continuous agent run).

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  harness_id         TEXT NOT NULL,
  harness_session_id TEXT NOT NULL,
  session_file       TEXT,
  cwd                TEXT,
  repo_owner         TEXT,
  repo_name          TEXT,
  repo_remote        TEXT,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
  UNIQUE (harness_id, harness_session_id)
);
```

| Column | Notes |
|---|---|
| `harness_session_id` | The harness-supplied session identifier, or a synthesized one. **Must never be NULL.** SQLite treats `NULL` as distinct in `UNIQUE` constraints, so two NULL rows would both insert and silently break idempotent upserts. Writers must synthesize (e.g. from `session_file + started_at`) when the harness does not expose a stable ID. |
| `cwd` | Working directory at session start. |
| `repo_owner` / `repo_name` / `repo_remote` | Git remote metadata extracted at session start. |
| `ended_at` | `NULL` until the session closes. |

---

### `turns`

One row per agent turn (a discrete round of model calls within a session).

```sql
CREATE TABLE turns (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  harness_id      TEXT NOT NULL,
  harness_turn_id TEXT NOT NULL,
  turn_index      INTEGER,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  provider        TEXT,
  model_id        TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)    ON DELETE RESTRICT,
  FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
  UNIQUE (session_id, harness_turn_id)
);
```

| Column | Notes |
|---|---|
| `harness_turn_id` | Never NULL. Same synthesis requirement as `harness_session_id`. |
| `turn_index` | Optional ordering hint within the session. |
| `provider` / `model_id` | Denormalized from the model selection event so per-turn breakdowns don't need an extra join. |

---

### `llm_messages`

One row per LLM API call. This is the **primary cost-accounting table**.

```sql
CREATE TABLE llm_messages (
  id                      TEXT PRIMARY KEY,
  session_id              TEXT NOT NULL,
  turn_id                 TEXT,
  harness_id              TEXT NOT NULL,
  harness_message_id      TEXT NOT NULL,

  ts                      INTEGER NOT NULL,
  provider                TEXT,
  model_id                TEXT,

  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens      INTEGER NOT NULL DEFAULT 0,

  cost_input_micros       INTEGER NOT NULL DEFAULT 0,
  cost_output_micros      INTEGER NOT NULL DEFAULT 0,
  cost_cache_read_micros  INTEGER NOT NULL DEFAULT 0,
  cost_cache_write_micros INTEGER NOT NULL DEFAULT 0,
  cost_total_micros       INTEGER NOT NULL DEFAULT 0,
  cost_currency           TEXT    NOT NULL DEFAULT 'USD',

  cost_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (cost_source IN ('harness', 'writer', 'subscription_covered', 'unknown')),
  subscription_id TEXT,

  FOREIGN KEY (session_id)      REFERENCES sessions(id)      ON DELETE RESTRICT,
  FOREIGN KEY (turn_id)         REFERENCES turns(id)         ON DELETE RESTRICT,
  FOREIGN KEY (harness_id)      REFERENCES harnesses(name)   ON DELETE RESTRICT,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE RESTRICT,

  UNIQUE (harness_id, harness_message_id),
  CHECK (cost_total_micros =
           cost_input_micros
         + cost_output_micros
         + cost_cache_read_micros
         + cost_cache_write_micros)
);
```

**Key design decisions are documented in [Cost semantics](#cost-semantics) below.**

| Column | Notes |
|---|---|
| `harness_message_id` | Never NULL. The idempotency key for ON CONFLICT DO UPDATE upserts. |
| `turn_id` | Nullable; some harnesses do not model turns. |
| `ts` | Unix ms; when the message completed (not when it started). |
| `input_tokens` / `output_tokens` | The cost-affecting token counts. |
| `cache_read_tokens` / `cache_write_tokens` | Cache tokens tracked separately; do not include in the primary "tokens used" count shown in the menu bar. |
| `cost_total_micros` | Writer-maintained cached sum of the four breakdown columns. Prefer for aggregations. |
| `subscription_id` | Non-null only when `cost_source = 'subscription_covered'`. |

---

### `tool_calls`

One row per tool invocation.

```sql
CREATE TABLE tool_calls (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  turn_id              TEXT,
  harness_id           TEXT NOT NULL,
  harness_tool_call_id TEXT NOT NULL,
  tool_name            TEXT NOT NULL,
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  is_error             INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id)    ON DELETE RESTRICT,
  FOREIGN KEY (turn_id)    REFERENCES turns(id)       ON DELETE RESTRICT,
  FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
  UNIQUE (harness_id, harness_tool_call_id)
);
```

| Column | Notes |
|---|---|
| `harness_tool_call_id` | Never NULL. Same synthesis requirement as session/turn IDs. |
| `is_error` | SQLite INTEGER boolean: `0` = success, non-zero = error. |
| `turn_id` | Nullable; some harnesses do not model turns. |

---

### `raw_events`

Optional forward-compatibility buffer. **Disabled by default.**

```sql
CREATE TABLE raw_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  harness_id   TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT
);
```

Enable per harness via `~/.config/token-tally/config.json`:
```json
{ "harnesses": { "pi": { "captureRaw": true } } }
```

**Constraints on writers using raw_events:**

- Each writer must declare a static allowlist of `kind` values in code. Emitting a `kind` outside the allowlist is a writer bug.
- Writers must NOT store prompts, tool I/O, file contents, secrets, or environment variables here unless the user has explicitly opted into raw capture.
- `token-tally doctor` samples recent rows and flags payloads containing known-sensitive keys.

**Readers (including the tray) must ignore `raw_events` for aggregation.** It is a diagnostic and forward-compatibility table, not a source of headline numbers.

This table is intentionally self-contained (no outgoing FKs to structured tables) so it can be split to a separate `raw.db` file cheaply if volume demands it.

**Delivery guarantee: at-least-once.** The drain engine commits all records in a file then deletes the file. If a crash occurs between the commit and the `unlink`, the file is re-drained on the next pass. Structured tables (`sessions`, `turns`, `llm_messages`, etc.) deduplicate replays automatically via their `ON CONFLICT … DO UPDATE` upsert keys, so duplicate delivery is harmless. `raw_events` has no natural deduplication key (rows are insert-only with an `AUTOINCREMENT` PK), so a crash in the commit→unlink window may produce duplicate `raw_events` rows. This is intentional — the cost of adding a deduplication key to a diagnostic table exceeds the value, and readers must tolerate duplicate raw events.

---

## Indexes

All indexes are defined in `store/schema/002_indexes.sql`. The tray and other readers must never create indexes; index ownership belongs exclusively to store migrations.

| Index | Table | Columns | Purpose |
|---|---|---|---|
| `idx_llm_messages_ts` | `llm_messages` | `ts` | All-harness time-range scans |
| `idx_llm_messages_harness_ts` | `llm_messages` | `harness_id, ts` | Per-harness time-range scans (most common) |
| `idx_llm_messages_session` | `llm_messages` | `session_id` | Session rollups |
| `idx_llm_messages_subscription` | `llm_messages` | `subscription_id` | Subscription period rollups (NULL = PAYG) |
| `idx_turns_session` | `turns` | `session_id` | Session-scoped turn lookups |
| `idx_tool_calls_session` | `tool_calls` | `session_id` | Session-scoped tool call lookups |
| `idx_raw_events_harness_ts` | `raw_events` | `harness_id, ts` | Doctor/diagnostic queries |

**Performance budget:** today/week summary and per-harness breakdown queries on a 1M-row
`llm_messages` fixture should complete in under 50 ms on a modern Mac. The 50 ms figure is
a *soft target* — `PerformanceTests.swift` emits a warning at 50 ms and enforces a hard
regression limit of 2000 ms. The performance suite requires the large fixture generated by
`fixtures/generate-large-db.ts` and is run via `scripts/release-check.sh` (without
`--skip-perf`); it is not included in `make test` or the CI `--skip-perf` run. If indexes
alone cannot meet the 50 ms target, the next step is a `daily_usage` rollup table populated
by writers or a `token-tally rollup` command — not heavier indexes.

---

## Cost semantics

### Integer micro-dollars

All `cost_*` columns are **INTEGER micro-dollars** (1 USD = 1,000,000 micros). Example: `$1.234567` is stored as `1234567`.

**Why integers?** IEEE-754 floating point would introduce drift in summed aggregations over millions of rows. Integer arithmetic is exact. The `CHECK` constraint on `cost_total_micros` is therefore a strict equality, not an epsilon comparison.

**Conversion at the UI boundary only:**
```swift
let displayCost = Double(message.cost_total_micros) / 1_000_000.0
```

### List-price equivalents

`cost_*` columns hold the **list-price equivalent** — what the message would cost on the provider's published pay-as-you-go rate — regardless of how the user is actually billed. This keeps numbers comparable across harnesses. Subscription, discount, and proxy-markup effects are layered on top by readers, not baked into rows.

### Cost provenance (`cost_source`)

| Value | Meaning |
|---|---|
| `'harness'` | Harness emitted cost values; writer stored them verbatim. |
| `'writer'` | Harness emitted only token counts; writer plugin computed cost from its own pricing logic. Provenance traces to `(harness_id, harnesses.integration_version)`. |
| `'subscription_covered'` | Covered by a flat-fee plan. `cost_*` still holds the PAYG equivalent. `subscription_id` is non-null. |
| `'unknown'` | No cost information available. All cost columns are `0`. Must NOT be summed into headline totals. |

Readers must always check `cost_source`. Aggregations must expose an "unpriced messages" count alongside any cost sums so that `$0.00` is never silently interpreted as "free."

### Canonical cost columns

The four breakdown columns (`cost_input_micros`, `cost_output_micros`, `cost_cache_read_micros`, `cost_cache_write_micros`) are the **source of truth** (audit trail). `cost_total_micros` is a writer-maintained cached sum for fast aggregations. The `CHECK` constraint enforces exact equality between the two views.

Readers should prefer `cost_total_micros` for aggregations and use the breakdown columns for per-component analysis.

### Cross-currency aggregations

`cost_currency` is per-row rather than a global setting, because different harnesses or proxies may bill in different currencies. Cross-currency totals are a reader concern and out of scope for the store.

---

## Idempotency and upsert keys

Writers replay events idempotently using these unique constraints:

| Table | Idempotency key | ON CONFLICT action |
|---|---|---|
| `sessions` | `(harness_id, harness_session_id)` | `DO UPDATE` or `DO NOTHING` |
| `turns` | `(session_id, harness_turn_id)` | `DO UPDATE` or `DO NOTHING` |
| `llm_messages` | `(harness_id, harness_message_id)` | `DO UPDATE` (update tokens/costs) |
| `tool_calls` | `(harness_id, harness_tool_call_id)` | `DO UPDATE` or `DO NOTHING` |
| `subscriptions` | `(harness_id, plan_name, period_start)` | `DO UPDATE` (update `period_end`, `fixed_cost`, `quota_limit`, `quota_used`, `quota_unit`) |

### Why harness event IDs are `NOT NULL`

SQLite treats `NULL` as distinct in `UNIQUE` constraints: two rows with `NULL` in a unique column are considered different and both insert. Allowing NULL harness IDs would let two "unidentified" events create separate rows and silently break the idempotency guarantee.

Harnesses that do not expose a stable identifier must have the writer synthesize one before insert:
- Session: `sha256(session_file + started_at)` or similar
- Turn: `${session_id}:${turn_index}` if turn_index is stable
- Message: `${session_id}:${message_index}`

---

## Schema versioning and compatibility

`schema_metadata.schema_version` is a **monotonically increasing integer** stored as TEXT. Migrations are forward-only; there is no downgrade path.

### Compatibility window

Readers and writers ship knowing a range `[MIN_SUPPORTED, MAX_KNOWN]`:

| Condition | Behavior |
|---|---|
| `schema_version < MIN_SUPPORTED` | The binary is too new for this DB. Run `token-tally migrate`. |
| `MIN_SUPPORTED ≤ schema_version ≤ MAX_KNOWN` | Normal operation. |
| `MAX_KNOWN < schema_version ≤ MAX_KNOWN + 2` | Degraded read-only mode: read known columns, ignore unknown. Tray shows a non-blocking "update available" banner. Writers refuse to write. |
| `schema_version > MAX_KNOWN + 2` | Refuse to open with a clear error directing the user to update the binary. |

### Migration constraints

Because of the forward compatibility window, migrations must be **additive**:
- ✅ Adding a new table
- ✅ Adding a nullable column to an existing table
- ✅ Adding an index
- ❌ Renaming a column (hard break unless coordinated with a tray release)
- ❌ Dropping a non-empty table (hard break)
- ❌ Adding a NOT NULL column without a DEFAULT (hard break for existing rows)

Each migration script:
1. Performs the schema change.
2. Inserts or updates `schema_version` to its own number.
3. Updates `last_migrated_at`.

---

## Concurrency model

Multiple processes write to the central DB simultaneously (Pi writer, CLI, other harnesses). The model is:

- **WAL mode** (`journal_mode=WAL`): concurrent readers alongside a single writer.
- **Busy timeout:** writers set `busy_timeout=5000` (5 s) and apply exponential backoff up to 10 s total.
- **NDJSON spool fallback:** if the DB is busy beyond the budget, the writer appends events to `~/.local/share/token-tally/spool/<harness>-<pid>.ndjson` and drains closed spool files on the next successful open.

The tray opens the DB read-write (needed for WAL sidecar access) and immediately issues `PRAGMA query_only = 1`. It never runs migrations or writes.

---

## Writer expectations

1. **Always call `PRAGMA foreign_keys = ON` immediately after opening.** The store library does this; direct connections must too.
2. **Always supply all five cost columns together.** The `CHECK` constraint rejects inserts where `cost_total_micros` ≠ sum of parts.
3. **Always synthesize non-null harness event IDs** when the harness does not provide them. Never insert `NULL` into `harness_session_id`, `harness_turn_id`, `harness_message_id`, or `harness_tool_call_id`.
4. **Use the idempotency keys.** Write idempotently via `INSERT ... ON CONFLICT DO UPDATE` or `INSERT OR IGNORE`.
5. **Never run migrations from a harness integration.** Migrations are owned by the store library and `token-tally migrate`.
6. **Never write prompts, responses, tool I/O, or secrets** to any column by default. Raw event capture requires explicit opt-in.
7. **Record harness identity** (`name`, `version`, `integration_version`) at the start of every session.

---

## Reader expectations

1. **Always call `PRAGMA foreign_keys = ON` and `PRAGMA query_only = 1` immediately after opening.**
2. **Check `schema_version` before querying.** Follow the compatibility window rules above.
3. **Respect `cost_source`.** Never sum cost columns from rows where `cost_source = 'unknown'` into headline totals.
4. **Expose unpriced message counts.** Any aggregation displaying cost sums must also show how many messages have `cost_source = 'unknown'`.
5. **Convert costs at the UI boundary only:** `display_cost = cost_total_micros / 1_000_000.0`.
6. **Group subscription period totals by `subscription_id`, not `session_id`.** Sessions can cross period boundaries.
7. **Ignore `raw_events` for aggregation.** It is a diagnostic table.
8. **Ignore unknown columns and tables.** Future migrations may add columns; readers built against an older schema must not fail when encountering them.
9. **Never create indexes.** Index ownership belongs to store migrations.

---

## Migration guidelines

When adding a future migration:

1. Create `store/schema/00N_<description>.sql`.
2. Begin the file with a comment block documenting what it changes and why.
3. Use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `ALTER TABLE ADD COLUMN` (for nullable or DEFAULT'd columns) to keep the file safe to inspect.
4. End with:
   ```sql
   INSERT OR REPLACE INTO schema_metadata (key, value) VALUES ('schema_version', 'N');
   INSERT OR REPLACE INTO schema_metadata (key, value)
     VALUES ('last_migrated_at', CAST(CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS TEXT));
   ```
5. Update `MAX_KNOWN_SCHEMA_VERSION` in `store/src/connection.ts` and the corresponding `maxKnownSchemaVersion` in `clients/macos-tray/AnalyticsTray/Data/AnalyticsDatabase.swift` within the forward compatibility window (≤ 2 versions ahead). Both values must stay in sync — `scripts/check-schema-constants.sh` (run automatically by `scripts/release-check.sh`) will fail the release check when they diverge.
6. Add any new indexes in the same migration file, not as a retroactive patch to `002_indexes.sql`.
7. Never rename columns or drop non-empty tables without coordinating a tray release that handles the old schema version in the compatibility window.
