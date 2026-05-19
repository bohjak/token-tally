/**
 * Runtime metadata file for the web explorer server.
 *
 * When the explorer server starts, it writes a small JSON file to a
 * per-user runtime/cache location. Subsequent `token-tally explore`
 * invocations read this file to detect and reuse an already-running server
 * instead of starting a new one.
 *
 * Location priority:
 *   1. $XDG_RUNTIME_DIR/token-tally/explorer.json   (if XDG_RUNTIME_DIR set)
 *   2. ~/Library/Caches/token-tally/explorer.json    (macOS fallback)
 *   3. /tmp/token-tally-<uid>/explorer.json          (universal fallback)
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RuntimeMetadata = {
  pid: number;
  port: number;
  host: string;
  /** Full browser URL, e.g. "http://127.0.0.1:3741" */
  url: string;
  /** Base URL for API calls — same as `url` in v1 (co-located server+client) */
  apiBaseUrl: string;
  /** Absolute path to the SQLite database this server is serving */
  dbPath: string;
  /** Unix millisecond timestamp — when the server process started */
  startedAt: number;
  /** Unix millisecond timestamp — last time the server was contacted */
  lastSeenAt: number;
};

// ---------------------------------------------------------------------------
// File location
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the runtime metadata file for the current user.
 *
 * The path is stable within a process (the environment variables it reads are
 * set at startup), so repeated calls always return the same value.
 */
export function runtimeFilePath(): string {
  const xdgRuntime = process.env["XDG_RUNTIME_DIR"];
  if (xdgRuntime != null && xdgRuntime !== "") {
    return join(xdgRuntime, "token-tally", "explorer.json");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "token-tally", "explorer.json");
  }

  // Universal fallback — use UID to avoid collisions in multi-user environments.
  const uid = process.getuid?.() ?? "user";
  return join("/tmp", `token-tally-${uid}`, "explorer.json");
}

// ---------------------------------------------------------------------------
// Read / write / remove
// ---------------------------------------------------------------------------

/**
 * Atomically writes `meta` to the runtime file.
 *
 * Creates the parent directory if it doesn't already exist. Uses a
 * write-to-temp-then-rename pattern so a concurrent reader never sees a
 * partial file.
 */
export function writeRuntime(meta: RuntimeMetadata): void {
  const filePath = runtimeFilePath();
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Reads and parses the runtime file.
 *
 * Returns `null` if the file does not exist, cannot be read, or contains
 * invalid JSON. All errors are swallowed so callers can treat a missing or
 * corrupt file as "no server running" without special-casing error types.
 */
export function readRuntime(): RuntimeMetadata | null {
  try {
    const raw = readFileSync(runtimeFilePath(), "utf-8");
    return JSON.parse(raw) as RuntimeMetadata;
  } catch {
    return null;
  }
}

/**
 * Deletes the runtime file.
 *
 * Silently ignores `ENOENT` (file already gone). Re-throws any other
 * filesystem error so unexpected problems surface immediately.
 */
export function removeRuntime(): void {
  try {
    unlinkSync(runtimeFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
