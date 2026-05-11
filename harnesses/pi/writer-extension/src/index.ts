/**
 * index.ts — Pi writer extension entrypoint for ToTally.
 *
 * Pure wiring: detects Pi version, opens AnalyticsWriter, registers hooks,
 * and closes the writer on session shutdown. No analytics logic lives here.
 *
 * ## What this extension does
 * - Writes sessions, turns, LLM messages, and tool calls to the central
 *   ToTally store at ~/.local/share/token-tally/events.db.
 * - Captures git repo metadata at session start/end (async, non-blocking).
 *
 * ## What this extension does NOT do
 * - Register /usage or /analytics doctor commands (those belong to the
 *   clients/pi-usage-command client extension).
 * - Store prompt text, assistant response text, tool arguments, or tool
 *   outputs (data minimisation per PLAN.md § Local data).
 * - Own database migrations (the AnalyticsWriter handles that).
 *
 * ## ExtensionAPI typing
 * @mariozechner/pi-coding-agent is not in local node_modules — it is
 * resolved at runtime by Pi's module loader. We alias ExtensionAPI to `any`
 * so `tsc --noEmit` passes without the external package. This is intentional.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtensionAPI = any;

import { createRequire } from "node:module";
import { AnalyticsWriter } from "@token-tally/store";
import type { ExecFn } from "./hooks/types.ts";
import { register as registerSession } from "./hooks/session.ts";
import { register as registerTurn } from "./hooks/turn.ts";
import { register as registerMessage } from "./hooks/message.ts";
import { register as registerTool } from "./hooks/tool.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Version of this writer integration — used for cost provenance tracing.
 * Keep in sync with package.json "version".
 */
const INTEGRATION_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect Pi's own version from its package.json. Returns "unknown" when the
 * package is not resolvable (e.g. local dev without Pi installed).
 */
function detectPiVersion(): string {
  try {
    // Pi provides @mariozechner/pi-coding-agent via its own module resolver
    // at runtime.  createRequire(import.meta.url) gives us synchronous CJS
    // require semantics that work across Pi's different loader configurations.
    const req = createRequire(import.meta.url);
    const pkg = req("@mariozechner/pi-coding-agent/package.json") as {
      version?: string;
    };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Expected in environments where the package is not installed locally.
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
  try {
    // ── 1. Detect Pi version ───────────────────────────────────────────────
    const harnessVersion = detectPiVersion();

    // ── 2. Open AnalyticsWriter ────────────────────────────────────────────
    // Opens the central SQLite DB, runs pending migrations, and drains any
    // closed NDJSON spool files from previous sessions. Falls back to
    // spool-only mode silently if the DB is unavailable.
    const writer = await AnalyticsWriter.open({ harnessName: "pi" });

    // ── 3. Build ExecFn adapter ───────────────────────────────────────────
    // Pi's pi.exec returns { stdout, stderr, code, killed }.
    // ExecFn expects { stdout, stderr, exitCode }. Bridge the two shapes.
    const exec: ExecFn = async (cmd, args, opts) => {
      try {
        const r = await (pi as {
          exec: (
            cmd: string,
            args: string[],
            opts: object,
          ) => Promise<{
            stdout?: string;
            stderr?: string;
            code?: number;
          }>;
        }).exec(cmd, args, opts ?? {});
        return {
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
          exitCode: r.code ?? 0,
        };
      } catch (err: unknown) {
        console.warn("[pi-writer] exec error:", err);
        return { stdout: "", stderr: String(err), exitCode: 1 };
      }
    };

    // ── 4. Register hooks ──────────────────────────────────────────────────
    // Cast to `any` to avoid importing @mariozechner/pi-coding-agent types —
    // the real runtime object is structurally compatible with our PiAPIStub.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const piStub = pi as any;

    registerSession(piStub, writer, harnessVersion, INTEGRATION_VERSION, exec);
    registerTurn(piStub, writer);
    registerMessage(piStub, writer);
    registerTool(piStub, writer);

    // ── 5. Shutdown — registered LAST ─────────────────────────────────────
    // Registering after all other handlers ensures shutdown fires after the
    // hooks have emitted their final events (session_shutdown in session.ts
    // updates ended_at; then this handler flushes and closes the writer).
    pi.on("session_shutdown", async () => {
      try {
        // spool.rotate() + drain happens inside writer.close().
        await writer.close();
      } catch (err: unknown) {
        console.warn("[pi-writer] error during writer close:", err);
      }
    });
  } catch (err: unknown) {
    // Top-level guard: a broken writer extension must never crash Pi.
    console.warn("[pi-writer] extension failed to initialize:", err);
  }
}
