#!/usr/bin/env node
// ESM entry point for the token-tally-explore binary.
// Imports the compiled server and delegates to main().
import { main } from "../dist/server/index.js";
main(process.argv.slice(2));
