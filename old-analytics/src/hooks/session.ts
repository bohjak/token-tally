/**
 * session.ts — T6: Hooks for session_start, session_shutdown, model_select,
 * and thinking_level_select.
 *
 * ## Approach for async git capture at session_start
 *
 * We emit a `session_start` analytics event immediately (with null git fields)
 * so that downstream events (prompts, turns) that arrive before git capture
 * completes can still be keyed on the session ID. Once `captureRepoSnapshot`
 * resolves we emit a `session_patch` event; `SqliteSink` updates the
 * existing row with the git fields.
 *
 * This avoids holding up the session_start callback on I/O while keeping
 * git data accurate. The trade-off: if pi shuts down before git capture
 * resolves (very fast exit), the session row may lack git fields — acceptable
 * for v1.
 *
 * ## Dedup for diff-derived file_touched events
 *
 * At session_shutdown we emit `file_touched` events for every file in the
 * `git log --numstat` diff range. T10 may have already emitted `file_touched`
 * events for some of these paths via tool-level observation. We emit all
 * diff-derived files with `op="bash-derived"` and a synthetic `tool_call_id`
 * prefixed with "session-end:". The SQLite schema does not enforce uniqueness
 * on (path, session_id), so both events will be stored. Queries in T14 that
 * want deduplicated paths should use `SELECT DISTINCT path`.
 *
 * ## pi API compatibility
 *
 * Local minimal interface types (PiAPIStub, PiContextStub) are used instead
 * of importing from @mariozechner/pi-coding-agent. At runtime pi passes real
 * objects that are structurally compatible. See hooks/types.ts for details.
 */

import { hostname } from "node:os";
import { createRequire } from "node:module";

import {
  newId,
  type AnalyticsSink,
} from "../sinks/types.ts";
import {
  captureRepoSnapshot,
  fetchPrForBranch,
  listOpenPrsForBranch,
  getDiffSummary,
} from "../git/capture.ts";
import {
  setSession,
  getActiveSessionId,
  clearSession,
  getSnapshot,
  patchSnapshot,
} from "./session-state.ts";
import type { HookContext, PiAPIStub, PiContextStub } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Try to read pi's version from its own package.json (resolved at runtime). */
function getPiVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    // At runtime pi resolves this via its own node_modules. In dev (tsc only)
    // it will be absent — that's fine, we fall through to "unknown".
    const pkg = req("@mariozechner/pi-coding-agent/package.json") as {
      version?: string;
    };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // Expected in local dev environments where the package isn't installed.
  }
  return "unknown";
}

// Cache the version so we only read the file once.
let _cachedPiVersion: string | undefined;
function piVersion(): string {
  if (_cachedPiVersion === undefined) {
    _cachedPiVersion = getPiVersion();
  }
  return _cachedPiVersion;
}

// ---------------------------------------------------------------------------
// Local pi event payload types
//
// Minimal shapes matching pi's real events — used instead of importing from
// @mariozechner/pi-coding-agent which is not in our local node_modules.
// ---------------------------------------------------------------------------

interface PiSessionStartEvent {
  reason: string;
  previousSessionFile?: string;
}

interface PiSessionShutdownEvent {
  reason: string;
  targetSessionFile?: string;
}

interface PiModel {
  id: string;
  provider?: string;
}

interface PiModelSelectEvent {
  model: PiModel;
  previousModel?: PiModel;
  source: string;
}

interface PiThinkingLevelSelectEvent {
  level: string;
  previousLevel: string;
}

// ---------------------------------------------------------------------------
// register() — the single public export
// ---------------------------------------------------------------------------

/**
 * Register all session-related event handlers onto the pi ExtensionAPI.
 *
 * Called once by T15 (src/index.ts) during extension startup. The function
 * closes over `sink` and `hookCtx` — do not store them elsewhere.
 */
export function register(
  pi: PiAPIStub,
  sink: AnalyticsSink,
  hookCtx: HookContext,
): void {
  const { config, exec } = hookCtx;

  // ── session_start ─────────────────────────────────────────────────────────

  pi.on("session_start", async (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = rawEvent as PiSessionStartEvent;
      const sessionId = newId();
      const sessionFile = piCtx.sessionManager.getSessionFile();
      const cwd = piCtx.cwd;
      const now = Date.now();

      // Register session state immediately so downstream hooks can look up
      // the session ID before git capture resolves.
      setSession(sessionFile, {
        sessionId,
        headShaStart: null,
        branchStart: null,
        cwd,
      });

      // Emit session_start with null git fields — SqliteSink inserts a row now.
      sink.write({
        kind: "session_start",
        ts: now,
        id: sessionId,
        parent_session_id: null, // populated by T13/T15 when linking forks
        parent_session_file: event.previousSessionFile ?? null,
        started_at: now,
        cwd,
        pi_version: piVersion(),
        hostname: hostname(),
        // Git fields — null now, patched by session_patch once capture resolves.
        repo_root: null,
        repo_remote: null,
        repo_owner: null,
        repo_name: null,
        branch_start: null,
        head_sha_start: null,
        dirty_at_start: null,
      });

      // Fire-and-forget git capture — must not block the session_start handler.
      if (config.git.enabled) {
        captureRepoSnapshot(exec, cwd)
          .then((snapshot) => {
            if (!snapshot) return;

            // Update in-memory state with the captured git info.
            patchSnapshot(sessionFile, {
              headShaStart: snapshot.headSha,
              branchStart: snapshot.branch,
            });

            // Emit session_patch so SqliteSink can fill in the git columns.
            sink.write({
              kind: "session_patch",
              ts: Date.now(),
              session_id: sessionId,
              repo_root: snapshot.repoRoot,
              repo_remote: snapshot.repoRemote,
              repo_owner: snapshot.repoOwner ?? null,
              repo_name: snapshot.repoName ?? null,
              branch_start: snapshot.branch,
              head_sha_start: snapshot.headSha,
              dirty_at_start: snapshot.dirtyCount,
            });

            // Optionally associate the current PR with this session.
            if (config.git.fetchPR) {
              fetchPrForBranch(
                exec,
                cwd,
                snapshot.branch,
                config.git.ghTimeoutMs,
              )
                .then((pr) => {
                  if (!pr) return;
                  // PR exists for the current branch — emit a branch-match
                  // association with 0.8 confidence.
                  sink.write({
                    kind: "pr_association",
                    ts: Date.now(),
                    session_id: sessionId,
                    repo_remote: snapshot.repoRemote ?? "",
                    pr_number: pr.number,
                    pr_url: pr.url,
                    confidence: 0.8,
                    reason: "branch-match",
                  });
                })
                .catch((err: unknown) => {
                  console.warn(
                    "[analytics:session] fetchPrForBranch error:",
                    err,
                  );
                });
            }
          })
          .catch((err: unknown) => {
            console.warn(
              "[analytics:session] captureRepoSnapshot error:",
              err,
            );
          });
      }
    } catch (err: unknown) {
      console.warn("[analytics:session] session_start handler error:", err);
    }
  });

  // ── session_shutdown ───────────────────────────────────────────────────────

  pi.on(
    "session_shutdown",
    async (rawEvent: unknown, piCtx: PiContextStub) => {
      try {
        const event = rawEvent as PiSessionShutdownEvent;
        const sessionFile = piCtx.sessionManager.getSessionFile();
        const snapshot = getSnapshot(sessionFile);

        if (!snapshot) {
          // No registered session — can happen if session_start was missed
          // (e.g. extension loaded mid-session). Emit nothing.
          console.warn(
            "[analytics:session] session_shutdown fired without a registered session",
          );
          return;
        }

        const { sessionId, headShaStart, cwd } = snapshot;
        const now = Date.now();
        let branchEnd: string | null = null;
        let headShaEnd: string | null = null;

        // Capture end-of-session git state synchronously (we're in the shutdown
        // path, so we await here — pi waits for async event handlers).
        if (config.git.enabled) {
          try {
            const endSnapshot = await captureRepoSnapshot(exec, cwd);
            if (endSnapshot) {
              branchEnd = endSnapshot.branch;
              headShaEnd = endSnapshot.headSha;

              // Emit diff-derived commit_made and file_touched events.
              if (headShaStart && headShaEnd && headShaStart !== headShaEnd) {
                try {
                  const diff = await getDiffSummary(
                    exec,
                    cwd,
                    headShaStart,
                    headShaEnd,
                  );

                  for (const commit of diff.commits) {
                    sink.write({
                      kind: "commit_made",
                      ts: now,
                      session_id: sessionId,
                      turn_id: null, // not associated with a specific turn
                      sha: commit.sha,
                      subject: commit.subject,
                      files_changed: commit.filesChanged,
                      insertions: commit.insertions,
                      deletions: commit.deletions,
                    });
                  }

                  // Emit file_touched for every file in the diff range.
                  // These use op="bash-derived" and a synthetic tool_call_id
                  // so they can be distinguished from tool-level observations.
                  // queries that want unique paths should use SELECT DISTINCT.
                  const syntheticTcId = `session-end:${sessionId}`;
                  for (const file of diff.files) {
                    sink.write({
                      kind: "file_touched",
                      ts: now,
                      tool_call_id: syntheticTcId,
                      session_id: sessionId,
                      path: file.path,
                      op: "bash-derived",
                      bytes: file.insertions + file.deletions,
                      sensitive: false,
                    });
                  }
                } catch (err: unknown) {
                  console.warn(
                    "[analytics:session] getDiffSummary error:",
                    err,
                  );
                }
              }

              // Final PR sweep — pick up PRs created right at session end or
              // created outside pi (on the web, in another terminal, etc.).
              if (config.git.fetchPR) {
                // Fire-and-forget since we're at the very end anyway.
                listOpenPrsForBranch(
                  exec,
                  cwd,
                  branchEnd,
                  config.git.ghTimeoutMs,
                )
                  .then((prs) => {
                    for (const pr of prs) {
                      sink.write({
                        kind: "pr_association",
                        ts: Date.now(),
                        session_id: sessionId,
                        repo_remote: endSnapshot.repoRemote ?? "",
                        pr_number: pr.number,
                        pr_url: pr.url,
                        confidence: 0.8,
                        reason: "branch-match",
                      });
                    }
                  })
                  .catch((err: unknown) => {
                    console.warn(
                      "[analytics:session] listOpenPrsForBranch at shutdown error:",
                      err,
                    );
                  });
              }
            }
          } catch (err: unknown) {
            console.warn(
              "[analytics:session] captureRepoSnapshot at shutdown error:",
              err,
            );
          }
        }

        // Emit session_end with end-of-session state.
        sink.write({
          kind: "session_end",
          ts: now,
          session_id: sessionId,
          ended_at: now,
          branch_end: branchEnd,
          head_sha_end: headShaEnd,
          exit_reason: event.reason,
        });

        // Remove from registry — session is over.
        clearSession(sessionFile);
      } catch (err: unknown) {
        console.warn(
          "[analytics:session] session_shutdown handler error:",
          err,
        );
      }
    },
  );

  // ── model_select ──────────────────────────────────────────────────────────

  pi.on("model_select", (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = rawEvent as PiModelSelectEvent;
      const sessionFile = piCtx.sessionManager.getSessionFile();
      const sessionId = getActiveSessionId(sessionFile);
      if (!sessionId) return; // no active session (extension loaded mid-session?)

      sink.write({
        kind: "model_select",
        ts: Date.now(),
        session_id: sessionId,
        model_id: event.model.id,
        provider: event.model.provider ?? null,
      });
    } catch (err: unknown) {
      console.warn("[analytics:session] model_select handler error:", err);
    }
  });

  // ── thinking_level_select ─────────────────────────────────────────────────

  pi.on("thinking_level_select", (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = rawEvent as PiThinkingLevelSelectEvent;
      const sessionFile = piCtx.sessionManager.getSessionFile();
      const sessionId = getActiveSessionId(sessionFile);
      if (!sessionId) return;

      sink.write({
        kind: "thinking_level_select",
        ts: Date.now(),
        session_id: sessionId,
        turn_id: null, // T8 may refine this to attach to a turn if needed
        thinking_level: event.level,
      });
    } catch (err: unknown) {
      console.warn(
        "[analytics:session] thinking_level_select handler error:",
        err,
      );
    }
  });
}
