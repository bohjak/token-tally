/**
 * cli-writer.ts — Pi-safe writer bridge for ToTally.
 *
 * The Pi extension must not import @token-tally/store at runtime: that package
 * loads better-sqlite3, whose native addon is compiled for the Node version
 * used during install. Pi itself is launched with `#!/usr/bin/env node`, so its
 * Node version can differ from the install/runtime used by ToTally.
 *
 * This bridge keeps the extension ABI-agnostic by spawning the installed
 * `token-tally` CLI with the Node executable recorded at install time. The
 * extension process only handles JSON and child processes; SQLite/native code
 * lives in the helper process.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HarnessPayload,
  LlmMessagePayload,
  RawEventPayload,
  SessionPayload,
  SubscriptionPayload,
  ToolCallPayload,
  TurnPayload,
} from "@token-tally/store";
import type { SpoolRecord } from "@token-tally/store";

// ---------------------------------------------------------------------------
// Public writer surface used by hook modules
// ---------------------------------------------------------------------------

export type WriteResult = { id: string };

export type AnalyticsWriterLike = {
  recordHarness(payload: HarnessPayload): Promise<WriteResult>;
  recordSession(payload: SessionPayload): Promise<WriteResult>;
  recordTurn(payload: TurnPayload): Promise<WriteResult>;
  recordLlmMessage(payload: LlmMessagePayload): Promise<WriteResult>;
  recordSubscription(payload: SubscriptionPayload): Promise<WriteResult>;
  recordToolCall(payload: ToolCallPayload): Promise<WriteResult>;
  recordRawEvent(payload: RawEventPayload): Promise<void>;
  close(): Promise<void>;
};

type RecordType =
  | "harness"
  | "session"
  | "turn"
  | "llm-message"
  | "subscription"
  | "tool-call"
  | "raw-event";

type InstallManifest = {
  repoPath?: unknown;
  nodePath?: unknown;
  components?: {
    store?: {
      nodePath?: unknown;
    };
  };
};

// ---------------------------------------------------------------------------
// Runtime discovery
// ---------------------------------------------------------------------------

// Must exceed the maximum SQLite busy-wait budget:
//   busy_timeout (5 000 ms, SQLite-internal) + withBusyRetry (10 000 ms) = 15 s.
// Add a generous process-startup buffer on top.
const DEFAULT_TIMEOUT_MS = 25_000;
const APP_DIR_NAME = "token-tally";

let emergencySpoolCounter = 0;

function extensionRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../..");
}

function readManifest(): InstallManifest | null {
  const path = join(homedir(), ".config/token-tally/install.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as InstallManifest;
  } catch {
    return null;
  }
}

function manifestString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nodeMajor(versionOutput: string): number | null {
  const match = versionOutput.trim().match(/^v?(\d+)\./);
  if (match == null) return null;
  return Number.parseInt(match[1], 10);
}

function probeNodeMajor(nodePath: string): number | null {
  if (!existsSync(nodePath)) return null;

  const result = spawnSyncText(nodePath, ["--version"], 2_000);
  if (result.code !== 0) return null;
  return nodeMajor(result.stdout);
}

function spawnSyncText(
  command: string,
  args: string[],
  timeoutMs: number,
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function findNodePath(manifest: InstallManifest | null): string {
  const candidates = [
    manifestString(manifest?.nodePath),
    manifestString(manifest?.components?.store?.nodePath),
    process.env.TOKEN_TALLY_NODE ?? null,
    process.execPath,
  ].filter((p): p is string => p != null);

  for (const candidate of candidates) {
    const major = probeNodeMajor(candidate);
    if (major != null && major >= 24) {
      return candidate;
    }
  }

  // Last resort for users of `n`: this does not depend on PATH's active node
  // alias, only on the `n` shim being available.
  const nProbe = spawnSyncText("n", ["which", "24"], 2_000);
  if (nProbe.code === 0) {
    const candidate = nProbe.stdout.trim();
    const major = probeNodeMajor(candidate);
    if (major != null && major >= 24) {
      return candidate;
    }
  }

  throw new Error(
    "No Node.js >= 24 runtime found for token-tally. Re-run `make install` " +
      "with Node 24, or set TOKEN_TALLY_NODE to an absolute Node 24 binary.",
  );
}

function findRepoRoot(manifest: InstallManifest | null): string {
  return manifestString(manifest?.repoPath) ?? extensionRepoRoot();
}

function defaultDataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const base = xdgDataHome != null && xdgDataHome !== ""
    ? xdgDataHome
    : join(homedir(), ".local", "share");
  return join(base, APP_DIR_NAME);
}

function defaultSpoolDir(): string {
  return join(defaultDataDir(), "spool");
}

/**
 * Returns the path to the SEA binary if it has been installed, otherwise null.
 * The SEA binary is installed by install-store.sh alongside better_sqlite3.node
 * in $XDG_DATA_HOME/token-tally/bin/.
 */
function findSeaBinary(): string | null {
  const binPath = join(defaultDataDir(), "bin", "token-tally");
  return existsSync(binPath) ? binPath : null;
}

function writeEmergencySpool(record: SpoolRecord): void {
  const spoolDir = defaultSpoolDir();
  mkdirSync(spoolDir, { recursive: true });

  const sequence = emergencySpoolCounter++;
  const baseName = `pi-extension-${process.pid}-${Date.now()}-${sequence}.ndjson`;
  const tmpPath = join(spoolDir, `${baseName}.tmp`);
  const closedPath = join(spoolDir, `${baseName}.closed`);

  writeFileSync(tmpPath, JSON.stringify(record) + "\n", "utf8");
  renameSync(tmpPath, closedPath);
}

function fallbackId(recordType: Exclude<RecordType, "raw-event">, payload: unknown): string {
  switch (recordType) {
    case "harness":
      return (payload as HarnessPayload).name;
    case "session": {
      const session = payload as SessionPayload;
      return `spool:${session.harnessId}:${session.harnessSessionId}`;
    }
    case "turn": {
      const turn = payload as TurnPayload;
      return `spool:${turn.sessionId}:${turn.harnessTurnId}`;
    }
    case "llm-message": {
      const message = payload as LlmMessagePayload;
      return `spool:${message.harnessId}:${message.harnessMessageId}`;
    }
    case "subscription": {
      const subscription = payload as SubscriptionPayload;
      return `spool:${subscription.harnessId}:${subscription.planName}:${subscription.periodStart}`;
    }
    case "tool-call": {
      const toolCall = payload as ToolCallPayload;
      return `spool:${toolCall.harnessId}:${toolCall.harnessToolCallId}`;
    }
  }
}

function spoolRecord(recordType: RecordType, payload: unknown): SpoolRecord {
  switch (recordType) {
    case "harness":
      return { type: "harness", payload: payload as HarnessPayload };
    case "session":
      return { type: "session", payload: payload as SessionPayload };
    case "turn":
      return { type: "turn", payload: payload as TurnPayload };
    case "llm-message":
      return { type: "llm-message", payload: payload as LlmMessagePayload };
    case "subscription":
      return { type: "subscription", payload: payload as SubscriptionPayload };
    case "tool-call":
      return { type: "tool-call", payload: payload as ToolCallPayload };
    case "raw-event":
      return { type: "raw-event", payload: payload as RawEventPayload };
  }
}

// ---------------------------------------------------------------------------
// CLI-backed writer implementation
// ---------------------------------------------------------------------------

export function createCliAnalyticsWriter(): AnalyticsWriterLike {
  // Prefer the SEA binary: it embeds its own Node runtime so there is no ABI
  // mismatch risk and no version-probe overhead at startup.
  const seaBinary = findSeaBinary();
  if (seaBinary != null) {
    return new CliAnalyticsWriter(seaBinary, [], seaBinary);
  }

  // Fallback: run the compiled JS bin via a compatible Node interpreter.
  const manifest = readManifest();
  const repoRoot = findRepoRoot(manifest);
  const nodePath = findNodePath(manifest);
  const tokenTallyBin = join(repoRoot, "store/bin/token-tally.js");

  if (!existsSync(tokenTallyBin)) {
    throw new Error(`token-tally CLI not found at ${tokenTallyBin}`);
  }

  return new CliAnalyticsWriter(nodePath, [tokenTallyBin], repoRoot);
}

class CliAnalyticsWriter implements AnalyticsWriterLike {
  /**
   * @param binary      The executable to spawn (SEA binary or Node interpreter).
   * @param prefixArgs  Arguments prepended before the token-tally subcommand
   *                    (empty for SEA, [tokenTallyBin] for the JS fallback).
   * @param cwd         Working directory for the child process.
   */
  constructor(
    private readonly binary: string,
    private readonly prefixArgs: string[],
    private readonly cwd: string,
  ) {}

  recordHarness(payload: HarnessPayload): Promise<WriteResult> {
    return this.recordWithId("harness", payload);
  }

  recordSession(payload: SessionPayload): Promise<WriteResult> {
    return this.recordWithId("session", payload);
  }

  recordTurn(payload: TurnPayload): Promise<WriteResult> {
    return this.recordWithId("turn", payload);
  }

  recordLlmMessage(payload: LlmMessagePayload): Promise<WriteResult> {
    return this.recordWithId("llm-message", payload);
  }

  recordSubscription(payload: SubscriptionPayload): Promise<WriteResult> {
    return this.recordWithId("subscription", payload);
  }

  recordToolCall(payload: ToolCallPayload): Promise<WriteResult> {
    return this.recordWithId("tool-call", payload);
  }

  async recordRawEvent(payload: RawEventPayload): Promise<void> {
    try {
      await this.record("raw-event", payload);
    } catch (err: unknown) {
      writeEmergencySpool(spoolRecord("raw-event", payload));
      console.warn(
        "[pi-writer] token-tally record raw-event failed; wrote emergency spool:",
        err,
      );
    }
  }

  async close(): Promise<void> {
    // Every write is committed by its helper process. There is no long-lived
    // SQLite handle in the Pi process, so close is intentionally a no-op.
  }

  private async recordWithId(
    recordType: Exclude<RecordType, "raw-event">,
    payload: unknown,
  ): Promise<WriteResult> {
    try {
      const stdout = await this.record(recordType, payload);
      const parsed = JSON.parse(stdout) as { id?: unknown };
      if (typeof parsed.id !== "string" || parsed.id.length === 0) {
        throw new Error(`token-tally record ${recordType}: missing id in response`);
      }
      return { id: parsed.id };
    } catch (err: unknown) {
      try {
        writeEmergencySpool(spoolRecord(recordType, payload));
      } catch (spoolErr: unknown) {
        console.warn("[pi-writer] emergency spool write failed:", spoolErr);
        throw err;
      }

      console.warn(
        `[pi-writer] token-tally record ${recordType} failed; wrote emergency spool:`,
        err,
      );
      return { id: fallbackId(recordType, payload) };
    }
  }

  private record(recordType: RecordType, payload: unknown): Promise<string> {
    const json = JSON.stringify(payload);
    const args = [
      ...this.prefixArgs,
      "record",
      "--type",
      recordType,
      "--json",
      json,
    ];

    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.binary, args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`token-tally record ${recordType}: timed out`));
      }, DEFAULT_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolvePromise(stdout.trim());
          return;
        }
        reject(
          new Error(
            `token-tally record ${recordType} exited ${code ?? "unknown"}: ${stderr.trim()}`,
          ),
        );
      });
    });
  }
}
