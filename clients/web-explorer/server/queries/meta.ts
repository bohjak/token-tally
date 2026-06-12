/**
 * Thin re-export — all metadata query logic lives in @token-tally/queries.
 * This file exists so server/index.ts keeps its existing relative import path.
 */

export type { HarnessRow } from "@token-tally/queries";
export { listHarnesses, getSchemaVersion } from "@token-tally/queries";
