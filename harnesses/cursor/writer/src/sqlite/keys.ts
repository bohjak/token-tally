/**
 * sqlite/keys.ts — Key format helpers for the Cursor `cursorDiskKV` table.
 *
 * Cursor stores per-session and per-bubble metadata in a SQLite database at a
 * platform-specific path (see paths.ts). The table `cursorDiskKV` uses a
 * key-value layout where the key encodes the data type and identity:
 *
 *   bubbleId:<composerId>:<bubbleId>   — per-message data including tokenCount
 *   composerData:<composerId>          — session-level metadata including lastUsedModel
 *
 * These are private Cursor internals, not a documented public API. The key
 * formats are derived from empirical observation and may change across Cursor
 * versions. The drain module (drain.ts) treats missing/changed rows as
 * graceful failures rather than errors.
 *
 * NOTE: `composerId` == `conversation_id` from the hook payload.
 */

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

/**
 * Build the KV key for a single conversation bubble (one assistant turn).
 *
 * In Cursor's internal model, a "composer" corresponds to a conversation
 * and a "bubble" corresponds to one message exchange within that conversation.
 *
 * @param composerId  Conversation id from the hook payload (`conversation_id`).
 * @param bubbleId    Bubble-specific identifier (may equal `generation_id`).
 */
export function bubbleKey(composerId: string, bubbleId: string): string {
  return `bubbleId:${composerId}:${bubbleId}`;
}

/**
 * Build the KV key for session-level composer metadata.
 *
 * The `composerData` row holds session-level fields including `lastUsedModel`
 * which is used as a fallback model attribution when per-bubble model data
 * is absent.
 *
 * @param composerId  Conversation id from the hook payload (`conversation_id`).
 */
export function composerDataKey(composerId: string): string {
  return `composerData:${composerId}`;
}

// ---------------------------------------------------------------------------
// Key parsers
// ---------------------------------------------------------------------------

/**
 * Parse a `bubbleId:` key back into its components.
 *
 * Returns null for keys that do not start with `bubbleId:` or lack the
 * expected structure.
 */
export function parseBubbleKey(
  key: string,
): { composerId: string; bubbleId: string } | null {
  if (!key.startsWith("bubbleId:")) return null;

  // Key format: bubbleId:<composerId>:<bubbleId>
  // Both IDs could theoretically contain colons, but in practice they do not.
  // We split on the SECOND colon to handle the common case robustly.
  const rest = key.slice("bubbleId:".length); // "<composerId>:<bubbleId>"
  const sepIndex = rest.indexOf(":");
  if (sepIndex === -1) return null; // malformed — only one segment

  return {
    composerId: rest.slice(0, sepIndex),
    bubbleId: rest.slice(sepIndex + 1),
  };
}

/**
 * Check whether a key is a `composerData:` key.
 */
export function isComposerDataKey(key: string): boolean {
  return key.startsWith("composerData:");
}
