/**
 * types.ts — Discriminated union for all Claude Code hook event payloads.
 *
 * Claude Code fires hooks by spawning a process with the event payload on
 * stdin as JSON. This module defines the TypeScript shapes for every hook
 * event so handlers can narrow the union with a switch on `hook_event_name`.
 *
 * NOTE: Claude Code's hook payload schema is NOT a stable public contract.
 * All fields beyond the common base are marked optional where uncertainty
 * exists. Handlers must be defensive — extract only what they need and ignore
 * unknown fields rather than failing.
 */

// ---------------------------------------------------------------------------
// Discriminant values
// ---------------------------------------------------------------------------

export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "Notification"
  | "PreCompact";

// ---------------------------------------------------------------------------
// Base fields present on every hook payload
// ---------------------------------------------------------------------------

export interface HookPayloadBase {
  hook_event_name: HookEventName;
  session_id: string;
  transcript_path: string;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Full discriminated union
// ---------------------------------------------------------------------------

export type HookPayload =
  | (HookPayloadBase & {
      hook_event_name: "SessionStart";
      /** "startup" = new session, "resume" = resumed, "clear" = /clear command */
      source?: "startup" | "resume" | "clear";
    })
  | (HookPayloadBase & {
      hook_event_name: "SessionEnd";
      reason?: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "UserPromptSubmit";
      /** Raw prompt text — present but intentionally unused by this writer. */
      prompt?: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "PreToolUse";
      tool_name: string;
      /** Tool input arguments — present but intentionally unused (data minimisation). */
      tool_input?: unknown;
      tool_use_id: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "PostToolUse";
      tool_name: string;
      /** Tool input arguments — present but intentionally unused (data minimisation). */
      tool_input?: unknown;
      /** Tool response — we read only `is_error`; all other fields are ignored. */
      tool_response?: { is_error?: boolean } & Record<string, unknown>;
      tool_use_id: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "Stop";
      /** True when Claude Code is itself operating as a Stop hook. */
      stop_hook_active?: boolean;
    })
  | (HookPayloadBase & {
      hook_event_name: "SubagentStop";
      stop_hook_active?: boolean;
    })
  | (HookPayloadBase & {
      hook_event_name: "Notification";
      message?: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "PreCompact";
      trigger?: string;
    });
