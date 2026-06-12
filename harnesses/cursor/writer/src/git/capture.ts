/**
 * git/capture.ts — Re-export from @token-tally/harness-kit.
 *
 * The implementation lives in the kit so it is shared with the Claude Code writer.
 * This file is kept as a stable import path for hook handlers in this package.
 */

export type { RepoSnapshot } from "@token-tally/harness-kit";
export { captureRepoSnapshot, GIT_TIMEOUT_MS } from "@token-tally/harness-kit";
