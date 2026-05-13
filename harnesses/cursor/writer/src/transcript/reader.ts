/**
 * transcript/reader.ts — Best-effort reader for the Cursor transcript file.
 *
 * Cursor exposes `transcript_path` in hook payloads when transcripts are
 * enabled. The format of these files is not publicly documented and is
 * expected to evolve. This reader is intentionally format-agnostic: it
 * attempts JSONL (line-delimited JSON) first, then a single JSON document
 * (array or {messages: [...]} object). It returns an empty array on any
 * read or parse failure so callers never need to catch.
 *
 * The reader does NOT cache or track offsets — it always reads the full file.
 * For long sessions this is acceptable because:
 *   1. Calls are infrequent (stop / sessionEnd only).
 *   2. The file is typically small.
 *   3. We want to see the complete picture at backfill time.
 *
 * See: https://cursor.com/docs/hooks (transcript_path field)
 */

import { readFile } from "node:fs/promises";

// Per-process warning set — avoids spamming the console for repeated calls
// on the same unrecognised path.
const _warnedPaths = new Set<string>();

/**
 * Read the transcript at `transcriptPath` and return its entries as an array
 * of raw parsed objects.
 *
 * Returns an empty array when:
 * - The file does not exist or cannot be read.
 * - The file content cannot be interpreted as JSONL or JSON.
 *
 * Does NOT throw.
 */
export async function readTranscriptEntries(transcriptPath: string): Promise<unknown[]> {
  // ── 1. Read raw bytes ──────────────────────────────────────────────────────
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf-8");
  } catch {
    // File absent, unreadable, or permission-denied — all acceptable; skip.
    return [];
  }

  if (raw.trim() === "") {
    return [];
  }

  // ── 2. Try JSONL (line-delimited JSON) ────────────────────────────────────
  // Most Cursor-style transcript files appear to be JSONL. Try this first.
  const lines = raw.split("\n");
  const jsonlEntries: unknown[] = [];
  let jsonlValid = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue; // blank separators are normal
    try {
      jsonlEntries.push(JSON.parse(trimmed) as unknown);
    } catch {
      jsonlValid = false;
      break;
    }
  }

  if (jsonlValid && jsonlEntries.length > 0) {
    // If JSONL parsing returned exactly one entry that is itself an array, the
    // file is a JSON array written on one line (not truly line-delimited).
    // Unwrap it so callers receive the individual elements.
    if (jsonlEntries.length === 1 && Array.isArray(jsonlEntries[0])) {
      return jsonlEntries[0] as unknown[];
    }

    // If JSONL parsing returned exactly one entry that is an envelope object
    // (e.g. { messages: [...] }), unwrap the inner array so we don't have to
    // handle the envelope in the caller. The envelope object itself has no
    // analytics value.
    if (
      jsonlEntries.length === 1 &&
      jsonlEntries[0] !== null &&
      typeof jsonlEntries[0] === "object" &&
      !Array.isArray(jsonlEntries[0])
    ) {
      const obj = jsonlEntries[0] as Record<string, unknown>;
      for (const envelopeKey of ["messages", "turns", "entries", "conversation"]) {
        const inner = obj[envelopeKey];
        if (Array.isArray(inner)) {
          return inner as unknown[];
        }
      }
    }

    return jsonlEntries;
  }

  // ── 3. Try single JSON document ───────────────────────────────────────────
  // Some transcripts may be a JSON array or a {messages: [...]} object.
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (Array.isArray(parsed)) {
      return parsed as unknown[];
    }

    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;

      // Common envelope shapes: { messages: [...] } or { turns: [...] }
      for (const key of ["messages", "turns", "entries", "conversation"]) {
        const inner = obj[key];
        if (Array.isArray(inner)) {
          return inner as unknown[];
        }
      }

      // If it's a single object (not an array), wrap it for uniform handling
      return [parsed];
    }
  } catch {
    // Not JSON at all
  }

  // ── 4. Unrecognised format — warn once ────────────────────────────────────
  if (!_warnedPaths.has(transcriptPath)) {
    _warnedPaths.add(transcriptPath);
    console.warn(
      `[cursor-writer] transcript at ${transcriptPath} is not JSONL or JSON — skipping`,
    );
  }

  return [];
}
