import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { synthesizeTurnId, centralUuid } from "../src/ids/synthesize.js";

describe("synthesizeTurnId", () => {
  it("returns the expected format for turnIndex 1", () => {
    assert.equal(synthesizeTurnId("abc", 1), "abc:t1");
  });

  it("is idempotent — same inputs always produce the same string", () => {
    assert.equal(synthesizeTurnId("abc", 1), synthesizeTurnId("abc", 1));
  });

  it("returns the expected format for turnIndex 0", () => {
    assert.equal(synthesizeTurnId("abc", 0), "abc:t0");
  });
});

describe("centralUuid", () => {
  it("returns a string matching UUID v4 format", () => {
    const uuid = centralUuid();
    assert.match(
      uuid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns different values on successive calls", () => {
    assert.notEqual(centralUuid(), centralUuid());
  });
});
