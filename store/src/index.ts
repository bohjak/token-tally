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
export type { WriterDrainOptions, WriterOpenOptions } from "./writer";
export {
  MIN_SUPPORTED_SCHEMA_VERSION,
  MAX_KNOWN_SCHEMA_VERSION,
  SCHEMA_FORWARD_WINDOW,
  openWriterConnection,
  readSchemaCompatibility,
  withBusyRetry,
} from "./connection";
export { runMigrations } from "./migrations";
export { SpoolWriter, drainClosedSpoolFiles, drainSingleSpoolFile, promoteStaleActiveFiles } from "./spool";
export type { SpoolRecord, DrainResult, BoundedDrainOptions, PromoteResult, PromotedEntry } from "./spool";

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

// T8 — Pi session log importer
export {
  importPiSessionLogs,
  defaultPiSessionsPath,
} from "./importers/pi-session-log/importer";
export { parsePiSessionFile } from "./importers/pi-session-log/parser";
export {
  transformSessionEvents,
  dollarToMicros,
} from "./importers/pi-session-log/transformer";
export { discoverPiSessions, isInDateRange } from "./importers/pi-session-log/discovery";
export type {
  PiSessionImportOptions,
  PiSessionImportResult,
  SessionImportResult,
  SessionImportCounts,
  TransformedSession,
  TransformedTurn,
  TransformedMessage,
  TransformedToolCall,
  DiscoveredFile,
  ParsedFile,
  ParseError,
} from "./importers/pi-session-log/types";

// T1 (Cursor) — shared multi-provider pricing
export { lookupRates, computeCostMicros } from "./pricing/index";
export type { ModelRates, CostBreakdown, CostInput } from "./pricing/index";
