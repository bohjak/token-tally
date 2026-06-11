/**
 * JSONL parser for Pi session log files.
 *
 * - Reads one JSON event per line.
 * - Unknown event types are included as-is (the transformer ignores them).
 * - Malformed lines produce a ParseError entry; parsing continues for
 *   remaining lines and never throws.
 * - The outer `timestamp` field must be an ISO-8601 string and parseable.
 */

import { readFileSync } from "fs";
import type { ParsedFile, ParseError, PiSessionEvent } from "./types";

/**
 * Parses a Pi session JSONL file into typed events plus per-line errors.
 *
 * Returns a ParsedFile even when the file is unreadable — the error is
 * reported as a line-0 entry and the events array is empty.
 */
export function parsePiSessionFile(filePath: string): ParsedFile {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      filePath,
      events: [],
      errors: [{ file: filePath, line: 0, reason: `Cannot read file: ${errMsg(err)}` }],
    };
  }

  const lines = content.split("\n");
  const events: PiSessionEvent[] = [];
  const errors: ParseError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      errors.push({
        file: filePath,
        line: i + 1,
        reason: `Invalid JSON: ${errMsg(err)}`,
      });
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) {
      errors.push({
        file: filePath,
        line: i + 1,
        reason: "Line is not a JSON object",
      });
      continue;
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj["type"] !== "string") {
      errors.push({
        file: filePath,
        line: i + 1,
        reason: "Missing or non-string 'type' field",
      });
      continue;
    }

    if (typeof obj["timestamp"] !== "string") {
      errors.push({
        file: filePath,
        line: i + 1,
        reason: "Missing or non-string outer 'timestamp' field",
      });
      continue;
    }

    // Validate ISO timestamp is parseable.
    const ts = Date.parse(obj["timestamp"] as string);
    if (isNaN(ts)) {
      errors.push({
        file: filePath,
        line: i + 1,
        reason: `Non-parseable outer timestamp: ${obj["timestamp"]}`,
      });
      continue;
    }

    // Event is structurally valid; type narrowing happens at the call site.
    events.push(parsed as PiSessionEvent);
  }

  return { filePath, events, errors };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
