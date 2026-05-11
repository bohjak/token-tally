/**
 * Pi usage command client — ToTally extension entrypoint.
 *
 * RESPONSIBILITIES (read-only)
 *   - Registers the `/usage` command: shows cost/token summaries, model
 *     breakdowns, repo breakdowns, tool stats, and daily cost charts.
 *   - Registers the `/analytics doctor` command: delegates to the
 *     `token-tally doctor` CLI to run central-store diagnostic checks.
 *
 * NON-RESPONSIBILITIES
 *   - Does NOT register any event hooks.
 *   - Does NOT write harness data or call AnalyticsWriter.
 *   - Does NOT run schema migrations.
 *
 * DB ACCESS
 *   Each command invocation opens the central SQLite store, runs queries,
 *   and closes immediately. The connection applies PRAGMA query_only = 1
 *   to guarantee read-only access for this connection's lifetime.
 *
 * EXTENSION SLUG
 *   Installed by `make install` as a symlink:
 *     ~/.pi/agent/extensions/token-tally-usage -> <repo>/clients/pi-usage-command
 */

// Pi's extension runtime is not available in our local node_modules.
// We alias ExtensionAPI to `unknown` so TypeScript accepts the default export
// signature without a real import. The runtime type is enforced by Pi itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtensionAPI = any;

import { writeSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { defaultDatabasePath, openReadOnly } from "./src/db.ts";
import { parseUsageArgs, runQuery } from "./src/queries.ts";
import { renderTab } from "./src/format.ts";
import { UsageTabsComponent } from "./src/usage-component.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Writes `text` to real stdout (file descriptor 1).
 *
 * In Pi's `-p` / print mode, `ctx.ui.notify` is a no-op and
 * `console.log` is rerouted to stderr by Pi's output-guard. Writing to
 * fd 1 directly bypasses both, making `/usage --json` output pipeable
 * to other tools.
 */
function writeStdout(text: string): void {
  writeSync(1, `${text}\n`);
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
  // Top-level guard: a broken read-only client must never crash Pi.
  try {
    registerUsageCommand(pi);
    registerDoctorCommand(pi);
  } catch (err) {
    console.warn("[token-tally:usage] extension failed to initialize:", err);
  }
}

// ---------------------------------------------------------------------------
// /usage command
// ---------------------------------------------------------------------------

function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description:
      "ToTally usage: cost, tokens, models, repos, tools, daily. " +
      "Flags: --json [--tab=summary|models|repos|tools|prs|daily] [--since=24h|7d|month|all]",

    handler: async (rawArgs: string, ctx: {
      ui: {
        notify: (msg: string, kind?: string) => void;
        custom?: <T = void>(
          factory: (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (value: T) => void
          ) => { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void }
        ) => Promise<T>;
      };
    }): Promise<void> => {
      // Detect print / non-interactive mode. Pi sets hasUI=false when running
      // in -p mode; notify() is a no-op and console.log is redirected.
      const noPiUi = (ctx as unknown as { hasUI?: boolean }).hasUI === false;
      const notify = (msg: string, kind = "info") =>
        noPiUi ? writeStdout(msg) : ctx.ui.notify(msg, kind);

      const args = parseUsageArgs(rawArgs ?? "");
      const dbPath = defaultDatabasePath();

      const openResult = openReadOnly(dbPath);
      if (!openResult.ok) {
        notify(
          `[token-tally:usage] ${openResult.reason}\n` +
          "Run 'token-tally migrate' to create the central database.",
          "error"
        );
        return;
      }

      const { db, close } = openResult;
      try {
        const tab = args.tab ?? "summary";
        const data = runQuery(db, { tab, since: args.since });

        if (args.json) {
          const json = JSON.stringify(data, null, 2);
          // In print mode write to raw fd 1 so output is pipe-able.
          if (noPiUi) {
            writeStdout(json);
          } else {
            ctx.ui.notify(json, "info");
          }
        } else if (!noPiUi && typeof ctx.ui.custom === "function") {
          await ctx.ui.custom((_tui, theme, _kb, done) =>
            new UsageTabsComponent({
              loadTab: (nextTab, since) => runQuery(db, { tab: nextTab, since }),
              initialTab: tab,
              since: args.since,
              theme: theme as { fg(c: string, t: string): string; bg(c: string, t: string): string },
              onClose: () => done(undefined),
            })
          );
        } else {
          const text = renderTab(tab, data);
          notify(text, "info");
        }
      } catch (err) {
        notify(`[token-tally:usage] query failed: ${String(err)}`, "error");
      } finally {
        close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// /analytics doctor command
// ---------------------------------------------------------------------------

function registerDoctorCommand(pi: ExtensionAPI): void {
  pi.registerCommand("analytics doctor", {
    description:
      "ToTally store diagnostics. Flags: --json. " +
      "Delegates to the 'token-tally doctor' CLI for full central-store checks.",

    handler: async (rawArgs: string, ctx: {
      ui: { notify: (msg: string, kind?: string) => void };
    }): Promise<void> => {
      const noPiUi = (ctx as unknown as { hasUI?: boolean }).hasUI === false;
      const notify = (msg: string, kind = "info") =>
        noPiUi ? writeStdout(msg) : ctx.ui.notify(msg, kind);

      const wantJson = (rawArgs ?? "").includes("--json");
      const dbPath = defaultDatabasePath();

      // Build the token-tally doctor arguments.
      // Always pass --json internally so we can forward structured output; if
      // the user did NOT ask for --json we re-format the output as plain text.
      const cliArgs = ["doctor", "--db", dbPath, "--json"];

      // Spawn token-tally doctor synchronously. This command is fast (sub-second)
      // and Pi command handlers are async, so blocking here is acceptable.
      const result = spawnSync("token-tally", cliArgs, {
        encoding: "utf8",
        timeout: 15_000,
      });

      if (result.error != null) {
        // token-tally binary not found or failed to spawn.
        notify(
          `[token-tally:doctor] Cannot run 'token-tally doctor': ${result.error.message}\n` +
          "Ensure the store CLI is installed: run 'make install' or 'cd store && pnpm link --global'.",
          "error"
        );
        return;
      }

      const output = result.stdout?.trim() ?? "";
      if (!output) {
        notify(
          `[token-tally:doctor] No output from 'token-tally doctor' (exit ${result.status ?? "?"}).\n` +
          (result.stderr ? `stderr: ${result.stderr.trim()}` : ""),
          "error"
        );
        return;
      }

      if (wantJson) {
        // Forward the raw JSON from the CLI unchanged.
        if (noPiUi) {
          writeStdout(output);
        } else {
          ctx.ui.notify(output, "info");
        }
        return;
      }

      // Re-format the JSON report as human-readable text.
      try {
        const report = JSON.parse(output) as {
          status: string;
          findings?: Array<{ severity: string; message: string }>;
          dbPath?: string;
        };
        const lines: string[] = [];
        const statusIcon = report.status === "ok" ? "✅" : "❌";
        lines.push(`ToTally doctor — ${statusIcon} ${report.status.toUpperCase()}`);
        lines.push(`Database: ${report.dbPath ?? dbPath}`);
        lines.push("");
        for (const f of report.findings ?? []) {
          const icon =
            f.severity === "ok" ? "✓" :
            f.severity === "warning" ? "⚠" : "✗";
          lines.push(`  ${icon}  ${f.message}`);
        }
        notify(lines.join("\n"), report.status === "ok" ? "info" : "error");
      } catch {
        // Unexpected non-JSON output — show it verbatim.
        notify(output, "info");
      }
    },
  });
}
