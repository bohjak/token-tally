/**
 * Public API surface for @token-tally/store.
 *
 * T2: paths, types
 * T5: AnalyticsWriter, schema connection helpers, spool types
 * T6: doctor, ingest utilities
 * T7: legacy-pi importer
 */

export * from "./paths";
export * from "./types";

// T5 — writer, connection, spool
export { AnalyticsWriter } from "./writer";
export {
  MIN_SUPPORTED_SCHEMA_VERSION,
  MAX_KNOWN_SCHEMA_VERSION,
  SCHEMA_FORWARD_WINDOW,
  openWriterConnection,
  readSchemaCompatibility,
  withBusyRetry,
} from "./connection";
export { runMigrations } from "./migrations";
export { SpoolWriter, drainClosedSpoolFiles } from "./spool";
export type { SpoolRecord, DrainResult } from "./spool";

// T6 — doctor, ingest
export { runDoctor, formatDoctorReport } from "./doctor";
export type { DoctorReport, Finding, FindingSeverity } from "./doctor";
export { ingestFile, ingestDir } from "./ingest";
export type { IngestOptions, IngestResult } from "./ingest";

// T7 — legacy Pi importer
export { importLegacyPi, defaultLegacyPath } from "./importers/legacy-pi";
export type {
  LegacyImportOptions,
  LegacyImportResult,
  TableImportStats,
} from "./importers/legacy-pi";
