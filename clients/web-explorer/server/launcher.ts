/**
 * Web Explorer launcher — the single entry point invoked by `token-tally explore`.
 *
 * Responsibilities:
 *   - Idempotent server lifecycle: reuse an already-running explorer server
 *     when possible, or start a new one.
 *   - Runtime metadata: write on successful start, remove on --stop.
 *   - Browser opening and URL printing.
 *   - --stop: SIGTERM the recorded process and clean up runtime file.
 *   - Foreground mode (--foreground): call server main() in-process so the
 *     terminal stays attached.
 *   - Detached mode (default): spawn server as a background process and return
 *     to the caller immediately.
 *
 * This module is ESM (the web-explorer package uses "type": "module").
 * Import it via a native import() from the store CLI (CommonJS).
 */

import { spawn } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDatabasePath } from "./db.js";
import { readRuntime, writeRuntime, removeRuntime } from "./runtime.js";

// ESM equivalent of __dirname.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options passed from `token-tally explore` (store CLI) to launch(). */
export type ExploreOptions = {
  db?: string;
  /** Preferred server port. Default: 3741. */
  port?: number;
  /** Do not open a browser tab. */
  noOpen?: boolean;
  /** Print the explorer URL to stdout. */
  printUrl?: boolean;
  /** Stop the running server instead of starting one. */
  stop?: boolean;
  /** Idle auto-shutdown timeout in milliseconds. null = disabled. */
  idleTimeoutMs: number | null;
  /** Run server in the foreground (keeps the terminal attached). */
  foreground?: boolean;
};

// ---------------------------------------------------------------------------
// Duration parsing (exported for unit tests in T_tests)
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable duration string into milliseconds.
 *
 *   "30s"  →    30 000 ms
 *   "5m"   →   300 000 ms
 *   "1h"   → 3 600 000 ms
 *   "0"    →         0 ms
 *   "120"  →   120 000 ms  (bare integer treated as seconds)
 *
 * Throws on unrecognised formats.
 */
export function parseDuration(s: string): number {
  const t = s.trim();
  if (/^\d+s$/i.test(t)) return parseInt(t.slice(0, -1), 10) * 1_000;
  if (/^\d+m$/i.test(t)) return parseInt(t.slice(0, -1), 10) * 60_000;
  if (/^\d+h$/i.test(t)) return parseInt(t.slice(0, -1), 10) * 3_600_000;
  if (/^\d+$/.test(t)) return parseInt(t, 10) * 1_000;
  throw new Error(
    `Invalid duration "${s}". Use a value like "30s", "5m", or "1h".`,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Perform a GET request and return the body as a string. */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the /api/health endpoint across the port range the server might use
 * (preferredPort through preferredPort + 9, matching the server's findFreePort
 * window). Returns the actual base URL once the server with the expected PID
 * responds, or null if it does not start within the timeout.
 *
 * PID verification is essential: if a stale server is already running on the
 * preferred port (e.g. runtime file was manually deleted), we must not
 * confuse it with our freshly spawned server, which may be listening on a
 * nearby port instead.
 *
 * @param preferredPort - The port requested via --port.
 * @param expectedPid   - The PID of the process we are waiting for.
 *                        The health endpoint reports its own pid so we can
 *                        match exactly. For foreground mode pass process.pid.
 * @param maxAttempts   - Number of polling rounds. Each round waits 300 ms
 *                        before probing; default 15 rounds = ~4.5 s max.
 */
async function pollReady(
  preferredPort: number,
  expectedPid: number,
  maxAttempts = 15,
): Promise<string | null> {
  // The server picks the first free port in this window (see findFreePort in
  // server/index.ts). Check all candidates on each round so we handle the
  // common case (preferred port free) fast and the uncommon case (port busy,
  // server moves to port+1 or higher) without extra delay.
  const ports = Array.from({ length: 10 }, (_, i) => preferredPort + i);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(300);
    for (const port of ports) {
      try {
        const body = await httpGet(`http://127.0.0.1:${port}/api/health`);
        const parsed = JSON.parse(body) as { ok?: boolean; pid?: number };
        // Verify the PID to avoid mistaking a stale server on the preferred
        // port for our newly spawned process (which may be on a different port).
        if (parsed.ok === true && parsed.pid === expectedPid) {
          return `http://127.0.0.1:${port}`;
        }
      } catch {
        // Port not ready yet; try next.
      }
    }
  }
  return null;
}

/**
 * Open the given URL in the default browser.
 * Uses the `open` package (ESM-only, already a dependency of this package).
 * Failure is non-fatal: we log and continue.
 */
async function openBrowser(url: string): Promise<void> {
  try {
    const { default: open } = await import("open");
    await open(url);
  } catch (err) {
    // Best-effort: if open fails (e.g., headless environment) just warn.
    process.stderr.write(
      `token-tally explore: could not open browser — ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Launch or reuse the web explorer server.
 *
 * Returns a process exit code: 0 for success, 1 for failure.
 * For detached mode, returns 0 as soon as the server is ready and the browser
 * has been opened. For foreground mode, keeps the process alive until the
 * server exits.
 */
export async function launch(options: ExploreOptions): Promise<number> {
  // ── --stop ──────────────────────────────────────────────────────────────
  if (options.stop) {
    const meta = readRuntime();
    if (!meta) {
      process.stdout.write("token-tally: No explorer server is running.\n");
      return 0;
    }

    try {
      process.kill(meta.pid, "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        // ESRCH = no such process (already exited). Anything else is unexpected.
        process.stderr.write(
          `token-tally explore --stop: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      // Either way, remove the stale runtime file and report success.
    }

    removeRuntime();
    process.stdout.write("token-tally: Explorer server stopped.\n");
    return 0;
  }

  // ── Resolve the DB path ─────────────────────────────────────────────────
  // Resolve now so we can compare against the running server's dbPath, which
  // is also an absolute path (the server was launched with the resolved path).
  const resolvedDbPath = path.resolve(options.db ?? defaultDatabasePath());

  // ── Reuse check ─────────────────────────────────────────────────────────
  const existingMeta = readRuntime();
  if (existingMeta) {
    let isHealthy = false;
    let runningDbPath: string | undefined;

    try {
      const body = await httpGet(`${existingMeta.url}/api/health`);
      const health = JSON.parse(body) as { ok?: boolean; dbPath?: string };
      isHealthy = health.ok === true;
      runningDbPath = health.dbPath;
    } catch {
      // Server not responding — treat as stale.
    }

    if (!isHealthy) {
      // Stale runtime file: server is gone.
      removeRuntime();
      // Fall through to start a new server.
    } else if (runningDbPath !== resolvedDbPath) {
      // Live server, but for a different database. Refuse to start a second
      // one silently — the user needs to --stop first.
      process.stderr.write(
        "token-tally: Explorer is already running for a different database.\n" +
          `  Running:   ${runningDbPath ?? "(unknown)"}\n` +
          `  Requested: ${resolvedDbPath}\n` +
          "  Run `token-tally explore --stop` first, or omit --db to reuse the existing server.\n",
      );
      return 1;
    } else {
      // Healthy server, same DB — reuse it.
      const url = existingMeta.url;
      process.stdout.write(`token-tally: Reusing explorer at ${url}\n`);
      if (options.printUrl) process.stdout.write(`${url}\n`);
      if (!options.noOpen) await openBrowser(url);
      return 0;
    }
  }

  // ── Build server argv ────────────────────────────────────────────────────
  // Always pass --no-open to the server; the launcher owns browser opening.
  // Idle timeout is forwarded as milliseconds (already parsed by the CLI).
  const preferredPort = options.port ?? 3741;
  const serverDistPath = path.join(__dirname, "index.js");

  const serverArgv: string[] = [
    "--port",
    String(preferredPort),
    "--db",
    resolvedDbPath,
    "--no-open",
  ];

  if (options.idleTimeoutMs === null) {
    serverArgv.push("--no-idle-timeout");
  } else {
    // Pass the already-parsed millisecond value. The server's parseArgs reads
    // this with parseInt() and uses it directly as milliseconds.
    serverArgv.push("--idle-timeout", String(options.idleTimeoutMs ?? 300_000));
  }

  // ── Foreground mode ───────────────────────────────────────────────────────
  if (options.foreground) {
    // Import the server module and call main() in-process. The server starts
    // asynchronously — main() returns a Promise<void> that resolves once the
    // server has started up (serve() callback fires). The process then stays
    // alive because of the active HTTP server socket.
    const { main: serverMain } = await import("./index.js");

    // Start the server concurrently — do NOT await yet.
    // onShutdown removes the runtime file when the server decides to exit.
    const serverPromise = serverMain(serverArgv, { onShutdown: removeRuntime });

    // Poll until the server accepts connections. Pass process.pid because in
    // foreground mode the server runs inside this process.
    const actualUrl = await pollReady(preferredPort, process.pid);
    if (!actualUrl) {
      process.stderr.write(
        "token-tally explore: server did not start within timeout.\n",
      );
      process.exit(1);
    }

    // Write runtime so `--stop` works against foreground servers too.
    const port = parseInt(new URL(actualUrl).port, 10);
    writeRuntime({
      pid: process.pid,
      port,
      host: "127.0.0.1",
      url: actualUrl,
      apiBaseUrl: actualUrl,
      dbPath: resolvedDbPath,
      startedAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    if (options.printUrl) process.stdout.write(`${actualUrl}\n`);
    if (!options.noOpen) await openBrowser(actualUrl);

    // Keep the process alive until the server exits (via idle timeout,
    // SIGTERM, or SIGINT). The server calls process.exit(0) in its shutdown
    // handler, which also calls removeRuntime() via onShutdown.
    await serverPromise;
    return 0;
  }

  // ── Detached mode (default) ───────────────────────────────────────────────
  const child = spawn("node", [serverDistPath, ...serverArgv], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  if (!child.pid) {
    process.stderr.write(
      "token-tally explore: failed to spawn server process.\n",
    );
    return 1;
  }

  const spawnedPid = child.pid;

  // Poll until the server is ready. Pass the spawned PID so we don't
  // mistake a stale server on the preferred port for our new one.
  const actualUrl = await pollReady(preferredPort, spawnedPid);
  if (!actualUrl) {
    process.stderr.write(
      "token-tally explore: server did not start within timeout.\n" +
        `  Expected it near http://127.0.0.1:${preferredPort}.\n` +
        "  Is the database accessible? Run `token-tally doctor` to check.\n",
    );
    return 1;
  }

  // Write runtime file now that we know the actual URL and the server's PID.
  const port = parseInt(new URL(actualUrl).port, 10);
  writeRuntime({
    pid: spawnedPid,
    port,
    host: "127.0.0.1",
    url: actualUrl,
    apiBaseUrl: actualUrl,
    dbPath: resolvedDbPath,
    startedAt: Date.now(),
    lastSeenAt: Date.now(),
  });

  if (options.printUrl) process.stdout.write(`${actualUrl}\n`);
  if (!options.noOpen) await openBrowser(actualUrl);

  return 0;
}
