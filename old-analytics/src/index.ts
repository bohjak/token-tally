/**
 * index.ts — pi analytics extension entrypoint (T15).
 *
 * Pure wiring: loads config, constructs sinks, registers hooks, and wires up
 * the PR linker + /usage command.  No analytics logic lives here.
 *
 * ## ExtensionAPI typing
 * `@mariozechner/pi-coding-agent` is not in our local node_modules — it is
 * provided at runtime by pi's module resolver.  We alias `ExtensionAPI` to
 * `any` (matching T6–T10's PiAPIStub duck-typing approach) so `tsc --noEmit`
 * passes without the external package.  This is intentional; the real type is
 * imported by pi itself before calling our default export.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtensionAPI = any;

import { readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import type { AnalyticsConfig } from "./sinks/types.ts";
import { MultiSink } from "./sinks/types.ts";
import { SqliteSink } from "./sinks/sqlite.ts";
import { NdjsonSink } from "./sinks/ndjson.ts";
import type { ExecFn } from "./git/capture.ts";
import { PrLinker } from "./git/pr-linker.ts";
import { detectGitOps } from "./git/bash-detect.ts";
import { getActiveSessionId } from "./hooks/session-state.ts";
import type { HookContext } from "./hooks/types.ts";
import { register as registerSession } from "./hooks/session.ts";
import { register as registerInput } from "./hooks/input.ts";
import { register as registerTurn } from "./hooks/turn.ts";
import { register as registerMessage } from "./hooks/message.ts";
import { register as registerTool } from "./hooks/tool.ts";
import {
  runUsageJson,
  runUsageInteractive,
  parseUsageArgs,
} from "./commands/usage.ts";
import { runDoctor, formatDoctorText, backfillTurnModels, healStaleSessions } from "./commands/doctor.ts";

// ---------------------------------------------------------------------------
// Defaults (mirrors PLAN.md Settings)
// ---------------------------------------------------------------------------

const CONFIG_DEFAULTS: AnalyticsConfig = {
  local: {
    enabled: true,
    dbPath: "~/.pi/analytics/events.db",
    rawLogDir: "~/.pi/analytics/raw",
  },
  privacy: {
    storePrompts: "hashed",
    storeToolArgs: "summary",
    storeToolOutputs: "size-only",
    redactPatterns: ["api[_-]?key", "bearer\\s+\\S+", "ghp_\\w+"],
  },
  git: {
    enabled: true,
    fetchPR: true,
    ghTimeoutMs: 2000,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep-merge `overrides` into `base` (one level only — sufficient for our
 *  three-level config shape). Returns a new object. */
function mergeConfig(
  base: AnalyticsConfig,
  overrides: Partial<Record<string, unknown>>,
): AnalyticsConfig {
  return {
    local: { ...base.local, ...(overrides.local as object | undefined) },
    privacy: { ...base.privacy, ...(overrides.privacy as object | undefined) },
    git: { ...base.git, ...(overrides.git as object | undefined) },
  };
}

/** Expand a leading `~` to the real home directory. */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/** Load and merge config.json, falling back to defaults on any error. */
function loadConfig(): AnalyticsConfig {
  const candidates: string[] = [];

  // Primary: resolve config.json relative to this file (extension dir).
  try {
    const thisFile = fileURLToPath(import.meta.url);
    candidates.push(join(dirname(thisFile), "..", "config.json"));
  } catch {
    // import.meta.url may be unavailable in some pi execution environments.
  }
  // Fallback: well-known global path.
  candidates.push(join(homedir(), ".pi", "agent", "extensions", "analytics", "config.json"));

  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      return mergeConfig(CONFIG_DEFAULTS, raw);
    } catch {
      // Try next candidate.
    }
  }

  console.warn("[analytics] config.json not found; using defaults.");
  return { ...CONFIG_DEFAULTS };
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
  try {
    // ── 1. Config ──────────────────────────────────────────────────────────
    const rawConfig = loadConfig();
    const config: AnalyticsConfig = {
      ...rawConfig,
      local: {
        ...rawConfig.local,
        dbPath: expandHome(rawConfig.local.dbPath),
        rawLogDir: expandHome(rawConfig.local.rawLogDir),
      },
    };

    if (!config.local.enabled) {
      // Extension is explicitly disabled — do nothing and get out of the way.
      return;
    }

    // ── 2. Sinks ───────────────────────────────────────────────────────────
    const sqlite = new SqliteSink();
    const ndjson = new NdjsonSink();

    // Init sinks sequentially; individual failures are swallowed by each sink
    // but we still need to init both before wrapping in MultiSink.
    await sqlite.init(config);
    await ndjson.init(config);

    const sink = new MultiSink([sqlite, ndjson]);

    // ── 3. ExecFn adapter ──────────────────────────────────────────────────
    //
    // pi.exec returns { stdout, stderr, code, killed }.
    // ExecFn (T11 contract) returns { stdout, stderr, exitCode }.
    // We bridge the two shapes here so hooks receive a clean ExecFn.
    const exec: ExecFn = async (cmd, args, opts) => {
      try {
        const r = await pi.exec(cmd, args, opts ?? {});
        return {
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
          exitCode: r.code ?? 0,
        };
      } catch (err) {
        // pi.exec may throw if the binary is not found etc.
        console.warn("[analytics] exec error:", err);
        return { stdout: "", stderr: String(err), exitCode: 1 };
      }
    };

    // ── 4. Hook registration ───────────────────────────────────────────────
    //
    // HookContext carries the resolved config and ExecFn.  Hooks close over it
    // via their register() call — no global state in the hook modules.
    const hookCtx: HookContext = { config, exec };

    // Cast to `any` (PiAPIStub duck-typing) — intentional, see file header.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const piStub = pi as any;

    registerSession(piStub, sink, hookCtx);
    registerInput(piStub, sink, hookCtx);
    registerTurn(piStub, sink, hookCtx);
    registerMessage(piStub, sink, hookCtx);
    registerTool(piStub, sink, hookCtx);

    // ── 5. PR linker ───────────────────────────────────────────────────────
    const linker = new PrLinker(sqlite, exec, {
      ghTimeoutMs: config.git.ghTimeoutMs,
      precedingWindowMs: 24 * 60 * 60 * 1000, // 24h default
    });

    // Eager link: detect `git push` / `gh pr create` via tool_result and
    // schedule linkSession for the active session.
    //
    // We re-run detectGitOps here (rather than relying on an internal signal
    // from the tool hook) to keep T10 self-contained.  The duplication is
    // intentional and cheap — detectGitOps is a pure synchronous parser.
    // Hoisted so the shutdown handler can clearInterval() it whether or not
    // git.enabled is set (TypeScript-friendly form, no var hoisting tricks).
    let dailyInterval: ReturnType<typeof setInterval> | undefined;

    if (config.git.enabled) {
      pi.on(
        "tool_result",
        async (rawEvent: unknown, ctx: { cwd: string; sessionManager: { getSessionFile(): string | null } }) => {
          try {
            const event = rawEvent as {
              toolName?: string;
              toolInput?: { command?: string };
            };
            if (event.toolName !== "bash") return;
            const command = event.toolInput?.command ?? "";
            if (!command) return;

            const ops = detectGitOps(command);
            const hasSideEffect = ops.some(
              (op) => op.kind === "git-push" || op.kind === "gh-pr-create",
            );
            if (!hasSideEffect) return;

            const sessionId = getActiveSessionId(
              ctx.sessionManager?.getSessionFile?.() ?? null,
            );
            if (!sessionId) return;

            // Fire-and-forget — errors logged inside linkSession.
            linker
              .linkSession(sessionId)
              .catch((err) =>
                console.warn("[analytics] eager PR link failed:", err),
              );
          } catch (err) {
            console.warn("[analytics] tool_result PR linker hook error:", err);
          }
        },
      );

      // Daily background sweep — fire-and-forget, unref'd so it doesn't keep
      // the Node process alive after pi exits.
      dailyInterval = setInterval(
        () => {
          try {
            const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            // Query distinct repos seen in the last 7 days via the raw DB.
            const db = sqlite.database;
            if (!db) return;
            const rows = db
              .prepare(
                `SELECT DISTINCT repo_remote FROM sessions
                 WHERE repo_remote IS NOT NULL AND started_at >= ?`,
              )
              .all(sevenDaysAgo) as { repo_remote: string }[];

            for (const { repo_remote } of rows) {
              linker
                .sweepRecent(repo_remote, sevenDaysAgo)
                .catch((err) =>
                  console.warn(
                    `[analytics] daily sweep failed for ${repo_remote}:`,
                    err,
                  ),
                );
            }
          } catch (err) {
            console.warn("[analytics] daily PR sweep error:", err);
          }
        },
        24 * 60 * 60 * 1000,
      );
      // Do not keep the process alive just for the sweep timer.
      dailyInterval?.unref?.();
    }

    // ── 6. /usage command ──────────────────────────────────────────────────
    pi.registerCommand("usage", {
      description:
        "Show analytics: cost, tokens, tools, repos. Flags: --json [--tab=summary|models|repos|tools|prs|daily] [--since=24h|7d|month|all]",
      handler: async (rawArgs: string, ctx: { cwd: string; ui: { notify: (msg: string, kind?: string) => void } }) => {
        try {
          // Best-effort lazy PR sweep for current repo (≤2s).
          if (config.git.enabled) {
            try {
              const db = sqlite.database;
              if (db) {
                const sessionRemote = db
                  .prepare(
                    `SELECT repo_remote FROM sessions
                     WHERE cwd = ? AND repo_remote IS NOT NULL
                     ORDER BY started_at DESC LIMIT 1`,
                  )
                  .get(ctx.cwd ?? "") as { repo_remote: string } | undefined;

                if (sessionRemote?.repo_remote) {
                  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                  await Promise.race([
                    linker.sweepRecent(sessionRemote.repo_remote, sevenDaysAgo),
                    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
                  ]);
                }
              }
            } catch {
              // Sweep is best-effort — don't block the command.
            }
          }

          // Parse args and dispatch.
          const argv = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
          const args = parseUsageArgs(argv);

          if (args.json) {
            const data = runUsageJson(sqlite, {
              tab: args.tab,
              since: args.since,
            });
            const json = JSON.stringify(data, null, 2);
            // In -p (print) mode pi calls takeOverStdout() which reroutes
            // process.stdout.write — and therefore console.log — to stderr,
            // reserving real stdout for the agent's response.  ui.notify is
            // a no-op in print mode.  We bypass both by writing straight to
            // fd 1 (raw stdout) so /usage --json output is pipe-able.
            if ((ctx as unknown as { hasUI?: boolean }).hasUI === false) {
              writeSync(1, json + "\n");
            } else {
              ctx.ui.notify(json, "info");
            }
            return;
          } else {
            await runUsageInteractive(pi as unknown as { on: (...a: unknown[]) => void }, sqlite, ctx as Parameters<typeof runUsageInteractive>[2], rawArgs);
          }
        } catch (err) {
          ctx.ui.notify(`[analytics:usage] ${String(err)}`, "error");
        }
      },
    });

    // ── 6b. /analytics doctor command ─────────────────────────────
    pi.registerCommand("analytics doctor", {
      description: "Run analytics DB invariant checks. Flags: --json --backfill --heal-stale-sessions",
      handler: async (rawArgs: string, ctx: { ui: { notify: (msg: string, kind?: string) => void } }) => {
        try {
          const wantJson  = (rawArgs ?? "").includes("--json");
          const wantBackfill = (rawArgs ?? "").includes("--backfill");
          const wantHeal  = (rawArgs ?? "").includes("--heal-stale-sessions");
          // See note in /usage handler: in print mode console.log is rerouted
          // to stderr by pi's output-guard.  Use raw fd 1 to reach real stdout.
          const noPiUi = (ctx as unknown as { hasUI?: boolean }).hasUI === false;
          const writeStdout = (s: string) => writeSync(1, s + "\n");
          const notify = (s: string, kind = "info") =>
            noPiUi ? writeStdout(s) : ctx.ui.notify(s, kind);

          if (wantBackfill) {
            const { updated } = backfillTurnModels(sqlite);
            const msg = `Backfilled model_id for ${updated} turn(s).`;
            notify(wantJson ? JSON.stringify({ updated }) : msg);
            if (!wantHeal) return;
          }

          if (wantHeal) {
            // Show state before so the user can see what gets fixed.
            const before = runDoctor(sqlite, { rawLogDir: config.local.rawLogDir });
            notify(
              wantJson ? JSON.stringify(before, null, 2) : formatDoctorText(before),
              before.ok ? "info" : "error",
            );
            const { healed } = healStaleSessions(sqlite);
            const healMsg = `Healed ${healed} stale session(s).`;
            notify(wantJson ? JSON.stringify({ healed }) : healMsg);
            // Show state after so the user sees stale_sessions is resolved.
            const after = runDoctor(sqlite, { rawLogDir: config.local.rawLogDir });
            notify(
              wantJson ? JSON.stringify(after, null, 2) : formatDoctorText(after),
              after.ok ? "info" : "error",
            );
            return;
          }

          const report = runDoctor(sqlite, { rawLogDir: config.local.rawLogDir });
          const out = wantJson ? JSON.stringify(report, null, 2) : formatDoctorText(report);
          notify(out, report.ok ? "info" : "error");
        } catch (err) {
          ctx.ui.notify(`[analytics:doctor] ${String(err)}`, "error");
        }
      },
    });

    // ── 7. Shutdown — register LAST ────────────────────────────────────────
    //
    // Registering after all other handlers ensures shutdown runs after the
    // hooks have emitted their final events (session_end, etc.).
    pi.on("session_shutdown", async () => {
      try {
        // Stop the daily PR sweep timer so it can't fire against a closed sink.
        if (dailyInterval) clearInterval(dailyInterval);
        await sink.flush();
        await sink.close();
      } catch (err) {
        console.warn("[analytics] error during shutdown flush/close:", err);
      }
    });
  } catch (err) {
    // Top-level guard: a broken analytics extension must never crash pi.
    console.warn("[analytics] extension failed to initialize:", err);
  }
}
