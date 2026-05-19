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
import { existsSync, readFileSync } from "node:fs";
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

const DEFAULT_TIMEOUT_MS = 10_000;

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

// ---------------------------------------------------------------------------
// CLI-backed writer implementation
// ---------------------------------------------------------------------------

export function createCliAnalyticsWriter(): AnalyticsWriterLike {
  const manifest = readManifest();
  const repoRoot = findRepoRoot(manifest);
  const nodePath = findNodePath(manifest);
  const tokenTallyBin = join(repoRoot, "store/bin/token-tally.js");

  if (!existsSync(tokenTallyBin)) {
    throw new Error(`token-tally CLI not found at ${tokenTallyBin}`);
  }

  return new CliAnalyticsWriter(nodePath, tokenTallyBin, repoRoot);
}

class CliAnalyticsWriter implements AnalyticsWriterLike {
  constructor(
    private readonly nodePath: string,
    private readonly tokenTallyBin: string,
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
    await this.record("raw-event", payload);
  }

  async close(): Promise<void> {
    // Every write is committed by its helper process. There is no long-lived
    // SQLite handle in the Pi process, so close is intentionally a no-op.
  }

  private async recordWithId(
    recordType: Exclude<RecordType, "raw-event">,
    payload: unknown,
  ): Promise<WriteResult> {
    const stdout = await this.record(recordType, payload);
    const parsed = JSON.parse(stdout) as { id?: unknown };
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      throw new Error(`token-tally record ${recordType}: missing id in response`);
    }
    return { id: parsed.id };
  }

  private record(recordType: RecordType, payload: unknown): Promise<string> {
    const json = JSON.stringify(payload);
    const args = [
      this.tokenTallyBin,
      "record",
      "--type",
      recordType,
      "--json",
      json,
    ];

    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.nodePath, args, {
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
