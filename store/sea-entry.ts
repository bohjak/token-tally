/**
 * SEA entry point — bundled by store/scripts/build-sea.mjs via esbuild.
 *
 * This file is intentionally NOT compiled by tsc (excluded in tsconfig.json).
 * esbuild handles TypeScript transpilation as part of the SEA bundle step.
 * Do not import this module from anywhere else in the package.
 */

import { main } from "./cli/index";

void main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(
      `token-tally: unexpected error\n${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 2;
  },
);
