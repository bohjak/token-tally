#!/usr/bin/env node
/**
 * bin/token-tally-claude-hook.ts — Claude Code hook binary entrypoint.
 *
 * Registered in ~/.claude/settings.json as the command for every hook event:
 *
 *   { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
 *       "command": "token-tally-claude-hook" }] }] } }
 *
 * Claude Code pipes the hook payload JSON to stdin and expects the process to
 * exit with code 0 (non-zero exits can block tool execution). This wrapper
 * guarantees exit 0 regardless of what happens inside `run()`.
 */

import { run } from "../src/main.js";

run().then(
  () => process.exit(0),
  () => process.exit(0), // always exit 0 — never block Claude Code
);
