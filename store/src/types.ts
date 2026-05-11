/**
 * Public payload types for the ToTally central store.
 *
 * These types define what callers pass to AnalyticsWriter methods. The writer
 * is responsible for:
 *   - generating UUID primary keys (`id` columns)
 *   - setting `first_seen_at` / `last_seen_at` on harness upserts
 *   - computing `cost_total_micros` from the four breakdown columns
 *   - applying idempotent INSERT … ON CONFLICT DO UPDATE semantics
 *
 * Naming:
 *   - Product display name: "ToTally"
 *   - Package / path name:  "token-tally"
 *   - Identifier name:      "token_tally" (TypeScript symbols use camelCase)
 *
 * Timestamps are Unix milliseconds (Date.now() compatible) throughout.
 *
 * Costs are integer micro-dollars: 1 USD = 1_000_000 micros. This eliminates
 * IEEE-754 drift in aggregations. Readers convert at the UI boundary only:
 *   cost_total_micros / 1_000_000.0
 */

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * Records how a message's cost value was produced. Readers must respect this
 * when summing costs; messages with `cost_source = 'unknown'` should never be
 * silently included in headline totals.
 *
 * - `harness`             — harness emitted cost; writer stored it verbatim.
 * - `writer`              — harness emitted tokens only; writer computed cost
 *                           from its own pricing logic. Provenance is
 *                           traceable via (harness_id, integration_version).
 * - `subscription_covered`— message was covered by a flat-fee subscription.
 *                           cost_* columns still hold the PAYG list-price
 *                           equivalent so "what would this have cost?" remains
 *                           answerable.
 * - `unknown`             — no cost information available; all cost columns
 *                           are 0 and must not be summed without a caveat.
 */
export type CostSource = "harness" | "writer" | "subscription_covered" | "unknown";

// ---------------------------------------------------------------------------
// Writer option types
// ---------------------------------------------------------------------------

/**
 * Options accepted by `AnalyticsWriter.open()`.
 */
export type WriterOptions = {
  /**
   * Override the default database path.
   * Default: `~/.local/share/token-tally/events.db` (XDG-aware).
   */
  dbPath?: string;

  /**
   * Override the default spool directory.
   * Default: `~/.local/share/token-tally/spool` (XDG-aware).
   */
  spoolDir?: string;

  /**
   * Harness name for spool file naming, e.g. "pi".
   * Used as the prefix in `<harness>-<pid>.ndjson` spool filenames.
   * If omitted, spool files use "unknown" as the prefix; manual recovery
   * is still possible but less readable.
   */
  harnessName?: string;
};

/**
 * Return value from writer record methods that create a row.
 * The `id` is the ToTally-internal UUID; callers should pass it to
 * child record methods (e.g. pass `session.id` to `TurnPayload.sessionId`).
 */
export type RecordResult = {
  /** ToTally-internal UUID assigned to the new or upserted row. */
  id: string;
};

// ---------------------------------------------------------------------------
// Schema compatibility
// ---------------------------------------------------------------------------

/**
 * Result of reading `schema_metadata.schema_version` on DB open.
 *
 * The writer ships knowing a range [MIN_SUPPORTED, MAX_KNOWN].
 * Writers refuse to write in `degraded` or `too_new` states; readers may
 * read in `degraded` state (forward window) but must surface an update banner.
 *
 * Forward window N is 2: a reader/writer tolerates up to two schema versions
 * beyond its MAX_KNOWN before refusing to open.
 */
export type SchemaCompatibilityStatus =
  | {
      /** Schema is in the supported range. Normal operation. */
      status: "ok";
      version: number;
    }
  | {
      /**
       * DB schema is older than MIN_SUPPORTED. Run `token-tally migrate` to
       * bring the DB forward before this binary can use it.
       */
      status: "needs_migration";
      version: number;
      minSupported: number;
    }
  | {
      /**
       * DB schema is newer than MAX_KNOWN but within the forward window
       * (MAX_KNOWN < version ≤ MAX_KNOWN + 2). Readers may operate in
       * degraded mode (ignore unknown columns/tables). Writers must refuse
       * to write to avoid corrupting invariants they do not understand.
       */
      status: "degraded";
      version: number;
      maxKnown: number;
    }
  | {
      /**
       * DB schema is too far ahead of what this binary knows
       * (version > MAX_KNOWN + 2). The binary must refuse to open and
       * direct the user to update.
       */
      status: "too_new";
      version: number;
      maxKnown: number;
      forwardWindow: number;
    };

// ---------------------------------------------------------------------------
// Harness payload
// ---------------------------------------------------------------------------

/**
 * Payload for `AnalyticsWriter.recordHarness()`.
 *
 * The writer upserts on `name` (the primary key), setting `first_seen_at`
 * only on initial insert and updating `last_seen_at` and optional fields
 * on every call.
 */
export type HarnessPayload = {
  /**
   * Stable lowercase slug that uniquely identifies the harness.
   * Examples: "pi", "claude-code", "opencode", "cursor".
   * This is the foreign-key target throughout the schema (as `harness_id`).
   */
  name: string;

  /** Human-readable display name, e.g. "Pi", "Claude Code". */
  displayName: string;

  /** Version string of the harness application itself (optional). */
  version?: string;

  /**
   * Version of this repo's integration plugin that is writing data for
   * this harness. Used as part of `writer` cost provenance:
   * (harness_id, integration_version) identifies which writer build
   * computed a cost.
   */
  integrationVersion?: string;
};

// ---------------------------------------------------------------------------
// Session payload
// ---------------------------------------------------------------------------

/**
 * Payload for `AnalyticsWriter.recordSession()`.
 *
 * Writer idempotency key: UNIQUE (harness_id, harness_session_id).
 * The writer generates the ToTally UUID `id` and returns it in RecordResult.
 */
export type SessionPayload = {
  /** harnesses.name — must be registered via recordHarness first. */
  harnessId: string;

  /**
   * Harness-assigned session identifier. MUST NOT be empty.
   *
   * SQLite treats NULL as distinct in UNIQUE constraints, so two NULL rows
   * would both insert and silently break upsert idempotency. Harnesses that
   * do not expose a stable session ID must have the writer synthesize one
   * (e.g. derived from session_file + started_at) before calling this method.
   */
  harnessSessionId: string;

  /** Full path to the session file if the harness uses a file per session. */
  sessionFile?: string;

  /** Working directory when the session started. */
  cwd?: string;

  /** Git repository owner extracted from the remote URL (e.g. "acme-corp"). */
  repoOwner?: string;

  /** Git repository name (e.g. "my-project"). */
  repoName?: string;

  /** Full git remote URL (e.g. "git@github.com:acme-corp/my-project.git"). */
  repoRemote?: string;

  /** Unix timestamp (ms) when the session started. */
  startedAt: number;

  /** Unix timestamp (ms) when the session ended, if known at record time. */
  endedAt?: number;
};

// ---------------------------------------------------------------------------
// Turn payload
// ---------------------------------------------------------------------------

/**
 * Payload for `AnalyticsWriter.recordTurn()`.
 *
 * Writer idempotency key: UNIQUE (session_id, harness_turn_id).
 * The `sessionId` here is the ToTally UUID returned by recordSession, not
 * the harness-level session ID.
 */
export type TurnPayload = {
  /** ToTally session UUID from RecordResult.id returned by recordSession. */
  sessionId: string;

  /** harnesses.name for this turn. */
  harnessId: string;

  /**
   * Harness-assigned turn identifier within the session. MUST NOT be empty.
   * See HarnessSessionId comment above for why null breaks upserts.
   */
  harnessTurnId: string;

  /** Zero-based ordinal position of this turn within the session. */
  turnIndex?: number;

  /** Unix timestamp (ms) when the turn started. */
  startedAt: number;

  /** Unix timestamp (ms) when the turn ended, if known. */
  endedAt?: number;

  /** LLM provider used for this turn (e.g. "anthropic", "openai"). */
  provider?: string;

  /** Model identifier (e.g. "claude-opus-4-5", "gpt-4o"). */
  modelId?: string;
};

// ---------------------------------------------------------------------------
// LLM message payload
// ---------------------------------------------------------------------------

/**
 * Payload for `AnalyticsWriter.recordLlmMessage()`.
 *
 * Writer idempotency key: UNIQUE (harness_id, harness_message_id).
 *
 * Cost invariant enforced by the writer and the DB CHECK constraint:
 *   cost_total_micros = cost_input_micros + cost_output_micros
 *                     + cost_cache_read_micros + cost_cache_write_micros
 *
 * The writer computes costTotalMicros from the four breakdown fields; callers
 * must not provide it separately. All cost fields default to 0 when omitted.
 *
 * Cost values hold the list-price equivalent regardless of actual billing
 * (subscription, discount, etc.). Subscription-covered messages still carry
 * the PAYG list price so "what would this have cost?" remains answerable.
 */
export type LlmMessagePayload = {
  /** ToTally session UUID from RecordResult.id returned by recordSession. */
  sessionId: string;

  /** ToTally turn UUID from RecordResult.id returned by recordTurn (optional). */
  turnId?: string;

  /** harnesses.name for this message. */
  harnessId: string;

  /**
   * Harness-assigned message identifier. MUST NOT be empty.
   * Harnesses without stable message IDs should synthesize one, e.g.
   * `${session_id}:${message_index}`.
   */
  harnessMessageId: string;

  /** Unix timestamp (ms) of the message. */
  ts: number;

  /** LLM provider (e.g. "anthropic", "openai"). */
  provider?: string;

  /** Model identifier (e.g. "claude-opus-4-5"). */
  modelId?: string;

  // ---- Token counts --------------------------------------------------------

  /** Tokens in the prompt/input sent to the model. Default 0. */
  inputTokens?: number;

  /** Tokens in the model's response. Default 0. */
  outputTokens?: number;

  /** Cache read tokens (served from prompt cache). Default 0. */
  cacheReadTokens?: number;

  /** Cache write tokens (written to prompt cache). Default 0. */
  cacheWriteTokens?: number;

  // ---- Cost breakdown in integer micro-dollars ----------------------------
  // 1 USD = 1_000_000 micros. Writer computes cost_total_micros = sum of these.

  /** Input cost in micro-dollars at list price. Default 0. */
  costInputMicros?: number;

  /** Output cost in micro-dollars at list price. Default 0. */
  costOutputMicros?: number;

  /** Cache read cost in micro-dollars. Default 0. */
  costCacheReadMicros?: number;

  /** Cache write cost in micro-dollars. Default 0. */
  costCacheWriteMicros?: number;

  /** Currency for cost columns. Default "USD". */
  costCurrency?: string;

  /** How the cost was determined. Default "unknown". */
  costSource?: CostSource;

  /**
   * ID of the subscription period that covered this message.
   * When set, costSource should be "subscription_covered".
   * Must reference a subscription row created via recordSubscription.
   */
  subscriptionId?: string;
};

// ---------------------------------------------------------------------------
// Subscription payload
// ---------------------------------------------------------------------------

/**
 * Payload for `AnalyticsWriter.recordSubscription()`.
 *
 * Writer idempotency key: UNIQUE (harness_id, plan_name, period_start).
 * Writers upsert this row and update quota_used / period_end as the period
 * progresses.
 */
export type SubscriptionPayload = {
  /** harnesses.name for this subscription. */
  harnessId: string;

  /**
   * Writer-defined slug identifying the plan.
   * Examples: "claude-pro", "claude-max-20x", "cursor-pro".
   * Not an enum at the schema level; writers know their own plans.
   */
  planName: string;

  /** Unix timestamp (ms) when the subscription period starts. */
  periodStart: number;

  /** Unix timestamp (ms) when the subscription period ends. */
  periodEnd: number;

  /** Flat fee for the period in `currency`. */
  fixedCost: number;

  /** Currency of fixedCost. Default "USD". */
  currency?: string;

  /**
   * Optional usage quota counters. The tray renders
   * "{quotaUsed} / {quotaLimit} {quotaUnit}" without per-plan code.
   */
  quotaLimit?: number;
  quotaUsed?: number;

  /**
   * Human-readable unit label for the quota counters.
   * Examples: "requests", "messages", "fast-requests".
   */
  quotaUnit?: string;
};

// ---------------------------------------------------------------------------
// Tool call payload
// ---------------------------------------------------------------------------

/**
 * Payload for `AnalyticsWriter.recordToolCall()`.
 *
 * Writer idempotency key: UNIQUE (harness_id, harness_tool_call_id).
 * The is_error column is stored as INTEGER (0/1) in SQLite; callers use boolean.
 */
export type ToolCallPayload = {
  /** ToTally session UUID from RecordResult.id returned by recordSession. */
  sessionId: string;

  /** ToTally turn UUID (optional). */
  turnId?: string;

  /** harnesses.name for this tool call. */
  harnessId: string;

  /**
   * Harness-assigned tool call identifier. MUST NOT be empty.
   * See HarnessSessionId comment for why null breaks upserts.
   */
  harnessToolCallId: string;

  /** Name of the tool that was invoked (e.g. "bash", "read_file"). */
  toolName: string;

  /** Unix timestamp (ms) when the tool call started. */
  startedAt: number;

  /** Unix timestamp (ms) when the tool call ended, if known. */
  endedAt?: number;

  /** Whether the tool call resulted in an error. Default false. */
  isError?: boolean;
};

// ---------------------------------------------------------------------------
// Raw event payload
// ---------------------------------------------------------------------------

/**
 * Payload for `AnalyticsWriter.recordRawEvent()`.
 *
 * Raw events are opt-in per harness (config: harnesses.<name>.captureRaw).
 * The store never inserts here by default. This table exists as forward-
 * compatibility insurance for events the structured tables do not yet model.
 *
 * Writers MUST:
 *   - maintain a static allowlist of `kind` values in code; emitting a kind
 *     outside the allowlist is a writer bug, not a runtime decision
 *   - never put prompts, tool I/O, file contents, or secrets in payloadJson
 *     unless the user has explicitly opted in to raw capture for this harness
 */
export type RawEventPayload = {
  /** harnesses.name for this event. */
  harnessId: string;

  /** Unix timestamp (ms) of the event. */
  ts: number;

  /**
   * Event kind string. Must be in the writer's declared static allowlist.
   * Examples: "session_start", "model_select".
   */
  kind: string;

  /**
   * Opaque JSON payload. The store performs no validation on shape.
   * The `token-tally doctor` command samples recent rows and flags payloads
   * containing known-sensitive keys as a safety check.
   */
  payloadJson: string;
};
