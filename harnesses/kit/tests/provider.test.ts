/**
 * Tests for src/provider.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferProvider } from "../src/provider.js";

describe("inferProvider", () => {
  it("returns 'anthropic' for claude- prefix", () => {
    assert.equal(inferProvider("claude-sonnet-4-5"), "anthropic");
    assert.equal(inferProvider("claude-haiku-4-5"), "anthropic");
    assert.equal(inferProvider("claude-opus-4-5"), "anthropic");
  });

  it("returns 'openai' for gpt- / o1- / o3- / o4- prefixes", () => {
    assert.equal(inferProvider("gpt-4o"), "openai");
    assert.equal(inferProvider("o1-mini"), "openai");
    assert.equal(inferProvider("o3-mini"), "openai");
    assert.equal(inferProvider("o4-mini"), "openai");
    // Bare "o3" (no dash) does not match because the prefix check requires o3-.
    assert.equal(inferProvider("o3"), null);
  });

  it("returns 'google' for gemini- prefix", () => {
    assert.equal(inferProvider("gemini-2.0-flash"), "google");
  });

  it("returns 'xai' for grok- prefix", () => {
    assert.equal(inferProvider("grok-3"), "xai");
  });

  it("returns null for unknown model IDs", () => {
    assert.equal(inferProvider("llama-3"), null);
    assert.equal(inferProvider(""), null);
    assert.equal(inferProvider("unknown-model-xyz"), null);
  });

  it("does not match partial prefixes incorrectly", () => {
    // A model called 'claudia-...' should not match claude-
    assert.equal(inferProvider("claudia-3"), null);
  });
});
