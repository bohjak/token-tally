#!/usr/bin/env node
// @ts-check
/**
 * token-tally binary entry point.
 *
 * This file is intentionally thin — it loads the compiled CLI module from
 * dist/cli/index.js and invokes `main()`. Keeping the shebang and require()
 * here means the TypeScript source in cli/index.ts never needs to worry about
 * how it is launched.
 *
 * Why separate bin vs. cli?
 *   TypeScript cannot include a shebang line without breaking compilation.
 *   The conventional solution is a small .js wrapper that sets up the shebang
 *   and delegates immediately. This file must stay in JS (not TS) so pnpm can
 *   link it as an executable without a build step.
 *
 * The compiled CLI is at dist/cli/index.js (relative to the package root,
 * which is the directory containing this bin/ folder's parent package.json).
 */

const path = require("path");

// Resolve the compiled CLI from the package root (one level up from bin/).
const cliPath = path.join(__dirname, "..", "dist", "cli", "index.js");

/** @type {{ main: (argv: string[]) => Promise<number> }} */
const cli = require(cliPath);

// Pass process.argv directly — cli/index.ts slices off node + script path.
cli.main(process.argv.slice(2)).then(
  /** @param {number} code */
  (code) => {
    process.exitCode = code;
  },
  /** @param {unknown} err */
  (err) => {
    // Unexpected error (not a handled CLI failure) — print a stack trace and
    // exit with a generic error code so the shell can detect the failure.
    process.stderr.write(
      `token-tally: unexpected error\n${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
    );
    process.exitCode = 2;
  }
);
