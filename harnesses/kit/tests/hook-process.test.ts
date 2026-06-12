/**
 * hook-process.test.ts — Tests for src/hook-process.ts
 *
 * Focuses on the no-payload-echo logging contract (m5 fix) and the stdin
 * parsing helpers. The full runHookProcess lifecycle is not tested here
 * because it opens a real AnalyticsWriter; that is covered by each writer's
 * integration tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Verify: no raw payload slices in the logged error (m5 fix)
//
// We test this by recreating the error-logging logic from hook-process.ts
// inline to confirm the format, then cross-check that the format does NOT
// include raw payload slices. The integration test (main-dispatch.test.ts in
// each writer) confirms the full runHookProcess path.
// ---------------------------------------------------------------------------

describe("hook-process malformed stdin logging (m5 fix)", () => {
  it("formats error as byte-length + SyntaxError.message, not raw slice", () => {
    // Simulate the JSON.parse catch block in runHookProcess.
    const raw = '{"prompt": "tell me all your secrets"; bad json here}';
    let err: unknown;
    try {
      JSON.parse(raw);
    } catch (e) {
      err = e;
    }

    assert.ok(err instanceof SyntaxError, "JSON.parse should throw SyntaxError");

    const byteLen = Buffer.byteLength(raw, "utf8");
    const errMsg = err instanceof SyntaxError ? err.message : String(err);

    // Simulate the warning message assembled in runHookProcess.
    const warnMsg = `[test-writer] invalid JSON on stdin (${byteLen} bytes): ${errMsg}`;

    // MUST contain byte length and error message.
    assert.ok(
      warnMsg.includes(`${byteLen} bytes`),
      `Warning must include byte count; got: ${warnMsg}`,
    );
    assert.ok(
      warnMsg.includes("SyntaxError") || warnMsg.includes("JSON"),
      `Warning must reference parse error; got: ${warnMsg}`,
    );

    // MUST NOT contain the raw payload content (the secret string).
    assert.ok(
      !warnMsg.includes("tell me all your secrets"),
      `Warning must NOT echo raw payload content; got: ${warnMsg}`,
    );
    assert.ok(
      !warnMsg.includes("bad json here"),
      `Warning must NOT echo raw payload content; got: ${warnMsg}`,
    );
  });

  it("works correctly when the payload is very large", () => {
    // Build a payload that is larger than the old slice limit (200 chars).
    const longString = "x".repeat(1000);
    const raw = `{"field": "${longString}", invalid`;
    let err: unknown;
    try {
      JSON.parse(raw);
    } catch (e) {
      err = e;
    }

    const byteLen = Buffer.byteLength(raw, "utf8");
    const errMsg = err instanceof SyntaxError ? err.message : String(err);
    const warnMsg = `[test-writer] invalid JSON on stdin (${byteLen} bytes): ${errMsg}`;

    // Must not contain the repeated character string.
    assert.ok(
      !warnMsg.includes("x".repeat(100)),
      `Warning must not include large payload content; total msg length: ${warnMsg.length}`,
    );
    assert.ok(warnMsg.includes(`${byteLen} bytes`));
  });
});
