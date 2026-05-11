-- ToTally central store — initial schema (migration set 1)
-- Default database path: ~/.local/share/token-tally/events.db
-- (XDG_DATA_HOME is honored when set; see store/src/paths.ts)
--
-- NAMING CONVENTIONS
--   harnesses.name         = stable lowercase slug ("pi", "claude-code", …)
--   harness_id columns     = TEXT FK → harnesses(name), named for ergonomics
--   Timestamps             = Unix milliseconds stored as INTEGER
--   Costs                  = integer micro-dollars (1 USD = 1_000_000 micros)
--
-- CONNECTION REQUIREMENTS (enforced by the store library, not this file):
--   PRAGMA foreign_keys = ON;     -- every connection, every time
--   PRAGMA journal_mode = WAL;    -- writers only
--   PRAGMA synchronous  = NORMAL; -- writers only
--   PRAGMA busy_timeout = 5000;   -- writers only (milliseconds)
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS; every INSERT uses OR IGNORE
-- so this file is safe to run multiple times (migration runner should only
-- run it once, but the safety net costs nothing).

-- ---------------------------------------------------------------------------
-- schema_metadata
-- ---------------------------------------------------------------------------
-- Key/value bookkeeping for migration state.
-- Required keys: schema_version, created_at, last_migrated_at.
-- schema_version is a monotonically-increasing integer stored as TEXT.
-- Readers and writers check it on open; see docs/schema.md for the
-- compatibility window rules.
CREATE TABLE IF NOT EXISTS schema_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seed required keys.
-- INSERT OR IGNORE so re-running this file leaves schema_version untouched
-- (a subsequent migration must own its own version bump).
-- created_at is written once and never updated.
-- last_migrated_at is refreshed each time the migration set runs.
INSERT OR IGNORE INTO schema_metadata (key, value) VALUES
  ('schema_version',   '1'),
  ('created_at',       CAST(CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS TEXT)),
  ('last_migrated_at', CAST(CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS TEXT));

-- Always refresh last_migrated_at when this file runs.
INSERT OR REPLACE INTO schema_metadata (key, value)
  VALUES ('last_migrated_at', CAST(CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS TEXT));

-- ---------------------------------------------------------------------------
-- harnesses
-- ---------------------------------------------------------------------------
-- One row per harness integration (e.g. "pi", "claude-code", "cursor").
--
-- name is the globally-unique, stable lowercase slug used as a FK target
-- everywhere in the schema. There is intentionally no separate UUID id:
-- name is already unique and human-readable, and using it directly as the FK
-- key makes queries and diagnostics easier to follow.
--
-- version             = the harness application version (e.g. "1.4.2")
-- integration_version = the token-tally plugin/hook version for this harness
CREATE TABLE IF NOT EXISTS harnesses (
  name                TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  version             TEXT,              -- null until first harness self-report
  integration_version TEXT,              -- null until first writer check-in
  first_seen_at       INTEGER NOT NULL,  -- Unix ms; set once on first insert
  last_seen_at        INTEGER NOT NULL   -- Unix ms; updated on each check-in
);

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------
-- Records flat-fee subscription periods (Claude Pro/Max, Cursor Pro, etc.).
-- Must be created before llm_messages because llm_messages has a FK here.
--
-- plan_name is a writer-defined slug ("claude-pro", "claude-max-20x", …).
-- It is NOT an enum at the schema level; writers know their own plans.
--
-- fixed_cost is the flat fee for the period in currency.
-- quota_limit/quota_used/quota_unit are optional and rendered verbatim by
-- the tray as "{used} / {limit} {unit}" — no per-plan display logic needed.
--
-- Writers upsert the row and update quota_used/period_end as the period
-- progresses. The idempotency key is (harness_id, plan_name, period_start).
CREATE TABLE IF NOT EXISTS subscriptions (
  id           TEXT NOT NULL PRIMARY KEY,
  harness_id   TEXT NOT NULL,
  plan_name    TEXT NOT NULL,    -- writer-defined slug
  period_start INTEGER NOT NULL, -- Unix ms; start of billing period
  period_end   INTEGER NOT NULL, -- Unix ms; end of billing period (may update)
  fixed_cost   REAL NOT NULL,    -- flat fee for this period in currency
  currency     TEXT NOT NULL DEFAULT 'USD',
  quota_limit  INTEGER,          -- null if harness does not expose a quota
  quota_used   INTEGER,          -- null until harness reports usage
  quota_unit   TEXT,             -- e.g. "requests", "messages", "fast-requests"
  FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
  -- Idempotency key: one row per harness + plan + billing period start.
  UNIQUE (harness_id, plan_name, period_start)
);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
-- One row per harness session (a continuous agent run).
--
-- harness_session_id is NOT NULL by design: SQLite treats NULL as distinct
-- in UNIQUE constraints, so two NULL rows would both insert and silently
-- break idempotent upserts. Writers must synthesize a stable ID (e.g. from
-- session_file + started_at) when the harness does not expose one natively.
--
-- Repo/cwd metadata is stored by default (see docs/local-data.md for what
-- is and is not included). ended_at is NULL until the session closes.
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  harness_id         TEXT NOT NULL,
  harness_session_id TEXT NOT NULL,  -- harness-supplied or synthesized; never NULL
  session_file       TEXT,           -- path to harness session file, if any
  cwd                TEXT,           -- working directory at session start
  repo_owner         TEXT,           -- git remote owner (e.g. "octocat")
  repo_name          TEXT,           -- git remote repo name
  repo_remote        TEXT,           -- full git remote URL
  started_at         INTEGER NOT NULL, -- Unix ms
  ended_at           INTEGER,          -- Unix ms; NULL until session closes
  FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
  -- Idempotency key: replaying the same harness event must not create duplicates.
  UNIQUE (harness_id, harness_session_id)
);

-- ---------------------------------------------------------------------------
-- turns
-- ---------------------------------------------------------------------------
-- One row per agent turn (a discrete round of model calls within a session).
--
-- harness_turn_id is NOT NULL for the same idempotency reason as
-- harness_session_id above. Writers must synthesize if needed.
--
-- provider/model_id are denormalized here (and on llm_messages) to allow
-- per-turn model overrides without a separate join.
CREATE TABLE IF NOT EXISTS turns (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  harness_id      TEXT NOT NULL,
  harness_turn_id TEXT NOT NULL,  -- harness-supplied or synthesized; never NULL
  turn_index      INTEGER,        -- optional ordering hint within the session
  started_at      INTEGER NOT NULL, -- Unix ms
  ended_at        INTEGER,          -- Unix ms; NULL until turn closes
  provider        TEXT,             -- e.g. "anthropic"
  model_id        TEXT,             -- e.g. "claude-opus-4-5"
  FOREIGN KEY (session_id) REFERENCES sessions(id)    ON DELETE RESTRICT,
  FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
  -- Idempotency key: unique per session + harness-supplied turn ID.
  UNIQUE (session_id, harness_turn_id)
);

-- ---------------------------------------------------------------------------
-- llm_messages
-- ---------------------------------------------------------------------------
-- One row per LLM call. This is the primary cost-accounting table.
--
-- COST STORAGE
--   All cost_* columns hold the list-price equivalent of the message —
--   what it would cost on the provider's published pay-as-you-go rate —
--   regardless of how the user is actually billed. This keeps numbers
--   comparable across harnesses.
--
--   Costs are stored as INTEGER micro-dollars (1 USD = 1_000_000 micros)
--   to eliminate IEEE-754 drift in aggregations. Readers convert at the
--   UI boundary only: display_cost = cost_total_micros / 1_000_000.0
--
--   cost_total_micros is a cached sum maintained by the writer. The CHECK
--   constraint enforces exact integer equality so the two views can never
--   drift. Writers must supply all five cost values consistently; the store
--   never synthesizes costs.
--
-- COST PROVENANCE (cost_source)
--   'harness'              – harness emitted cost values; writer stored verbatim
--   'writer'               – harness emitted only token counts; writer plugin
--                            computed cost from its own pricing logic
--   'subscription_covered' – covered by a flat-fee subscription; cost_* still
--                            holds the PAYG equivalent for "what would this cost?"
--   'unknown'              – no cost info available; all cost columns are 0;
--                            must NOT be summed into headline totals
--
-- IDEMPOTENCY
--   harness_message_id is NOT NULL (same rationale as session/turn IDs).
--   UNIQUE (harness_id, harness_message_id) is the key for
--   INSERT ... ON CONFLICT DO UPDATE upserts.
--
-- turn_id is nullable: some harnesses do not model turns.
CREATE TABLE IF NOT EXISTS llm_messages (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  turn_id            TEXT,              -- NULL if harness does not model turns
  harness_id         TEXT NOT NULL,
  harness_message_id TEXT NOT NULL,     -- harness-supplied or synthesized; never NULL

  ts                 INTEGER NOT NULL,  -- Unix ms; when the message completed
  provider           TEXT,              -- e.g. "anthropic"
  model_id           TEXT,              -- e.g. "claude-opus-4-5"

  -- Token counts. Non-cached tokens (input + output) are the primary cost driver;
  -- cache tokens are tracked separately for context but must not be conflated.
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens   INTEGER NOT NULL DEFAULT 0,

  -- Costs in integer micro-dollars (1 USD = 1_000_000).
  -- The four breakdown columns are the source of truth (audit trail).
  -- cost_total_micros is a writer-maintained cached sum for fast aggregations.
  -- The CHECK ensures they can never drift.
  cost_input_micros       INTEGER NOT NULL DEFAULT 0,
  cost_output_micros      INTEGER NOT NULL DEFAULT 0,
  cost_cache_read_micros  INTEGER NOT NULL DEFAULT 0,
  cost_cache_write_micros INTEGER NOT NULL DEFAULT 0,
  cost_total_micros       INTEGER NOT NULL DEFAULT 0,
  cost_currency           TEXT    NOT NULL DEFAULT 'USD',

  -- Cost provenance — see COST PROVENANCE above.
  cost_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (cost_source IN ('harness', 'writer', 'subscription_covered', 'unknown')),

  -- Non-NULL only when cost_source = 'subscription_covered'.
  subscription_id TEXT,

  FOREIGN KEY (session_id)      REFERENCES sessions(id)      ON DELETE RESTRICT,
  FOREIGN KEY (turn_id)         REFERENCES turns(id)         ON DELETE RESTRICT,
  FOREIGN KEY (harness_id)      REFERENCES harnesses(name)   ON DELETE RESTRICT,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE RESTRICT,

  -- Idempotency key for INSERT ... ON CONFLICT DO UPDATE upserts.
  UNIQUE (harness_id, harness_message_id),

  -- Integer arithmetic is exact, so this CHECK is precise equality (no epsilon).
  -- Writers must set all five cost columns together or the insert is rejected.
  CHECK (cost_total_micros =
           cost_input_micros
         + cost_output_micros
         + cost_cache_read_micros
         + cost_cache_write_micros)
);

-- ---------------------------------------------------------------------------
-- tool_calls
-- ---------------------------------------------------------------------------
-- One row per tool invocation.
-- is_error uses SQLite INTEGER boolean convention: 0 = success, 1 = error.
-- harness_tool_call_id is NOT NULL for the same idempotency reason as above.
-- turn_id is nullable: some harnesses do not model turns.
CREATE TABLE IF NOT EXISTS tool_calls (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  turn_id              TEXT,             -- NULL if harness does not model turns
  harness_id           TEXT NOT NULL,
  harness_tool_call_id TEXT NOT NULL,    -- harness-supplied or synthesized; never NULL
  tool_name            TEXT NOT NULL,
  started_at           INTEGER NOT NULL, -- Unix ms
  ended_at             INTEGER,          -- Unix ms; NULL until call returns
  is_error             INTEGER NOT NULL DEFAULT 0, -- 0 = success, non-zero = error
  FOREIGN KEY (session_id) REFERENCES sessions(id)    ON DELETE RESTRICT,
  FOREIGN KEY (turn_id)    REFERENCES turns(id)       ON DELETE RESTRICT,
  FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
  -- Idempotency key.
  UNIQUE (harness_id, harness_tool_call_id)
);

-- ---------------------------------------------------------------------------
-- raw_events
-- ---------------------------------------------------------------------------
-- Optional forward-compatibility buffer. DISABLED BY DEFAULT.
-- Enabled per harness via config.json: harnesses.<name>.captureRaw = true
--
-- Purpose: when a harness emits an event the structured tables do not yet
-- model, integrations have somewhere to put it without blocking on a schema
-- migration. payload_json is opaque; the store performs no validation.
--
-- IMPORTANT: writers must NOT store prompts, tool I/O, file contents, or
-- secrets here unless the user has explicitly opted in. See docs/local-data.md.
--
-- Readers (including the tray) must ignore raw_events for aggregation.
--
-- This table is intentionally self-contained (no outgoing FKs to structured
-- tables) so it can be split to raw.db cheaply if capture volume demands it.
CREATE TABLE IF NOT EXISTS raw_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  harness_id   TEXT NOT NULL,
  ts           INTEGER NOT NULL, -- Unix ms
  kind         TEXT NOT NULL,    -- writer-declared allowlisted event kind
  payload_json TEXT NOT NULL,    -- opaque JSON blob
  FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT
);
