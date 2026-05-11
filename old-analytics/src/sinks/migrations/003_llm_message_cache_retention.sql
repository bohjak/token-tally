-- 003_llm_message_cache_retention.sql
--
-- Stores the Anthropic prompt-cache write retention observed on the provider
-- request that produced an LLM message.  Values are intentionally textual:
--   '5m'  - Anthropic cache_control present without ttl (ephemeral default)
--   '1h'  - Anthropic cache_control present with ttl='1h'
--   NULL  - no cache_control observed, unknown, or non-Anthropic provider
--
-- This lets usage reports reconcile cache_write_tokens against Anthropic's
-- two cache creation prices instead of assuming a single per-model rate.

ALTER TABLE llm_messages ADD COLUMN cache_write_retention TEXT;
