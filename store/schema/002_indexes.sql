-- ToTally central store — indexes (part of migration set 1)
-- Applied immediately after 001_initial.sql; schema_version remains 1.
--
-- INDEX OWNERSHIP RULE: the tray app and other readers must NEVER create
-- indexes. All indexes belong in store schema migrations. Writers and
-- readers must not assume any index beyond what is defined here.
--
-- Future migrations that add tables must add their indexes in the same
-- migration file, not as a retroactive patch here.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS so this file is safe to run
-- multiple times.

-- Refresh last_migrated_at to record when the full migration set was applied.
INSERT OR REPLACE INTO schema_metadata (key, value)
  VALUES ('last_migrated_at', CAST(CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS TEXT));

-- ---------------------------------------------------------------------------
-- llm_messages indexes
-- ---------------------------------------------------------------------------

-- Primary time-series scan: all messages in chronological order.
-- Used by today/week summary queries that aggregate across all harnesses.
CREATE INDEX IF NOT EXISTS idx_llm_messages_ts
  ON llm_messages(ts);

-- Per-harness time-series scan: the most common aggregation query pattern.
-- Covers (harness_id, ts) together so per-harness date-range queries are
-- served from a single index scan without a separate filter pass.
CREATE INDEX IF NOT EXISTS idx_llm_messages_harness_ts
  ON llm_messages(harness_id, ts);

-- Session rollup: sum tokens/costs for a specific session.
CREATE INDEX IF NOT EXISTS idx_llm_messages_session
  ON llm_messages(session_id);

-- Subscription period rollup: group messages by covering subscription period.
-- NULL subscription_id (pay-as-you-go) is efficiently scannable here too,
-- because SQLite includes NULLs in standard btree indexes.
CREATE INDEX IF NOT EXISTS idx_llm_messages_subscription
  ON llm_messages(subscription_id);

-- ---------------------------------------------------------------------------
-- turns indexes
-- ---------------------------------------------------------------------------

-- Session-scoped turn lookup and ordering.
CREATE INDEX IF NOT EXISTS idx_turns_session
  ON turns(session_id);

-- ---------------------------------------------------------------------------
-- tool_calls indexes
-- ---------------------------------------------------------------------------

-- Session-scoped tool call lookup.
CREATE INDEX IF NOT EXISTS idx_tool_calls_session
  ON tool_calls(session_id);

-- ---------------------------------------------------------------------------
-- raw_events indexes
-- ---------------------------------------------------------------------------

-- Per-harness time-series scan for the diagnostic/doctor queries.
CREATE INDEX IF NOT EXISTS idx_raw_events_harness_ts
  ON raw_events(harness_id, ts);
