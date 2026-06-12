/**
 * index.ts — Public API for @token-tally/harness-kit.
 *
 * Shared hook-process scaffolding for ToTally writers. Contains:
 *   - config:       config.json loader for subscription + captureRaw flags
 *   - periods:      monthly billing period boundary computation
 *   - git-capture:  best-effort git repo metadata capture
 *   - state-io:     generic atomic JSON state read/write/delete
 *   - hook-process: stdin-to-dispatch lifecycle wrapper
 *   - provider:     LLM provider inference from model ID
 */

export type { SubConfig } from "./config.js";
export { loadSubscriptionConfig, loadCaptureRawFlag } from "./config.js";

export { computeMonthlyPeriod } from "./periods.js";

export type { ExecFn, RepoSnapshot } from "./git-capture.js";
export { captureRepoSnapshot, GIT_TIMEOUT_MS } from "./git-capture.js";

export { sanitizeIdForFilename, readJsonState, writeJsonState, deleteJsonState } from "./state-io.js";

export type { DispatchFn } from "./hook-process.js";
export { readStdin, timeoutAfter, runHookProcess } from "./hook-process.js";

export { inferProvider } from "./provider.js";
