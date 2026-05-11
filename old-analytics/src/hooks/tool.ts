/**
 * hooks/tool.ts — T10: Tool execution observation, file tracking, and git
 * side-effect detection.
 *
 * Subscribes to three pi events:
 *   tool_execution_start — stash start timestamp + input bytes keyed by toolCallId
 *   tool_result          — derive file_touched events; emit git side-effects
 *   tool_execution_end   — emit ToolCallEvent with full timing and byte counts
 *
 * All handlers are observation-only (no return value). Every handler is
 * wrapped in try/catch — errors are console.warn'd and never propagated into
 * pi's hot path.
 *
 * ## Event ordering (from pi docs / T17 scenarios)
 *
 *   tool_execution_start → tool_call → tool_result → tool_execution_end
 *
 * We subscribe to start / result / end (not tool_call).  tool_result fires
 * while the turn is still active, so it is the right place to detect git
 * side-effects (which need piCtx.cwd for git SHA capture).  tool_execution_end
 * fires last and is where we emit the final ToolCallEvent with durations.
 *
 * ## Git side-effect handling (bash tool only)
 *
 * When bash-detect (T12) identifies an operation in the command string:
 *
 *   git commit   → CommitMadeEvent
 *                  SHA is captured asynchronously via getCurrentHeadSha, with
 *                  a 2-second cap.  Emitted with empty SHA on timeout/error —
 *                  partial data is better than no data.
 *
 *   git checkout / git switch → BranchTransitionEvent
 *                  from_branch is read from the per-session current-branch
 *                  tracker (initialized from the session snapshot branchStart
 *                  and updated on each detected transition).
 *
 *   git push / gh pr create → ToolSideEffectEvent
 *                  A lightweight marker consumed by T13 (PR linker) and T15
 *                  (eager link trigger).  No additional exec calls.
 *
 * ## Privacy
 *
 * - pathIsSensitive() (T3) is checked first for read/write/edit tools.
 *   If the path is sensitive, content is suppressed regardless of the
 *   storeToolOutputs setting; the FileTouchedEvent records the path + bytes
 *   but sets sensitive=true as a flag.
 *
 * - storeToolOutputs "none" → output_bytes and read/bash bytes are set to 0
 *   (even the byte count is suppressed).
 *   storeToolOutputs "size-only" or "full" → bytes are recorded as-is.
 *
 * - storeToolArgs "none" → write/edit bytes are set to 0 (their content comes
 *   from tool input args).
 *
 * - applyRules() is run against args/output text to accumulate redaction hits
 *   for ToolCallEvent.redacted — text is never stored in events, but hit
 *   counts tell us "secrets were present" without revealing them.
 */

import {
  newId,
  type AnalyticsSink,
  type ToolCallEvent,
  type FileTouchedEvent,
  type CommitMadeEvent,
  type BranchTransitionEvent,
  type ToolSideEffectEvent,
} from "../sinks/types.ts";
import type { HookContext, PiAPIStub, PiContextStub } from "./types.ts";
import { getActiveSessionId, getSnapshot } from "./session-state.ts";
import { getActiveTurnId } from "./turn.ts";
import { detectGitOps } from "../git/bash-detect.ts";
import { getCurrentHeadSha } from "../git/capture.ts";
import type { RedactionHits } from "../redact/index.ts";
import {
  DEFAULT_RULES,
  compileUserPatterns,
  applyRules,
  pathIsSensitive,
  byteLengthUtf8,
} from "../redact/index.ts";

// ---------------------------------------------------------------------------
// Pi event payload shapes
// Confirmed against T17 scenario payloads (scenarios.ts) and pi docs.
// ---------------------------------------------------------------------------

interface ToolContentBlock {
  type: string;
  text?: string;
}

/** Payload for pi's `tool_execution_start` event. */
interface PiToolExecutionStartEvent {
  toolCallId: string;
  toolName: string;
  /** The input arguments supplied to the tool. */
  args: Record<string, unknown>;
}

/**
 * Payload for pi's `tool_result` event.
 *
 * Note: `input` mirrors `tool_execution_start.args` and is the authoritative
 * source for file paths and command strings in this hook.
 */
interface PiToolResultEvent {
  toolCallId: string;
  toolName: string;
  /** The input args — same shape as tool_execution_start.args. */
  input: Record<string, unknown>;
  /** The tool's output as an array of content blocks. */
  content?: ToolContentBlock[];
  /** Tool-specific details (e.g. { exitCode } for bash, { path } for file ops). */
  details?: Record<string, unknown>;
  isError?: boolean;
}

/** Payload for pi's `tool_execution_end` event. */
interface PiToolExecutionEndEvent {
  toolCallId: string;
  toolName: string;
  result?: {
    content?: ToolContentBlock[];
  };
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Stashed data for an in-flight tool call.
 * Created at tool_execution_start; mutated by tool_result; consumed/deleted
 * at tool_execution_end.
 */
type ToolStartRecord = {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  inputArgs: Record<string, unknown>;
  inputBytes: number;
  /** Filled in by tool_result (before tool_execution_end fires). */
  outputBytes: number;
  isError: boolean;
};

/**
 * In-flight tool records keyed by toolCallId.
 * Pi may interleave parallel tool calls within the same turn — each has its
 * own correlation ID per PLAN.md "Parallel tool execution" note.
 */
const activeTools = new Map<string, ToolStartRecord>();

/**
 * Per-session current-branch tracker, keyed by analytics session_id.
 *
 * Initialized lazily from the session snapshot's branchStart (set by T6
 * after captureRepoSnapshot resolves) and updated on each detected
 * git checkout / git switch operation.  This allows BranchTransitionEvent
 * to carry a meaningful from_branch even when the first branch switch
 * happens mid-session.
 */
const sessionCurrentBranch = new Map<string, string>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the total UTF-8 byte length of all text blocks in a content array.
 * Non-text blocks (type !== "text" or missing text field) contribute 0.
 */
function computeOutputBytes(content: ToolContentBlock[]): number {
  return byteLengthUtf8(content.map((c) => c.text ?? "").join(""));
}

/**
 * Best-effort extraction of the git commit subject from a raw bash command.
 *
 * Handles the common forms:
 *   -m "message"          (double-quoted)
 *   -m 'message'          (single-quoted)
 *   --message="message"   (long-form double-quoted)
 *   --message='message'   (long-form single-quoted)
 *
 * Returns an empty string when no message can be extracted — callers should
 * treat an empty subject as "unknown".
 */
function extractCommitSubject(command: string): string {
  const dq = command.match(/-m\s+"([^"]+)"/);
  if (dq?.[1]) return dq[1];
  const sq = command.match(/-m\s+'([^']+)'/);
  if (sq?.[1]) return sq[1];
  const longDq = command.match(/--message="([^"]+)"/);
  if (longDq?.[1]) return longDq[1];
  const longSq = command.match(/--message='([^']+)'/);
  if (longSq?.[1]) return longSq[1];
  return "";
}

/**
 * Classify the error type from tool output content when is_error is true.
 * Returns a short descriptive string or null when classification fails.
 * Used to populate ToolCallEvent.error_kind.
 */
function parseErrorKind(content: ToolContentBlock[]): string | null {
  const text = content.map((c) => c.text ?? "").join("");
  if (!text) return null;
  if (/ENOENT/i.test(text)) return "not_found";
  if (/EACCES|EPERM/i.test(text)) return "permission";
  if (/timeout/i.test(text)) return "timeout";
  if (/ECONNREFUSED|ECONNRESET/i.test(text)) return "connection";
  if (/Error:/i.test(text)) return "error";
  return null;
}

/**
 * Return the current branch for a session.
 *
 * Priority:
 *   1. Value tracked in sessionCurrentBranch (updated on detected transitions)
 *   2. branchStart from the session snapshot (set async by T6 git capture)
 *   3. "unknown" fallback
 *
 * BranchTransitionEvent.from_branch is a required non-nullable string, so
 * we must always return something.
 */
function getCurrentBranch(
  sessionId: string,
  sessionFile: string | null,
): string {
  const tracked = sessionCurrentBranch.get(sessionId);
  if (tracked) return tracked;
  const fromSnapshot = getSnapshot(sessionFile)?.branchStart;
  if (fromSnapshot) return fromSnapshot;
  return "unknown";
}

// ---------------------------------------------------------------------------
// register — the single public export
// ---------------------------------------------------------------------------

/**
 * Register all tool-execution event handlers onto the pi ExtensionAPI.
 *
 * Called once by T15 (src/index.ts) during extension startup.  User redaction
 * patterns are compiled once here and captured in the event-handler closures.
 *
 * @param pi       - The pi ExtensionAPI (or structurally compatible stub).
 * @param sink     - The active analytics sink.
 * @param hookCtx  - Shared hook context with config and exec function.
 */
export function register(
  pi: PiAPIStub,
  sink: AnalyticsSink,
  hookCtx: HookContext,
): void {
  // Compile user patterns at registration time — avoid recompiling per event.
  const userRules = compileUserPatterns(hookCtx.config.privacy.redactPatterns);
  const allRules = [...DEFAULT_RULES, ...userRules];

  // ── tool_execution_start ─────────────────────────────────────────────────

  pi.on("tool_execution_start", (rawEvent: unknown, _piCtx: PiContextStub) => {
    try {
      const ev = rawEvent as PiToolExecutionStartEvent;
      const args = ev.args ?? {};
      activeTools.set(ev.toolCallId, {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        startedAt: Date.now(),
        inputArgs: args,
        inputBytes: byteLengthUtf8(JSON.stringify(args)),
        outputBytes: 0,
        isError: false,
      });
    } catch (err) {
      console.warn(
        "[analytics:hooks/tool] tool_execution_start error:",
        err,
      );
    }
  });

  // ── tool_result ───────────────────────────────────────────────────────────
  //
  // Async because git-commit SHA capture (getCurrentHeadSha) is async.
  // pi.on() handlers may return a Promise; FakeExtensionAPI.emit() awaits them.
  // On the real pi runtime, async handlers are awaited before the next
  // handler in registration order fires.

  pi.on("tool_result", async (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const ev = rawEvent as PiToolResultEvent;
      const { toolCallId, toolName, input, content = [], isError = false } = ev;

      const sessionFile = piCtx.sessionManager.getSessionFile();
      const sessionId = getActiveSessionId(sessionFile) ?? "unknown";
      const turnId = getActiveTurnId(sessionId);
      const ts = Date.now();

      // Stash output bytes and isError so tool_execution_end can use them
      const outputBytes = computeOutputBytes(content);
      const record = activeTools.get(toolCallId);
      if (record) {
        record.outputBytes = outputBytes;
        record.isError = isError;
      }

      // ── File-touched derivation ──────────────────────────────────────────

      if (toolName === "read") {
        const path = String((input as { path?: unknown }).path ?? "");
        const sensitive = path ? pathIsSensitive(path) : false;
        // output_bytes = bytes of content read from the file
        const bytes =
          hookCtx.config.privacy.storeToolOutputs === "none" ? 0 : outputBytes;
        const fileEvent: FileTouchedEvent = {
          kind: "file_touched",
          ts,
          tool_call_id: toolCallId,
          session_id: sessionId,
          path,
          op: "read",
          bytes,
          sensitive,
        };
        sink.write(fileEvent);
      } else if (toolName === "write") {
        const path = String((input as { path?: unknown }).path ?? "");
        const fileContent = String(
          (input as { content?: unknown }).content ?? "",
        );
        const sensitive = path ? pathIsSensitive(path) : false;
        // write.content is a tool *input* arg — apply storeToolArgs
        const bytes =
          hookCtx.config.privacy.storeToolArgs === "none"
            ? 0
            : byteLengthUtf8(fileContent);
        const fileEvent: FileTouchedEvent = {
          kind: "file_touched",
          ts,
          tool_call_id: toolCallId,
          session_id: sessionId,
          path,
          op: "write",
          bytes,
          sensitive,
        };
        sink.write(fileEvent);
      } else if (toolName === "edit") {
        const path = String((input as { path?: unknown }).path ?? "");
        const edits =
          (input as { edits?: Array<{ newText?: string }> }).edits ?? [];
        const sensitive = path ? pathIsSensitive(path) : false;
        // edit.newText values are tool *input* args — apply storeToolArgs
        const rawBytes = edits.reduce(
          (sum, e) => sum + byteLengthUtf8(e.newText ?? ""),
          0,
        );
        const bytes =
          hookCtx.config.privacy.storeToolArgs === "none" ? 0 : rawBytes;
        const fileEvent: FileTouchedEvent = {
          kind: "file_touched",
          ts,
          tool_call_id: toolCallId,
          session_id: sessionId,
          path,
          op: "edit",
          bytes,
          sensitive,
        };
        sink.write(fileEvent);
      } else if (toolName === "bash") {
        // ── Git side-effect detection (bash tool only) ─────────────────────
        // Only run when git integration is enabled.
        const command = String(
          (input as { command?: unknown }).command ?? "",
        );
        if (command && hookCtx.config.git.enabled) {
          const ops = detectGitOps(command);
          for (const op of ops) {
            if (op.kind === "git-commit") {
              // Capture HEAD SHA non-blocking, with 2s cap.
              const subject = extractCommitSubject(command);
              let sha = "";
              try {
                sha = await Promise.race([
                  getCurrentHeadSha(hookCtx.exec, piCtx.cwd).then(
                    (s) => s ?? "",
                  ),
                  new Promise<string>((resolve) =>
                    // 2-second cap so a slow git call doesn't block the handler
                    setTimeout(() => resolve(""), 2_000),
                  ),
                ]);
              } catch {
                // SHA capture failed — emit with empty SHA; partial data ok
              }
              const commitEvent: CommitMadeEvent = {
                kind: "commit_made",
                ts,
                session_id: sessionId,
                turn_id: turnId,
                sha,
                subject,
                files_changed: 0,
                insertions: 0,
                deletions: 0,
              };
              sink.write(commitEvent);
            } else if (
              op.kind === "git-checkout" ||
              op.kind === "git-switch"
            ) {
              const fromBranch = getCurrentBranch(sessionId, sessionFile);
              const toBranch = op.toBranch;
              // Update tracker so the next transition in this session has the
              // correct from_branch.
              sessionCurrentBranch.set(sessionId, toBranch);
              const branchEvent: BranchTransitionEvent = {
                kind: "branch_transition",
                ts,
                session_id: sessionId,
                turn_id: turnId,
                from_branch: fromBranch,
                to_branch: toBranch,
              };
              sink.write(branchEvent);
            } else if (op.kind === "git-push") {
              const sideEffect: ToolSideEffectEvent = {
                kind: "tool_side_effect",
                ts,
                session_id: sessionId,
                // ToolSideEffectEvent.turn_id is required string (not nullable)
                turn_id: turnId ?? "unknown",
                effect: "git-push",
                remote: op.remote,
                branch: op.branch,
              };
              sink.write(sideEffect);
            } else if (op.kind === "gh-pr-create") {
              const sideEffect: ToolSideEffectEvent = {
                kind: "tool_side_effect",
                ts,
                session_id: sessionId,
                turn_id: turnId ?? "unknown",
                effect: "gh-pr-create",
              };
              sink.write(sideEffect);
            }
          }
        }
      }
      // Other tool names (e.g. "find", custom tools) produce no file_touched
      // events — we only know about the standard built-in tool names.
    } catch (err) {
      console.warn("[analytics:hooks/tool] tool_result error:", err);
    }
  });

  // ── tool_execution_end ───────────────────────────────────────────────────

  pi.on(
    "tool_execution_end",
    (rawEvent: unknown, piCtx: PiContextStub) => {
      try {
        const ev = rawEvent as PiToolExecutionEndEvent;
        const { toolCallId, result, isError = false } = ev;

        const sessionFile = piCtx.sessionManager.getSessionFile();
        const sessionId = getActiveSessionId(sessionFile) ?? "unknown";
        const turnId = getActiveTurnId(sessionId) ?? "unknown";

        const record = activeTools.get(toolCallId);
        if (!record) {
          // Missed the start event — extension may have been loaded mid-session.
          console.warn(
            "[analytics:hooks/tool] tool_execution_end without matching start for",
            toolCallId,
          );
          return;
        }

        const now = Date.now();
        const durationMs = now - record.startedAt;

        // Output bytes: prefer the value stashed by tool_result (which ran
        // before this handler).  Fall back to result.content in case
        // tool_result was missed.
        const resultContent = result?.content ?? [];
        const rawOutputBytes =
          record.outputBytes > 0
            ? record.outputBytes
            : computeOutputBytes(resultContent);

        const isErrorFinal = record.isError || isError;

        // Error kind: derive from result content text when errored.
        const errorKind = isErrorFinal
          ? parseErrorKind(resultContent)
          : null;

        // Redaction hits: run rules against the serialized args text.
        // This is purely for the hit-count metric — args text is not stored.
        let redacted: RedactionHits | undefined;
        if (hookCtx.config.privacy.storeToolArgs !== "none") {
          const argsText = JSON.stringify(record.inputArgs);
          const { hits } = applyRules(argsText, allRules);
          if (Object.keys(hits).length > 0) {
            redacted = hits;
          }
        }

        // Apply storeToolOutputs privacy to output bytes.
        const outputBytes =
          hookCtx.config.privacy.storeToolOutputs === "none"
            ? 0
            : rawOutputBytes;

        const toolCallEvent: ToolCallEvent = {
          kind: "tool_call",
          ts: now,
          id: newId(),
          turn_id: turnId,
          session_id: sessionId,
          tool_call_id: toolCallId,
          name: record.toolName,
          started_at: record.startedAt,
          ended_at: now,
          duration_ms: durationMs,
          is_error: isErrorFinal,
          input_bytes: record.inputBytes,
          output_bytes: outputBytes,
          error_kind: errorKind,
          ...(redacted !== undefined ? { redacted } : {}),
        };

        sink.write(toolCallEvent);

        // Remove the stash — the tool call is fully observed.
        activeTools.delete(toolCallId);
      } catch (err) {
        console.warn(
          "[analytics:hooks/tool] tool_execution_end error:",
          err,
        );
      }
    },
  );
}
