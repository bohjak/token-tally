/**
 * provider.ts — LLM provider inference from model ID prefixes.
 *
 * Replaces four identical copies in the Cursor writer
 * (session-start, after-agent-response, sqlite/drain, transcript/drain).
 * Consolidated here so any future provider additions are made in one place.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Infer the LLM provider name from a model ID using well-known prefixes.
 *
 * Returns null for unknown or ambiguous model IDs; callers should treat null
 * as "unattributed" and not default to any provider.
 */
export function inferProvider(modelId: string): string | null {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1-") ||
    modelId.startsWith("o3-") ||
    modelId.startsWith("o4-")
  )
    return "openai";
  if (modelId.startsWith("gemini-")) return "google";
  if (modelId.startsWith("grok-")) return "xai";
  return null;
}
