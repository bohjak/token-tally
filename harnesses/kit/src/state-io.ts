/**
 * state-io.ts — Generic atomic JSON state persistence helpers.
 *
 * Replaces the near-identical write patterns in both writer packages:
 *   harnesses/claude-code/writer/src/state/session-state.ts
 *   harnesses/cursor/writer/src/state/session-state.ts
 *
 * BEHAVIORAL FIXES OVER THE OLD COPIES
 * ─────────────────────────────────────
 * 1. Pid-suffixed tmp files (m7): the old code used a fixed `${path}.tmp`
 *    name. When two hook invocations for the same session run concurrently
 *    (e.g. a preToolUse and a postToolUse racing due to OS scheduling), they
 *    would clobber each other's tmp file before rename. Using `${path}.${pid}.tmp`
 *    gives each process an exclusive tmp path.
 *
 *    NOTE: a read-modify-write race window still exists — process B may read
 *    state before process A writes it. The pid-suffix only protects the tmp
 *    file, not the logical read-modify-write cycle. File locking is not
 *    implemented because the cost exceeds the value: the store's idempotent
 *    upserts bound the damage from a lost update to at most one missed field
 *    update rather than a corrupt row.
 *
 * 2. ID sanitization (m6): raw session IDs from harnesses may contain path
 *    separators or other filesystem-unsafe characters. Use
 *    `sanitizeIdForFilename()` before constructing state file paths.
 */

import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Make an arbitrary string safe to use as a filename component.
 *
 * Strategy: if the id contains only alphanumeric characters, hyphens,
 * underscores, and dots it is returned as-is (common case for UUIDs).
 * Otherwise it is replaced by its SHA-256 hex digest so the result is
 * always filesystem-safe and deterministic.
 *
 * The SHA-256 path is a one-way transform — the original ID is not
 * recoverable from the filename. That is intentional: the filename is only
 * a lookup key; the original ID is stored inside the JSON payload.
 */
export function sanitizeIdForFilename(id: string): string {
  if (/^[\w.-]+$/.test(id)) {
    // Already safe: only word chars, dots, hyphens.
    return id;
  }
  // Hash the raw string; use the first 40 hex chars (SHA-1-length prefix)
  // for readability while still being collision-resistant for this use-case.
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 40);
}

// ---------------------------------------------------------------------------
// Generic read / write / delete
// ---------------------------------------------------------------------------

/**
 * Read a JSON state file at `path`, parsing it as type T.
 *
 * Returns null when:
 * - The file does not exist (ENOENT) — normal for the first invocation.
 * - The file exists but contains invalid JSON — logs a warning and returns
 *   null so the caller can recover without crashing.
 *
 * @param tag  - Short tag included in the warning message, e.g. "[claude-code-writer]".
 */
export async function readJsonState<T>(path: string, tag: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`${tag} state file at ${path} contains invalid JSON; discarding`);
    return null;
  }
}

/**
 * Atomically write `state` as JSON to `path`.
 *
 * Uses `${path}.${process.pid}.tmp` as an intermediate file and `fs.rename`
 * so concurrent readers never observe a partial write. Creates parent
 * directories if they do not exist.
 *
 * See the module-level NOTE about the remaining read-modify-write race window.
 */
export async function writeJsonState<T>(path: string, state: T): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(state), "utf8");
  await rename(tmp, path);
}

/**
 * Delete the state file at `path`.
 *
 * Best-effort: silently ignores ENOENT (already gone is fine). Other errors
 * are re-thrown so they surface as unexpected failures.
 */
export async function deleteJsonState(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (isEnoent(err)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
