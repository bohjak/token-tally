/**
 * privacy.test.ts — Tests for applyPrivacyMode.
 *
 * Key invariants:
 *   1. Every mode returns the documented StoredText shape.
 *   2. "summary" mode redacts BEFORE truncating (a secret at position 199 must
 *      not be partially exposed).
 *   3. `length` and `sha256` are always present and computed from the original.
 *   4. `"none"` and `"hashed"` never include `text`.
 *   5. `"summary"` and `"full"` always include `text` and `redacted`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPrivacyMode, type StoredText } from "./privacy.ts";
import type { PrivacyMode } from "./privacy.ts";
import type { RedactRule } from "./rules.ts";
import { sha256 } from "./util.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET_RULE: RedactRule = {
  name: "test-secret",
  pattern: /SECRETTOKEN/g,
};

const NO_RULES: RedactRule[] = [];
const WITH_RULES = [SECRET_RULE];

const SAMPLE = "The quick brown fox jumped over the lazy dog.";

// ---------------------------------------------------------------------------
// Shape tests — every mode
// ---------------------------------------------------------------------------

describe("applyPrivacyMode — shape by mode", () => {
  it('"none" returns length and sha256, no text property', () => {
    const result = applyPrivacyMode(SAMPLE, "none", NO_RULES);
    assert.equal(result.mode, "none");
    assert.equal(result.length, SAMPLE.length);
    assert.equal(result.sha256, sha256(SAMPLE));
    assert(!("text" in result), "none mode must not include text");
    assert(!("redacted" in result), "none mode must not include redacted");
  });

  it('"hashed" returns length and sha256, no text property', () => {
    const result = applyPrivacyMode(SAMPLE, "hashed", NO_RULES);
    assert.equal(result.mode, "hashed");
    assert.equal(result.length, SAMPLE.length);
    assert.equal(result.sha256, sha256(SAMPLE));
    assert(!("text" in result), "hashed mode must not include text");
  });

  it('"summary" returns length, sha256, text (truncated), and redacted', () => {
    const result = applyPrivacyMode(SAMPLE, "summary", NO_RULES);
    assert.equal(result.mode, "summary");
    assert.equal(result.length, SAMPLE.length);
    assert.equal(result.sha256, sha256(SAMPLE));
    assert("text" in result);
    assert("redacted" in result);
    // SAMPLE is short (<200 chars), so text should equal SAMPLE unchanged
    if ("text" in result) {
      assert.equal(result.text, SAMPLE);
    }
  });

  it('"full" returns length, sha256, full text, and redacted', () => {
    const result = applyPrivacyMode(SAMPLE, "full", NO_RULES);
    assert.equal(result.mode, "full");
    assert.equal(result.length, SAMPLE.length);
    assert.equal(result.sha256, sha256(SAMPLE));
    assert("text" in result);
    assert("redacted" in result);
    if ("text" in result) {
      assert.equal(result.text, SAMPLE);
    }
  });
});

// ---------------------------------------------------------------------------
// sha256 is always the hash of the ORIGINAL text
// ---------------------------------------------------------------------------

describe("applyPrivacyMode — sha256 of original", () => {
  it("sha256 is original-text hash even when rules fire in full mode", () => {
    const text = "Hello SECRETTOKEN world";
    const result = applyPrivacyMode(text, "full", WITH_RULES);
    // sha256 must be the hash of the ORIGINAL text, not the redacted version
    assert.equal(result.sha256, sha256(text));
    // but text itself should be redacted
    if ("text" in result) {
      assert(!result.text.includes("SECRETTOKEN"), "text must be redacted");
    }
  });

  it("sha256 is original-text hash in summary mode", () => {
    const text = "Prefix SECRETTOKEN suffix";
    const result = applyPrivacyMode(text, "summary", WITH_RULES);
    assert.equal(result.sha256, sha256(text));
  });
});

// ---------------------------------------------------------------------------
// Redact-before-truncate invariant (critical privacy guarantee)
// ---------------------------------------------------------------------------

describe("applyPrivacyMode — redact before truncate", () => {
  it("a secret token placed exactly at position 199 is fully redacted in summary mode", () => {
    // Build a string where "SECRETTOKEN" starts at position 199 (the default maxLen).
    // Without the "redact first" guarantee, the truncation at 200 chars would
    // expose 1 character of the token (position 199 = "S").
    const prefix = "x".repeat(199);         // 199 chars
    const secret = "SECRETTOKEN";           // 11 chars, starts at 199
    const suffix = "y".repeat(50);          // 50 more chars after token
    const text = prefix + secret + suffix;  // total 260 chars

    const result = applyPrivacyMode(text, "summary", WITH_RULES, { summaryMaxLen: 200 });
    assert.equal(result.mode, "summary");
    if ("text" in result) {
      // The token must not appear in any form in the summary
      assert(!result.text.includes("SECRET"), `Token leaked into summary: ${result.text}`);
      // After redaction, "SECRETTOKEN" is replaced with "[REDACTED:test-secret]"
      // which is 23 chars.  The prefix (199) + replacement (23) = 222 chars > 200,
      // so the summary WILL be truncated — but the token is gone.
      assert("redacted" in result && result.redacted["test-secret"] >= 1,
        "hit count must be recorded");
    }
  });

  it("a secret token BEFORE position 199 is redacted in the summary", () => {
    const text = "x".repeat(50) + "SECRETTOKEN" + "x".repeat(200);
    const result = applyPrivacyMode(text, "summary", WITH_RULES, { summaryMaxLen: 200 });
    if ("text" in result) {
      assert(!result.text.includes("SECRETTOKEN"), "token must be redacted");
    }
  });

  it("summary truncates long text with ellipsis suffix", () => {
    const long = "a".repeat(300);
    const result = applyPrivacyMode(long, "summary", NO_RULES, { summaryMaxLen: 100 });
    if ("text" in result) {
      assert(result.text.includes("…(+200 chars)"), `expected ellipsis, got: ${result.text}`);
      assert(result.text.length <= 120, "truncated text should be short");
    }
  });
});

// ---------------------------------------------------------------------------
// length field is always the original text length
// ---------------------------------------------------------------------------

describe("applyPrivacyMode — length is original length", () => {
  for (const mode of ["none", "hashed", "summary", "full"] as PrivacyMode[]) {
    it(`mode "${mode}" uses original text length`, () => {
      const text = "Hello, world!"; // 13 chars
      const result = applyPrivacyMode(text, mode, NO_RULES);
      assert.equal(result.length, 13, `mode ${mode} should have length=13`);
    });
  }
});

// ---------------------------------------------------------------------------
// Redaction hit counter
// ---------------------------------------------------------------------------

describe("applyPrivacyMode — redaction hit counter", () => {
  it("full mode records hits when rules fire", () => {
    const text = "one SECRETTOKEN two SECRETTOKEN three";
    const result = applyPrivacyMode(text, "full", WITH_RULES);
    if ("redacted" in result) {
      assert.equal(result.redacted["test-secret"], 2);
    }
  });

  it("full mode has empty redacted when no rules fire", () => {
    const result = applyPrivacyMode("no secrets here", "full", WITH_RULES);
    if ("redacted" in result) {
      assert.deepEqual(result.redacted, {});
    }
  });

  it("summary mode records hits", () => {
    const text = "prefix SECRETTOKEN suffix";
    const result = applyPrivacyMode(text, "summary", WITH_RULES);
    if ("redacted" in result) {
      assert.equal(result.redacted["test-secret"], 1);
    }
  });
});

// ---------------------------------------------------------------------------
// summaryMaxLen option
// ---------------------------------------------------------------------------

describe("applyPrivacyMode — summaryMaxLen option", () => {
  it("respects custom summaryMaxLen", () => {
    const text = "abcdefghij".repeat(5); // 50 chars
    const result = applyPrivacyMode(text, "summary", NO_RULES, { summaryMaxLen: 10 });
    if ("text" in result) {
      // "abcdefghij" + "…(+40 chars)" = 22 chars
      assert(result.text.startsWith("abcdefghij"));
      assert(result.text.includes("…(+40 chars)"));
    }
  });
});
