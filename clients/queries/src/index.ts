/**
 * @token-tally/queries — shared read-only query layer.
 *
 * Provides analytics aggregations, session/turn lookups, and metadata helpers
 * for all TypeScript reader clients. Functions accept an injected
 * better-sqlite3 Database and never open connections — connection lifecycle
 * stays with each client.
 */

export * from "./analytics.js";
export * from "./sessions.js";
export * from "./meta.js";
export * from "./compat.js";
