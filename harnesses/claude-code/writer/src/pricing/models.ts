/**
 * pricing/models.ts — Removed; pricing is now provided by @token-tally/store/pricing.
 *
 * MODEL_RATES and lookupModelRates have been deleted. All pricing lookup and
 * cost computation goes through the shared store module. See compute.ts.
 *
 * This file is kept as a re-export shim so that any import of
 * "./models.js" that was not yet updated still compiles.
 */
// The main @token-tally/store entry also re-exports ModelRates. We use the
// main entry here rather than the subpath because this package's tsconfig uses
// "moduleResolution": "Node" which does not resolve package.json exports maps.
export type { ModelRates } from "@token-tally/store";
