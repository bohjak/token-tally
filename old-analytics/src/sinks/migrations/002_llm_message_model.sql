-- 002_llm_message_model.sql
--
-- Adds model_id and provider columns to llm_messages so that model
-- attribution is stored on the message row itself, independent of whether
-- turns.model_id was populated correctly.
--
-- Motivation: turns.model_id was NULL for all rows when the extension first
-- shipped because model_select only fires on user-initiated /model changes.
-- Storing the values on llm_messages enables:
--   1. Retroactive backfill of turns.model_id via UPDATE … FROM llm_messages.
--   2. Resilience against future hook registration order issues.
--
-- Both columns are nullable so existing rows (which cannot be backfilled by
-- ALTER TABLE alone) remain valid NULL.
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN cannot add NOT NULL without a default,
-- and we deliberately do not add a DEFAULT because unknown-model rows should
-- be distinguishable from genuinely-unknown-at-insert-time rows.

ALTER TABLE llm_messages ADD COLUMN model_id TEXT;
ALTER TABLE llm_messages ADD COLUMN provider TEXT;

-- Composite index used by the Models tab aggregation query:
--   SELECT model_id, SUM(cost_total), … FROM llm_messages WHERE ts >= ? GROUP BY model_id
-- and by the backfill correlated subquery:
--   SELECT model_id FROM llm_messages WHERE turn_id = ? AND model_id IS NOT NULL ORDER BY ts
CREATE INDEX IF NOT EXISTS idx_llm_messages_model_ts
  ON llm_messages(model_id, ts);
