/**
 * config.test.ts — Tests for src/config.ts
 *
 * Uses a temp directory for XDG_CONFIG_HOME to avoid touching the real config.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadSubscriptionConfig, loadCaptureRawFlag } from "../src/config.js";

// ---------------------------------------------------------------------------
// Test environment: isolated XDG_CONFIG_HOME
// ---------------------------------------------------------------------------

let tempDir: string;
let configDir: string;
let prevXDGConfig: string | undefined;

before(() => {
  tempDir = join(tmpdir(), `tt-kit-config-test-${process.pid}`);
  configDir = join(tempDir, "token-tally");
  mkdirSync(configDir, { recursive: true });
  prevXDGConfig = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = tempDir;
});

after(() => {
  if (prevXDGConfig === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = prevXDGConfig;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(content: unknown): void {
  writeFileSync(join(configDir, "config.json"), JSON.stringify(content), "utf8");
}

function removeConfig(): void {
  try {
    rmSync(join(configDir, "config.json"));
  } catch {
    // ignore
  }
}

beforeEach(() => removeConfig());

// ---------------------------------------------------------------------------
// loadSubscriptionConfig
// ---------------------------------------------------------------------------

describe("loadSubscriptionConfig", () => {
  it("returns null when config.json is absent", async () => {
    const result = await loadSubscriptionConfig("claude-code", "[test]");
    assert.equal(result, null);
  });

  it("returns null when harnesses block is absent", async () => {
    writeConfig({ other: "data" });
    const result = await loadSubscriptionConfig("claude-code", "[test]");
    assert.equal(result, null);
  });

  it("returns null when harness block is absent", async () => {
    writeConfig({ harnesses: { cursor: { subscription: "cursor-pro" } } });
    const result = await loadSubscriptionConfig("claude-code", "[test]");
    assert.equal(result, null);
  });

  it("returns null when subscription key is absent", async () => {
    writeConfig({ harnesses: { "claude-code": { captureRaw: true } } });
    const result = await loadSubscriptionConfig("claude-code", "[test]");
    assert.equal(result, null);
  });

  it("returns null for malformed JSON", async () => {
    writeFileSync(join(configDir, "config.json"), "{ bad json }", "utf8");
    const result = await loadSubscriptionConfig("claude-code", "[test]");
    assert.equal(result, null);
  });

  it("parses a full claude-code config correctly", async () => {
    writeConfig({
      harnesses: {
        "claude-code": {
          subscription: "claude-pro",
          subscriptionFixedCostUSD: 20,
          subscriptionStartDay: 5,
        },
      },
    });
    const result = await loadSubscriptionConfig("claude-code", "[test]");
    assert.deepEqual(result, { plan: "claude-pro", fixedCostUSD: 20, startDay: 5 });
  });

  it("parses a full cursor config correctly", async () => {
    writeConfig({
      harnesses: {
        cursor: {
          subscription: "cursor-pro",
          subscriptionFixedCostUSD: 19,
          subscriptionStartDay: 1,
        },
      },
    });
    const result = await loadSubscriptionConfig("cursor", "[test]");
    assert.deepEqual(result, { plan: "cursor-pro", fixedCostUSD: 19, startDay: 1 });
  });

  it("defaults fixedCostUSD to 0 when omitted", async () => {
    writeConfig({ harnesses: { "claude-code": { subscription: "claude-max-5x" } } });
    const result = await loadSubscriptionConfig("claude-code", "[test]");
    assert.equal(result?.fixedCostUSD, 0);
  });

  it("defaults startDay to 1 when omitted", async () => {
    writeConfig({ harnesses: { cursor: { subscription: "cursor-pro" } } });
    const result = await loadSubscriptionConfig("cursor", "[test]");
    assert.equal(result?.startDay, 1);
  });

  it("clamps startDay of 0 to 1", async () => {
    writeConfig({
      harnesses: { cursor: { subscription: "cursor-pro", subscriptionStartDay: 0 } },
    });
    const result = await loadSubscriptionConfig("cursor", "[test]");
    assert.equal(result?.startDay, 1);
  });

  it("clamps startDay of 32 to 1", async () => {
    writeConfig({
      harnesses: { cursor: { subscription: "cursor-pro", subscriptionStartDay: 32 } },
    });
    const result = await loadSubscriptionConfig("cursor", "[test]");
    assert.equal(result?.startDay, 1);
  });

  it("floors a fractional startDay", async () => {
    writeConfig({
      harnesses: { cursor: { subscription: "cursor-pro", subscriptionStartDay: 15.9 } },
    });
    const result = await loadSubscriptionConfig("cursor", "[test]");
    assert.equal(result?.startDay, 15);
  });
});

// ---------------------------------------------------------------------------
// loadCaptureRawFlag
// ---------------------------------------------------------------------------

describe("loadCaptureRawFlag", () => {
  it("returns false when config.json is absent", async () => {
    assert.equal(await loadCaptureRawFlag("cursor"), false);
  });

  it("returns false when captureRaw is absent", async () => {
    writeConfig({ harnesses: { cursor: { subscription: "cursor-pro" } } });
    assert.equal(await loadCaptureRawFlag("cursor"), false);
  });

  it("returns false when captureRaw is false", async () => {
    writeConfig({ harnesses: { cursor: { captureRaw: false } } });
    assert.equal(await loadCaptureRawFlag("cursor"), false);
  });

  it("returns true when captureRaw is true", async () => {
    writeConfig({ harnesses: { cursor: { captureRaw: true } } });
    assert.equal(await loadCaptureRawFlag("cursor"), true);
  });

  it("returns false for malformed JSON", async () => {
    writeFileSync(join(configDir, "config.json"), "not json", "utf8");
    assert.equal(await loadCaptureRawFlag("cursor"), false);
  });

  it("works without a subscription plan — captureRaw is independent", async () => {
    writeConfig({ harnesses: { cursor: { captureRaw: true } } });
    assert.equal(await loadCaptureRawFlag("cursor"), true);
    // And subscription should still be null
    const sub = await loadSubscriptionConfig("cursor", "[test]");
    assert.equal(sub, null);
  });

  it("returns false when harness block is absent", async () => {
    writeConfig({ harnesses: {} });
    assert.equal(await loadCaptureRawFlag("cursor"), false);
  });
});
