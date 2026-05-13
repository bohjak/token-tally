/**
 * types.ts — Discriminated union for all Cursor hook event payloads.
 *
 * Cursor fires hooks by spawning a process with the event payload on stdin as
 * JSON. This module defines TypeScript shapes for every hook event so handlers
 * can narrow the union with a switch on `hook_event_name`.
 *
 * KEY DIFFERENCES FROM CLAUDE CODE:
 * - Cursor uses lower-camel event names (e.g. `sessionStart`, not `SessionStart`).
 * - Common fields use `conversation_id` and `generation_id` (not `session_id`).
 * - `session_id` appears ONLY on `sessionStart` / `sessionEnd` and is equivalent
 *   to `conversation_id` there.
 * - The config format is flat (`{ "command": "..." }`) not nested.
 *
 * NOTE: Cursor's hook payload schema is NOT a stable public contract.
 * All fields are marked optional except the discriminant `hook_event_name`.
 * Handlers must be defensive — extract only what they need and ignore
 * unknown fields rather than failing.
 *
 * Reference: https://cursor.com/docs/hooks
 */

// ---------------------------------------------------------------------------
// Discriminant values — Cursor lower-camel event names
// ---------------------------------------------------------------------------

export type HookEventName =
  | "sessionStart"
  | "sessionEnd"
  | "beforeSubmitPrompt"
  | "afterAgentResponse"
  | "afterAgentThought"
  | "preToolUse"
  | "postToolUse"
  | "postToolUseFailure"
  | "stop"
  | "subagentStart"
  | "subagentStop"
  | "preCompact"
  | "beforeShellExecution"
  | "afterShellExecution"
  | "beforeMCPExecution"
  | "afterMCPExecution"
  | "beforeReadFile"
  | "afterFileEdit"
  | "beforeTabFileRead"
  | "afterTabFileEdit"
  | "workspaceOpen";

// ---------------------------------------------------------------------------
// Common base fields — present on all agent hook payloads
//
// All fields are optional because:
//   1. Cursor's schema is still evolving; new payloads may omit fields.
//   2. App lifecycle hooks (workspaceOpen) intentionally omit session fields.
//   3. Defensive parsing prevents crashes on future Cursor versions.
//
// The ONLY required field is `hook_event_name` (the discriminant).
// ---------------------------------------------------------------------------

export interface HookPayloadBase {
  /** Identifies which hook fired. Required for dispatch. */
  hook_event_name: HookEventName;

  /**
   * Stable ID of the conversation across many turns.
   * Present on all agent hooks; absent on app lifecycle hooks (workspaceOpen).
   * Use `conversation_id ?? session_id` to get the harness session id.
   */
  conversation_id?: string;

  /**
   * Changes with every user message (every generation/turn).
   * Use this as harness_turn_id when present.
   */
  generation_id?: string;

  /** Model configured for the composer that triggered the hook. */
  model?: string;

  /** Cursor application version (e.g. "1.7.2"). */
  cursor_version?: string;

  /** Root folders of the workspace (normally one, multiroot can have several). */
  workspace_roots?: string[];

  /** Authenticated user email, or null if not available. */
  user_email?: string | null;

  /**
   * Path to the main conversation transcript file.
   * Null if transcripts are disabled. Use this for best-effort token backfill
   * before falling back to state.vscdb.
   */
  transcript_path?: string | null;

  /** Current working directory — present on tool and prompt hooks. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Full discriminated union — one variant per event we handle
// ---------------------------------------------------------------------------

export type HookPayload =
  // --- Session lifecycle ---
  | (HookPayloadBase & {
      hook_event_name: "sessionStart";
      /**
       * Unique identifier for this session. Equivalent to conversation_id on
       * this event. Available here as an alias for compatibility with the docs.
       */
      session_id?: string;
      is_background_agent?: boolean;
      /** The mode the composer is starting in. */
      composer_mode?: "agent" | "ask" | "edit";
    })
  | (HookPayloadBase & {
      hook_event_name: "sessionEnd";
      /** Same as conversation_id; both may be present on this event. */
      session_id?: string;
      reason?: "completed" | "aborted" | "error" | "window_close" | "user_close";
      duration_ms?: number;
      is_background_agent?: boolean;
      final_status?: string;
      error_message?: string;
    })

  // --- Prompt / response ---
  | (HookPayloadBase & {
      hook_event_name: "beforeSubmitPrompt";
      /**
       * Raw prompt text. We do NOT store this — data minimisation principle.
       * The hook records that a turn happened, not what was said.
       */
      prompt?: string;
      attachments?: Array<{ type?: string; file_path?: string }>;
    })
  | (HookPayloadBase & {
      hook_event_name: "afterAgentResponse";
      /**
       * Final assistant text. We do NOT store this — data minimisation.
       * We record only that a response occurred, plus any token metadata
       * backfilled later from transcript / state.vscdb.
       */
      text?: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "afterAgentThought";
      /** Fully aggregated thinking text. Not stored — data minimisation. */
      text?: string;
      duration_ms?: number;
    })

  // --- Tool use ---
  | (HookPayloadBase & {
      hook_event_name: "preToolUse";
      tool_name?: string;
      /** Tool arguments — intentionally unused (data minimisation). */
      tool_input?: unknown;
      tool_use_id?: string;
      agent_message?: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "postToolUse";
      tool_name?: string;
      tool_input?: unknown;
      /** JSON-stringified result payload from the tool. Not stored. */
      tool_output?: string;
      tool_use_id?: string;
      /** Execution time in milliseconds. */
      duration?: number;
    })
  | (HookPayloadBase & {
      hook_event_name: "postToolUseFailure";
      tool_name?: string;
      tool_input?: unknown;
      tool_use_id?: string;
      error_message?: string;
      failure_type?: "error" | "timeout" | "permission_denied";
      duration?: number;
      is_interrupt?: boolean;
    })

  // --- Agent completion ---
  | (HookPayloadBase & {
      hook_event_name: "stop";
      status?: "completed" | "aborted" | "error";
      /** How many times stop hook has already triggered a follow-up (starts at 0). */
      loop_count?: number;
    })

  // --- Subagent lifecycle ---
  | (HookPayloadBase & {
      hook_event_name: "subagentStart";
      subagent_id?: string;
      subagent_type?: string;
      task?: string;
      parent_conversation_id?: string;
      tool_call_id?: string;
      subagent_model?: string;
      is_parallel_worker?: boolean;
      git_branch?: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "subagentStop";
      subagent_type?: string;
      status?: "completed" | "error" | "aborted";
      task?: string;
      description?: string;
      summary?: string;
      duration_ms?: number;
      message_count?: number;
      tool_call_count?: number;
      loop_count?: number;
      modified_files?: string[];
      /** Path to the subagent's own transcript file, if any. */
      agent_transcript_path?: string | null;
    })

  // --- Context compaction ---
  | (HookPayloadBase & {
      hook_event_name: "preCompact";
      trigger?: "auto" | "manual";
      context_usage_percent?: number;
      /** Current context token count — the only hook payload with token data. */
      context_tokens?: number;
      context_window_size?: number;
      message_count?: number;
      messages_to_compact?: number;
      is_first_compaction?: boolean;
    })

  // --- Shell / MCP / file hooks (observed but not deeply processed) ---
  | (HookPayloadBase & { hook_event_name: "beforeShellExecution"; command?: string; sandbox?: boolean })
  | (HookPayloadBase & { hook_event_name: "afterShellExecution"; command?: string; output?: string; duration?: number; sandbox?: boolean })
  | (HookPayloadBase & { hook_event_name: "beforeMCPExecution"; tool_name?: string; tool_input?: unknown })
  | (HookPayloadBase & { hook_event_name: "afterMCPExecution"; tool_name?: string; tool_input?: unknown; result_json?: string; duration?: number })
  | (HookPayloadBase & { hook_event_name: "beforeReadFile"; file_path?: string })
  | (HookPayloadBase & { hook_event_name: "afterFileEdit"; file_path?: string; edits?: unknown[] })
  | (HookPayloadBase & { hook_event_name: "beforeTabFileRead"; file_path?: string })
  | (HookPayloadBase & { hook_event_name: "afterTabFileEdit"; file_path?: string; edits?: unknown[] })
  | (HookPayloadBase & { hook_event_name: "workspaceOpen" });
