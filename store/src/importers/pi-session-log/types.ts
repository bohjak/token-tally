/**
 * Types for the Pi session log importer.
 *
 * Pi session logs live at:
 *   ~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<uuid>.jsonl           (parent)
 *   ~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<uuid>/<hash>/run-N/session.jsonl (subagent)
 *
 * Each file contains one JSON event per line.
 * Outer `timestamp` is an ISO-8601 string on every event type.
 */

// ---------------------------------------------------------------------------
// Raw event shapes from Pi session JSONL files
// ---------------------------------------------------------------------------

export interface SessionEvent {
  type: "session";
  version?: number;
  /** Pi session UUID — used for cross-checking only, NOT the DB key. */
  id: string;
  /** ISO-8601 outer timestamp. */
  timestamp: string;
  cwd?: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  /** Verbatim id, possibly compound: "call_abc|fc_def". */
  id: string;
  name: string;
  arguments?: unknown;
}

export type ContentBlock =
  | ToolCallBlock
  | { type: "thinking"; thinking?: string }
  | { type: string; [key: string]: unknown };

export interface MessageInner {
  role: "user" | "assistant" | "toolResult";
  provider?: string;
  model?: string;
  /** Absent on aborted and error messages. */
  responseId?: string;
  /** Unix ms inner timestamp. */
  timestamp?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  };
  stopReason?: string;
  content?: ContentBlock[];
  /** On toolResult messages: which toolCall this answers. */
  toolCallId?: string;
  /** On toolResult messages: whether the tool returned an error. */
  isError?: boolean;
}

export interface MessageEvent {
  type: "message";
  /** Stable short event ID (e.g. "52a06735"). */
  id: string;
  parentId?: string;
  /** ISO-8601 outer timestamp. */
  timestamp: string;
  message: MessageInner;
}

export interface ModelChangeEvent {
  type: "model_change";
  id: string;
  parentId?: string;
  /** ISO-8601 outer timestamp. */
  timestamp: string;
  provider?: string;
  modelId?: string;
}

export type PiSessionEvent =
  | SessionEvent
  | MessageEvent
  | ModelChangeEvent
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

export interface ParseError {
  file: string;
  line: number;
  reason: string;
}

export interface ParsedFile {
  filePath: string;
  events: PiSessionEvent[];
  errors: ParseError[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveredFile {
  /** Absolute path to the .jsonl file. */
  filePath: string;
  /** True for nested run-N/session.jsonl files. */
  isSubagent: boolean;
  /**
   * Session start timestamp (ISO-8601).
   * For parents: from session event (cross-checked with filename).
   * For subagents: from their own session event.
   * Used for date filtering and ascending import order.
   */
  sessionStartIso: string;
}

// ---------------------------------------------------------------------------
// Transformed rows (ready for DB insertion)
// ---------------------------------------------------------------------------

export interface TransformedToolCall {
  /** Verbatim content block id. */
  harnessToolCallId: string;
  toolName: string;
  /** Unix ms from the containing assistant message. */
  startedAtMs: number;
  /** Null if no matching toolResult was found. */
  endedAtMs: number | null;
  isError: boolean;
}

export interface TransformedMessage {
  /**
   * responseId when present;
   * "<filePath>:noid:<eventId>" when responseId absent but cost > 0.
   */
  harnessMessageId: string;
  /** Null when no responseId. */
  responseId: string | null;
  /** Unix ms (inner message.timestamp, or outer ISO parsed to ms). */
  tsMs: number;
  provider: string | null;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInputMicros: number;
  costOutputMicros: number;
  costCacheReadMicros: number;
  costCacheWriteMicros: number;
  costTotalMicros: number;
  costSource: "harness" | "unknown";
  toolCalls: TransformedToolCall[];
  /**
   * True when no responseId AND zero cost.
   * The importer counts these as zero_cost_skipped and does not write them.
   */
  isZeroCostSkip: boolean;
}

export interface TransformedTurn {
  /** "<filePath>:t<index>" */
  harnessTurnId: string;
  turnIndex: number;
  startedAtMs: number;
  endedAtMs: number | null;
  /** Provider from the first assistant message in the turn. */
  provider: string | null;
  /** Model from the first assistant message in the turn. */
  modelId: string | null;
  /** All assistant messages, including zero-cost-skip ones. */
  messages: TransformedMessage[];
}

export interface TransformedSession {
  /** Absolute session file path — used as harnessSessionId AND session_file. */
  filePath: string;
  /** Pi UUID from session event (for logging/cross-checking only). */
  piUuid: string | null;
  cwd: string | null;
  /** Unix ms of the session start (from session event or first event). */
  sessionStartMs: number;
  turns: TransformedTurn[];
}

// ---------------------------------------------------------------------------
// Import options and results
// ---------------------------------------------------------------------------

export interface PiSessionImportOptions {
  /** Sessions root directory. Default: ~/.pi/agent/sessions */
  sessionsPath?: string;
  /** Sessions starting on/after this UTC date (YYYY-MM-DD). */
  from?: string;
  /** Sessions starting before this UTC date (YYYY-MM-DD, exclusive). */
  to?: string;
  /**
   * Skip messages with inner unix-ms timestamp >= this instant (ISO-8601).
   * Belt-and-braces boundary cutoff; set to writer re-enable instant for backfill.
   */
  until?: string;
  /** Parse + report without writing to DB. */
  dryRun?: boolean;
  /** Override DB path. */
  dbPath?: string;
}

export interface SessionImportCounts {
  /** Total assistant messages with usage parsed from this file. */
  totalParsedAssistantUsage: number;
  /** Actually written to DB. */
  messagesImported: number;
  /** Skipped due to responseId seen in an earlier file (fork/resume replay). */
  messagesReplaySkipped: number;
  /** Skipped due to no responseId AND zero cost (aborted, error, etc.). */
  messagesZeroCostSkipped: number;
  /** Skipped due to matching an existing DB row for this session path. */
  messagesBoundarySkipped: number;
  /** Skipped because tsMs >= untilMs. */
  messagesCutoffSkipped: number;
  /** Tool calls written. */
  toolCallsImported: number;
  /** Tool calls skipped (already in DB or contained in a skipped message). */
  toolCallsSkipped: number;
  /** Malformed / unparseable lines in this file. */
  malformed: number;
}

export interface SessionImportResult {
  filePath: string;
  isSubagent: boolean;
  sessionStartIso: string;
  piUuid: string | null;
  cwd: string | null;
  /** True when this session path already had a row in the DB before import. */
  existedInDb: boolean;
  counts: SessionImportCounts;
  importedCostMicros: number;
  replaySkippedCostMicros: number;
  boundarySkippedCostMicros: number;
  cutoffSkippedCostMicros: number;
}

export interface PiSessionImportResult {
  dryRun: boolean;
  dbPath: string;
  sessions: SessionImportResult[];
  totals: {
    imported: number;
    replaysSkipped: number;
    zeroCostSkipped: number;
    boundarySkipped: number;
    cutoffSkipped: number;
    totalParsedAssistantUsage: number;
    importedCostMicros: number;
    replaySkippedCostMicros: number;
    boundarySkippedCostMicros: number;
    cutoffSkippedCostMicros: number;
    /** Cost micros from subagent sessions only. */
    subagentImportedCostMicros: number;
    malformed: number;
  };
}
