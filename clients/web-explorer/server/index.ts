import type { Database } from "better-sqlite3";
import { Hono } from "hono";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openReadOnly, defaultDatabasePath } from "./db.js";
import type { SchemaStatus } from "./db.js";
import {
  querySummary,
  queryDaily,
  queryComponents,
  queryHourly,
  queryModels,
  queryRepos,
  queryTools,
} from "./queries/analytics.js";
import { listSessions, getSession, getTurnDetail } from "./queries/sessions.js";
import { listHarnesses } from "./queries/meta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  port: number;
  dbPath: string | undefined;
  noOpen: boolean;
  /** Milliseconds before idle shutdown. null = no timeout. Default: 5 minutes. */
  idleTimeoutMs: number | null;
} {
  let port = 3741;
  let dbPath: string | undefined;
  let noOpen = false;
  // Default idle timeout: 5 minutes. Overridden by --idle-timeout <ms> or
  // disabled entirely by --no-idle-timeout.
  let idleTimeoutMs: number | null = 5 * 60 * 1000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--port" && argv[i + 1]) {
      port = parseInt(argv[++i]!, 10);
    } else if (arg.startsWith("--port=")) {
      port = parseInt(arg.slice(7), 10);
    } else if (arg === "--db" && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (arg.startsWith("--db=")) {
      dbPath = arg.slice(5);
    } else if (arg === "--no-open") {
      noOpen = true;
    } else if (arg === "--idle-timeout" && argv[i + 1]) {
      // The launcher passes the timeout in milliseconds as an integer string.
      idleTimeoutMs = parseInt(argv[++i]!, 10);
    } else if (arg.startsWith("--idle-timeout=")) {
      idleTimeoutMs = parseInt(arg.slice(15), 10);
    } else if (arg === "--no-idle-timeout") {
      idleTimeoutMs = null;
    }
  }

  return { port, dbPath, noOpen, idleTimeoutMs };
}

// ---------------------------------------------------------------------------
// Port availability check
// ---------------------------------------------------------------------------

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 10; p++) {
    if (await isPortFree(p)) return p;
  }
  return start;
}

// ---------------------------------------------------------------------------
// Query param helpers
// ---------------------------------------------------------------------------

function parseOpts(url: URL) {
  const from = parseInt(url.searchParams.get("from") ?? "0") || 0;
  const to = parseInt(url.searchParams.get("to") ?? String(Date.now())) || Date.now();
  const harnesses = url.searchParams.getAll("harness").filter(Boolean);
  const model = url.searchParams.get("model") ?? undefined;
  const repo = url.searchParams.get("repo") ?? undefined;
  return { from, to, harnesses: harnesses.length ? harnesses : undefined, model, repo };
}

// ---------------------------------------------------------------------------
// Clean shutdown
// ---------------------------------------------------------------------------

/**
 * Perform a clean shutdown: run optional runtime cleanup (remove the runtime
 * metadata file), close the SQLite connection, stop the HTTP server from
 * accepting new connections, then exit.
 *
 * Called from SIGINT/SIGTERM handlers and the idle-timeout loop. Using
 * process.exit(0) directly (rather than waiting for server.close callback)
 * because this is a short-lived local server and we don't want keep-alive
 * connections to delay an intentional shutdown.
 */
function shutdown(
  server: ServerType,
  dbClose: () => void,
  runtimeCleanup?: () => void,
): void {
  runtimeCleanup?.();
  dbClose();
  server.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Build Hono app
// ---------------------------------------------------------------------------

/**
 * Build the Hono application.
 *
 * @param updateActivity - Called on every /api/* request so the idle-timeout
 *   loop knows the browser is still actively using the server.
 */
function buildApp(
  db: Database,
  dbPath: string,
  updateActivity: () => void,
  schemaStatus: SchemaStatus = "ok",
  schemaVersion: number = 0,
) {
  const app = new Hono();

  // Track last activity time for all API requests. This middleware runs before
  // individual route handlers, so it fires regardless of which endpoint is hit.
  // Static file requests are intentionally excluded (they don't indicate active
  // browser use of the data layer).
  app.use("/api/*", async (_c, next) => {
    updateActivity();
    await next();
  });

  // Health — includes pid so the launcher can verify it's talking to the right
  // server process when checking for a reusable instance.
  app.get("/api/health", (c) => {
    // schemaStatus='degraded' means DB schema is ahead but within forward window.
    return c.json({ ok: true, dbPath, pid: process.pid, schemaVersion, schemaStatus });
  });

  // Heartbeat — browser sends this every 30 s to keep the idle timeout clock
  // reset while the tab is open. updateActivity() is already called by the
  // /api/* middleware above, so we just need to return a timestamp.
  app.post("/api/heartbeat", (c) => {
    return c.json({ ok: true, now: Date.now() });
  });

  // Harnesses
  app.get("/api/harnesses", (c) => {
    return c.json({ rows: listHarnesses(db) });
  });

  // Summary
  app.get("/api/summary", (c) => {
    const opts = parseOpts(new URL(c.req.url));
    return c.json(querySummary(db, opts));
  });

  // Daily
  app.get("/api/daily", (c) => {
    const opts = parseOpts(new URL(c.req.url));
    return c.json(queryDaily(db, opts));
  });

  // Components
  app.get("/api/components", (c) => {
    const opts = parseOpts(new URL(c.req.url));
    return c.json(queryComponents(db, opts));
  });

  // Hourly
  app.get("/api/hourly", (c) => {
    const opts = parseOpts(new URL(c.req.url));
    return c.json(queryHourly(db, opts));
  });

  // Models
  app.get("/api/models", (c) => {
    const opts = parseOpts(new URL(c.req.url));
    return c.json(queryModels(db, opts));
  });

  // Repos
  app.get("/api/repos", (c) => {
    const opts = parseOpts(new URL(c.req.url));
    return c.json(queryRepos(db, opts));
  });

  // Tools
  app.get("/api/tools", (c) => {
    const opts = parseOpts(new URL(c.req.url));
    return c.json(queryTools(db, opts));
  });

  // Sessions list
  app.get("/api/sessions", (c) => {
    const url = new URL(c.req.url);
    const opts = parseOpts(url);
    const limit = parseInt(url.searchParams.get("limit") ?? "50");
    const cursorParam = url.searchParams.get("cursor");
    const offset = cursorParam ? parseInt(cursorParam) || 0 : 0;
    const sort = url.searchParams.get("sort") ?? undefined;
    const dirParam = url.searchParams.get("dir");
    const dir = dirParam === "asc" || dirParam === "desc" ? dirParam : undefined;
    return c.json(listSessions(db, { ...opts, limit, offset, sort, dir }));
  });

  // Session detail
  app.get("/api/sessions/:id", (c) => {
    const { id } = c.req.param();
    const result = getSession(db, id);
    if (!result) return c.json({ error: "Session not found" }, 404);
    return c.json(result);
  });

  // Turn detail
  app.get("/api/sessions/:sessionId/turns/:turnId", (c) => {
    const { turnId } = c.req.param();
    const result = getTurnDetail(db, turnId);
    if (!result) return c.json({ error: "Turn not found" }, 404);
    return c.json(result);
  });

  // Static files — served whenever the dist/client build is present.
  // Not gated on NODE_ENV so the launcher works without setting it.
  const distClient = join(__dirname, "..", "..", "dist", "client");
  app.use(
    "/*",
    serveStatic({ root: distClient })
  );
  app.notFound((c) => {
    const html = readFileSync(join(distClient, "index.html"), "utf-8");
    return c.html(html);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Start the explorer server.
 *
 * @param argv - Raw CLI arguments (parsed internally by parseArgs). The
 *   launcher passes a constructed argv array even in foreground mode so the
 *   same parseArgs logic applies.
 * @param options.onShutdown - Optional callback invoked just before the
 *   process exits (SIGINT, SIGTERM, or idle timeout). Used by the launcher to
 *   remove the runtime metadata file.
 */
export async function main(
  argv: string[],
  options?: { onShutdown?: () => void },
): Promise<void> {
  const { port: preferredPort, dbPath: dbPathArg, noOpen, idleTimeoutMs } = parseArgs(argv);
  const dbPath = dbPathArg ?? defaultDatabasePath();

  const opened = openReadOnly(dbPath);
  if (!opened.ok) {
    console.error(`Error: ${opened.reason}`);
    process.exit(1);
  }

  const { db, close, schemaStatus, schemaVersion } = opened;

  // Warn about degraded mode on startup.
  if (schemaStatus === "degraded") {
    console.warn(
      `[web-explorer] Database schema version ${schemaVersion} is ahead of this build ` +
      `(max known: 1, forward window: 2). Operating in degraded read-only mode.`,
    );
  }

  // Activity timestamp — updated by the /api/* middleware on every API request.
  // Used by the idle-timeout loop to decide when to shut down.
  let lastActivityAt = Date.now();
  const updateActivity = () => {
    lastActivityAt = Date.now();
  };

  const port = await findFreePort(preferredPort);
  const app = buildApp(db, dbPath, updateActivity, schemaStatus, schemaVersion);
  const url = `http://127.0.0.1:${port}`;

  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    console.log(`Exploring at ${url}`);
    if (!noOpen) {
      import("open").then((m) => m.default(url)).catch(() => {});
    }
  });

  // Wire up SIGINT/SIGTERM to perform a clean shutdown.
  const doShutdown = () => shutdown(server, close, options?.onShutdown);
  process.on("SIGINT", doShutdown);
  process.on("SIGTERM", doShutdown);

  // Idle-timeout loop: check every 30 seconds whether the browser has been
  // inactive long enough to warrant shutting down. Skipped when idleTimeoutMs
  // is null (--no-idle-timeout).
  if (idleTimeoutMs !== null) {
    const checkInterval = setInterval(() => {
      if (Date.now() - lastActivityAt > idleTimeoutMs) {
        console.log(
          `Explorer idle for ${Math.round(idleTimeoutMs / 1000)}s — shutting down.`,
        );
        clearInterval(checkInterval);
        shutdown(server, close, options?.onShutdown);
      }
    }, 30_000);
    // Don't let the interval timer keep the process alive if everything else
    // has already exited (e.g., server closed externally).
    checkInterval.unref();
  }
}

// Run when executed directly (not when imported by the launcher for foreground
// mode). Using import.meta.url comparison avoids double-execution on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
