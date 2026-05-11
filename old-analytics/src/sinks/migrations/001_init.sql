-- 001_init.sql — Initial schema for the pi analytics extension.
--
-- All tables are created with IF NOT EXISTS so this file can be re-run
-- safely (though the migration runner gates on schema_version in _meta).
--
-- Design notes:
--   • files_touched.tool_call_id stores the *pi correlation ID*
--     (ToolCallEvent.tool_call_id), NOT the row PK of tool_calls.
--     This avoids insertion-ordering issues (file_touched events may arrive
--     before or after the corresponding tool_call row).  No FK constraint is
--     enforced here; joins go through tool_calls.tool_call_id.
--   • commits_made includes turn_id (not in PLAN.md schema but present in
--     CommitMadeEvent) so callers can link commits back to the turn they
--     originated in.
--   • llm_messages and tool_calls carry a redundant session_id column for
--     direct lookups without multi-join queries.

-- ── Sessions ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT    PRIMARY KEY,
  parent_session_id   TEXT    REFERENCES sessions(id) ON DELETE SET NULL,
  parent_session_file TEXT,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  cwd                 TEXT    NOT NULL DEFAULT '',
  repo_root           TEXT,
  repo_remote         TEXT,
  repo_owner          TEXT,
  repo_name           TEXT,
  branch_start        TEXT,
  branch_end          TEXT,
  head_sha_start      TEXT,
  head_sha_end        TEXT,
  dirty_at_start      INTEGER,
  pi_version          TEXT    NOT NULL DEFAULT 'unknown',
  hostname            TEXT    NOT NULL DEFAULT '',
  exit_reason         TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_repo_started
  ON sessions(repo_remote, started_at);

-- ── Branch transitions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS branch_transitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  turn_id     TEXT,   -- soft ref: no FK because turns may not exist yet
  from_branch TEXT    NOT NULL DEFAULT '',
  to_branch   TEXT    NOT NULL DEFAULT ''
);

-- ── PR associations ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pr_associations (
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  repo_remote TEXT    NOT NULL DEFAULT '',
  pr_number   INTEGER NOT NULL,
  pr_url      TEXT    NOT NULL DEFAULT '',
  confidence  REAL    NOT NULL DEFAULT 0.0,
  reason      TEXT    NOT NULL DEFAULT '',
  linked_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_pr_associations_repo_pr
  ON pr_associations(repo_remote, pr_number);

-- ── Prompts ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS prompts (
  id          TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  source      TEXT    NOT NULL DEFAULT '',
  command     TEXT,
  slash_kind  TEXT,
  text_len    INTEGER NOT NULL DEFAULT 0,
  text_sha256 TEXT    NOT NULL DEFAULT '',
  image_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prompts_session
  ON prompts(session_id);

-- ── Turns ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turns (
  id                  TEXT    PRIMARY KEY,
  prompt_id           TEXT    NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  session_id          TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx                 INTEGER NOT NULL DEFAULT 0,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  model_id            TEXT,
  provider            TEXT,
  thinking_level      TEXT,
  http_status         INTEGER,
  ratelimit_remaining INTEGER,
  ratelimit_reset     INTEGER,
  stop_reason         TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_session_started
  ON turns(session_id, started_at);

-- ── LLM messages ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS llm_messages (
  id                     TEXT    PRIMARY KEY,
  turn_id                TEXT    NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id             TEXT    NOT NULL,
  role                   TEXT    NOT NULL DEFAULT 'assistant',
  ts                     INTEGER NOT NULL,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_input             REAL    NOT NULL DEFAULT 0,
  cost_output            REAL    NOT NULL DEFAULT 0,
  cost_cache_read        REAL    NOT NULL DEFAULT 0,
  cost_cache_write       REAL    NOT NULL DEFAULT 0,
  cost_total             REAL    NOT NULL DEFAULT 0,
  time_to_first_token_ms INTEGER,
  total_duration_ms      INTEGER,
  stop_reason            TEXT
);

-- ── Tool calls ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tool_calls (
  id           TEXT    PRIMARY KEY,
  turn_id      TEXT    NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id   TEXT    NOT NULL,
  tool_call_id TEXT    NOT NULL DEFAULT '',   -- pi correlation ID
  name         TEXT    NOT NULL DEFAULT '',
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  is_error     INTEGER NOT NULL DEFAULT 0,   -- boolean: 0 / 1
  input_bytes  INTEGER NOT NULL DEFAULT 0,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  error_kind   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_name
  ON tool_calls(turn_id, name);

-- ── Files touched ─────────────────────────────────────────────────────────────
--
-- tool_call_id here holds the pi correlation ID (FileTouchedEvent.tool_call_id),
-- matching tool_calls.tool_call_id — NOT tool_calls.id.  No FK is enforced to
-- avoid insertion-ordering issues.

CREATE TABLE IF NOT EXISTS files_touched (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_call_id TEXT    NOT NULL DEFAULT '',
  session_id   TEXT    NOT NULL,
  ts           INTEGER NOT NULL,
  path         TEXT    NOT NULL DEFAULT '',
  op           TEXT    NOT NULL DEFAULT '',   -- read | write | edit | bash-derived
  bytes        INTEGER NOT NULL DEFAULT 0,
  sensitive    INTEGER NOT NULL DEFAULT 0    -- boolean: 0 / 1
);

CREATE INDEX IF NOT EXISTS idx_files_touched_path
  ON files_touched(path);

-- ── Commits made ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS commits_made (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id       TEXT,   -- soft ref; may be null when captured at session_shutdown
  sha           TEXT    NOT NULL DEFAULT '',
  ts            INTEGER NOT NULL,
  subject       TEXT    NOT NULL DEFAULT '',
  files_changed INTEGER NOT NULL DEFAULT 0,
  insertions    INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0
);

-- ── Resource usage ────────────────────────────────────────────────────────────
-- Stores model_select, thinking_level_select, and explicit resource_used events.

CREATE TABLE IF NOT EXISTS resource_usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  label      TEXT    NOT NULL DEFAULT '',
  kind       TEXT    NOT NULL DEFAULT '',
  name       TEXT    NOT NULL DEFAULT ''
);
