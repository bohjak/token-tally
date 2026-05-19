/**
 * session.ts — Session lifecycle hooks for the Pi writer extension.
 *
 * Handles:
 *   session_start    — records harness + session to the central store;
 *                      fires async git capture to fill in repo metadata.
 *   session_shutdown — records session end time; must NOT close the writer
 *                      (the extension entrypoint owns close).
 *   model_select     — updates the per-session active model tracker so
 *                      turn_start can denormalize it without model_select
 *                      being in every turn payload.
 *
 * ## Idempotency
 * The writer uses INSERT ... ON CONFLICT DO UPDATE on UNIQUE (harness_id,
 * harness_session_id). Re-calling recordSession() with the same harnessSessionId
 * upserts (updates) the existing row and returns the original UUID — no
 * duplicate rows.
 *
 * ## Async git capture
 * captureRepoSnapshot runs fire-and-forget after recordSession returns.
 * A second recordSession() upsert fills in repo fields once capture resolves.
 * If Pi exits before capture resolves, the session row has null git fields —
 * acceptable for the MVP.
 */

import type { AnalyticsWriterLike } from "../cli-writer.ts";
import type { PiAPIStub, PiContextStub, ExecFn } from "./types.ts";
import {
  setSession,
  getSession,
  patchSession,
  clearSession,
} from "./session-state.ts";
import {
  setActiveModel,
  clearModel,
  clearTurn,
} from "./turn-state.ts";
import { captureRepoSnapshot } from "../git/capture.ts";

// ---------------------------------------------------------------------------
// Pi event payload shapes
// ---------------------------------------------------------------------------

type PiModel = { id: string; provider?: string };

type PiModelSelectEvent = {
  model: PiModel;
  source: string;
};

// ---------------------------------------------------------------------------
// register() — the single public export
// ---------------------------------------------------------------------------

/**
 * Register all session-related event handlers.
 *
 * @param pi       Pi ExtensionAPI (or compatible stub).
 * @param writer   The open AnalyticsWriter — shared for the extension lifetime.
 * @param harnessVersion  Detected Pi version string (e.g. "1.0.0").
 * @param integrationVersion  This writer extension's version.
 * @param exec     Injected shell executor for git capture.
 */
export function register(
  pi: PiAPIStub,
  writer: AnalyticsWriterLike,
  harnessVersion: string,
  integrationVersion: string,
  exec: ExecFn,
): void {

  // ── session_start ─────────────────────────────────────────────────────────

  pi.on("session_start", async (_rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const sessionFile = piCtx.sessionManager.getSessionFile();
      const cwd = piCtx.cwd;
      const now = Date.now();

      // Synthesize a stable harness-level session ID from the session file
      // path. When Pi has no session file (ephemeral mode), fall back to a
      // cwd + timestamp composite — not perfectly stable on replay, but the
      // idempotency key still deduplicates within a single run.
      const harnessSessionId =
        sessionFile != null && sessionFile !== ""
          ? sessionFile
          : `ephemeral:${cwd}:${now}`;

      // Register harness identity (upserts on harnesses.name — fast, idempotent).
      await writer.recordHarness({
        name: "pi",
        displayName: "Pi",
        version: harnessVersion,
        integrationVersion,
      });

      // Insert/upsert the session row (repo fields are null until git resolves).
      const sessionResult = await writer.recordSession({
        harnessId: "pi",
        harnessSessionId,
        sessionFile: sessionFile ?? undefined,
        cwd,
        startedAt: now,
      });

      // Store session state so turn/message/tool hooks can look up the UUID.
      setSession(sessionFile, {
        harnessSessionId,
        centralSessionId: sessionResult.id,
        cwd,
        headShaStart: null,
        branchStart: null,
      });

      // Fire-and-forget git capture. When it resolves, upsert the session row
      // with repo metadata. Errors here must never surface to Pi.
      captureRepoSnapshot(exec, cwd)
        .then(async (snapshot) => {
          if (snapshot == null) return;

          // Update in-process state so session_shutdown can use headShaStart.
          patchSession(sessionFile, {
            headShaStart: snapshot.headSha,
            branchStart: snapshot.branch,
          });

          // Upsert session row with git metadata (same idempotency key).
          await writer.recordSession({
            harnessId: "pi",
            harnessSessionId,
            sessionFile: sessionFile ?? undefined,
            cwd,
            repoOwner: snapshot.repoOwner ?? undefined,
            repoName: snapshot.repoName ?? undefined,
            repoRemote: snapshot.repoRemote ?? undefined,
            startedAt: now,
          });
        })
        .catch((err: unknown) => {
          console.warn("[pi-writer:session] captureRepoSnapshot error:", err);
        });
    } catch (err: unknown) {
      console.warn("[pi-writer:session] session_start error:", err);
    }
  });

  // ── session_shutdown ───────────────────────────────────────────────────────

  pi.on(
    "session_shutdown",
    async (_rawEvent: unknown, piCtx: PiContextStub) => {
      try {
        const sessionFile = piCtx.sessionManager.getSessionFile();
        const state = getSession(sessionFile);

        if (state == null) {
          // session_start was missed (extension loaded mid-session).
          console.warn(
            "[pi-writer:session] session_shutdown without registered session",
          );
          return;
        }

        const now = Date.now();

        // Update the session row with the end time (upserts on same idempotency key).
        await writer.recordSession({
          harnessId: "pi",
          harnessSessionId: state.harnessSessionId,
          sessionFile: sessionFile ?? undefined,
          cwd: state.cwd,
          startedAt: 0, // startedAt is preserved by the ON CONFLICT DO UPDATE
          endedAt: now,
        });

        // Clean up in-process state.
        clearTurn(state.centralSessionId);
        clearModel(state.centralSessionId);
        clearSession(sessionFile);
      } catch (err: unknown) {
        console.warn("[pi-writer:session] session_shutdown error:", err);
      }
    },
  );

  // ── model_select ──────────────────────────────────────────────────────────
  // Track the current model so turn_start can denormalize it.

  pi.on("model_select", (_rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = _rawEvent as PiModelSelectEvent;
      const sessionFile = piCtx.sessionManager.getSessionFile();
      const state = getSession(sessionFile);
      if (state == null) return;

      setActiveModel(state.centralSessionId, {
        modelId: event.model.id,
        provider: event.model.provider ?? null,
      });
    } catch (err: unknown) {
      console.warn("[pi-writer:session] model_select error:", err);
    }
  });
}
