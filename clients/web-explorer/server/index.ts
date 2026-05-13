import type { Database } from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openReadOnly, defaultDatabasePath } from "./db.js";
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
import { listHarnesses, getSchemaVersion } from "./queries/meta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { port: number; dbPath: string | undefined; noOpen: boolean } {
  let port = 3741;
  let dbPath: string | undefined;
  let noOpen = false;

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
    }
  }

  return { port, dbPath, noOpen };
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
// Build Hono app
// ---------------------------------------------------------------------------

function buildApp(db: Database, dbPath: string) {
  const app = new Hono();

  app.use("*", cors({ origin: "*" }));

  // Health
  app.get("/api/health", (c) => {
    const schemaVersion = getSchemaVersion(db);
    return c.json({ ok: true, dbPath, schemaVersion });
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
    let cursor: { started_at: number; id: string } | undefined;
    if (cursorParam) {
      const [sa, id] = cursorParam.split(":");
      if (sa && id) cursor = { started_at: parseInt(sa), id };
    }
    return c.json(listSessions(db, { ...opts, limit, cursor }));
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

  // Static files in production
  if (process.env.NODE_ENV === "production") {
    const distClient = join(__dirname, "..", "..", "dist", "client");
    app.use(
      "/*",
      serveStatic({ root: distClient })
    );
    app.notFound((c) => {
      const html = readFileSync(join(distClient, "index.html"), "utf-8");
      return c.html(html);
    });
  }

  return app;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const { port: preferredPort, dbPath: dbPathArg, noOpen } = parseArgs(argv);
  const dbPath = dbPathArg ?? defaultDatabasePath();

  const opened = openReadOnly(dbPath);
  if (!opened.ok) {
    console.error(`Error: ${opened.reason}`);
    process.exit(1);
  }

  const { db, close } = opened;

  process.on("SIGINT", () => { close(); process.exit(0); });
  process.on("SIGTERM", () => { close(); process.exit(0); });

  const port = await findFreePort(preferredPort);
  const app = buildApp(db, dbPath);
  const url = `http://localhost:${port}`;

  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    console.log(`Exploring at ${url}`);
    if (!noOpen) {
      import("open").then((m) => m.default(url)).catch(() => {});
    }
  });
}

// Run when executed directly
main(process.argv.slice(2));
