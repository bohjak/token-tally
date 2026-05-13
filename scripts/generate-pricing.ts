#!/usr/bin/env tsx
/**
 * scripts/generate-pricing.ts — Build store/src/pricing/rates.json from
 * curated YAML sources in pricing-sources/.
 *
 * Usage (from repo root):
 *   pnpm exec tsx scripts/generate-pricing.ts           # generate; warn on stale dates
 *   pnpm exec tsx scripts/generate-pricing.ts --check   # fail if stale or out of sync
 *
 * The generator has zero runtime dependencies: it ships its own minimal YAML
 * parser tailored to the known pricing-sources/*.yaml structure.
 *
 * Output: store/src/pricing/rates.json
 *   Also mirrors the file to store/dist/src/pricing/rates.json when that
 *   directory already exists, so the compiled store package picks it up
 *   without an extra copy step.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types — source YAML shape and output JSON shape
// ---------------------------------------------------------------------------

interface SourceModel {
  id: string;
  provider: string;
  aliases: string[];
  inputPerMTokUSD: number;
  outputPerMTokUSD: number;
  cacheReadPerMTokUSD: number;
  cacheWritePerMTokUSD: number;
}

interface SourceFile {
  provider: string;
  asOf: string;        // ISO date string, e.g. "2026-05-13"
  sourceUrl: string;
  models: SourceModel[];
}

interface RatesJson {
  generatedAt: string; // ISO datetime of this generation run
  sources: Array<{ provider: string; asOf: string; sourceUrl: string }>;
  models: SourceModel[];
}

// ---------------------------------------------------------------------------
// Minimal YAML parser for pricing-sources/*.yaml
//
// Handles the fixed structure of these files only:
//   provider: string           (top-level scalar)
//   asOf: string               (top-level scalar, may be quoted)
//   sourceUrl: string          (top-level scalar)
//   models:                    (top-level sequence)
//     - id: string             (sequence item start, first field on same line)
//       aliases:               (optional sub-sequence)
//         - string
//       inputPerMTokUSD: num   (model numeric fields)
//       outputPerMTokUSD: num
//       cacheReadPerMTokUSD: num
//       cacheWritePerMTokUSD: num
//
// Indentation contract (spaces):
//   0  — top-level keys
//   2  — "  - " sequence item opener (first model field on this line)
//   4  — "    key: value" model sub-properties
//   6  — "      - value" alias list items
// ---------------------------------------------------------------------------

type ParseState =
  | "top"           // reading top-level keys
  | "in_models"     // inside the models sequence, between items
  | "in_model"      // inside a model item's properties
  | "in_aliases";   // inside a model's aliases sub-sequence

/**
 * Strip inline comments (# ...) and surrounding whitespace from a YAML value.
 * Handles quoted strings by not stripping # inside them.
 */
function stripValue(raw: string): string {
  const t = raw.trim();
  // Remove surrounding single or double quotes.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  // Strip inline comment (unquoted value).
  const hashIdx = t.indexOf(" #");
  return hashIdx >= 0 ? t.slice(0, hashIdx).trim() : t;
}

function parseNumber(raw: string): number {
  const n = Number(stripValue(raw));
  if (!Number.isFinite(n)) {
    throw new Error(`Expected a number, got: "${raw}"`);
  }
  return n;
}

/**
 * Parse a single pricing-sources/*.yaml file into a SourceFile.
 * Throws with a descriptive message on any structural or validation problem.
 */
function parseSourceYaml(content: string, filename: string): SourceFile {
  const lines = content.split("\n");
  const result: Partial<SourceFile> & { models: SourceModel[] } = { models: [] };
  let state: ParseState = "top";
  let currentModel: (Partial<SourceModel> & { aliases: string[] }) | null = null;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const raw = lines[lineNum]!;
    const line = raw.trimEnd();

    // Skip comments and blank lines at any level.
    const stripped = line.trimStart();
    if (stripped === "" || stripped.startsWith("#")) continue;

    const indent = line.length - stripped.length;

    if (indent === 0) {
      // Top-level key: value
      const colonIdx = stripped.indexOf(":");
      if (colonIdx === -1) continue;
      const key = stripped.slice(0, colonIdx).trim();
      const valueRaw = stripped.slice(colonIdx + 1);

      if (key === "models") {
        state = "in_models";
      } else {
        state = "top";
        const value = stripValue(valueRaw);
        (result as Record<string, unknown>)[key] = value;
      }
    } else if (indent === 2 && state !== "top") {
      // Sequence item opener: "  - key: value" or "  - key:"
      if (!stripped.startsWith("- ")) continue;
      const rest = stripped.slice(2); // drop "- "

      // Finalize previous model if any.
      if (currentModel !== null) {
        result.models.push(finaliseModel(currentModel, filename));
      }
      currentModel = { aliases: [] };
      state = "in_model";

      // The first key-value may be on the same line as the dash.
      const colonIdx = rest.indexOf(":");
      if (colonIdx !== -1) {
        const key = rest.slice(0, colonIdx).trim();
        const valueRaw = rest.slice(colonIdx + 1);
        applyModelField(currentModel, key, valueRaw, lineNum + 1, filename);
      }
    } else if (indent === 4 && state === "in_model" && currentModel !== null) {
      // Model sub-property: "    key: value" or "    key:" (for aliases)
      const colonIdx = stripped.indexOf(":");
      if (colonIdx === -1) continue;
      const key = stripped.slice(0, colonIdx).trim();
      const valueRaw = stripped.slice(colonIdx + 1);

      if (key === "aliases") {
        state = "in_aliases";
        // The aliases value itself is empty (list follows on next lines).
      } else {
        applyModelField(currentModel, key, valueRaw, lineNum + 1, filename);
      }
    } else if (indent === 6 && state === "in_aliases" && currentModel !== null) {
      // Alias item: "      - value"
      if (!stripped.startsWith("- ")) continue;
      const alias = stripValue(stripped.slice(2));
      if (alias) currentModel.aliases.push(alias);
    } else if (indent === 4 && state === "in_aliases" && currentModel !== null) {
      // Back to model properties after aliases list ends.
      state = "in_model";
      const colonIdx = stripped.indexOf(":");
      if (colonIdx !== -1) {
        const key = stripped.slice(0, colonIdx).trim();
        const valueRaw = stripped.slice(colonIdx + 1);
        applyModelField(currentModel, key, valueRaw, lineNum + 1, filename);
      }
    }
  }

  // Finalise the last model.
  if (currentModel !== null) {
    result.models.push(finaliseModel(currentModel, filename));
  }

  // Validate required top-level fields.
  const missing: string[] = [];
  if (!result.provider) missing.push("provider");
  if (!result.asOf) missing.push("asOf");
  if (!result.sourceUrl) missing.push("sourceUrl");
  if (missing.length > 0) {
    throw new Error(`${filename}: missing required top-level fields: ${missing.join(", ")}`);
  }

  return result as SourceFile;
}

/** Apply a raw key/value pair to the current model object being parsed. */
function applyModelField(
  model: Partial<SourceModel> & { aliases: string[] },
  key: string,
  valueRaw: string,
  lineNum: number,
  filename: string,
): void {
  try {
    switch (key) {
      case "id":
        model.id = stripValue(valueRaw);
        break;
      case "inputPerMTokUSD":
        model.inputPerMTokUSD = parseNumber(valueRaw);
        break;
      case "outputPerMTokUSD":
        model.outputPerMTokUSD = parseNumber(valueRaw);
        break;
      case "cacheReadPerMTokUSD":
        model.cacheReadPerMTokUSD = parseNumber(valueRaw);
        break;
      case "cacheWritePerMTokUSD":
        model.cacheWritePerMTokUSD = parseNumber(valueRaw);
        break;
      // Unknown keys are silently ignored for forward compatibility.
    }
  } catch (err) {
    throw new Error(`${filename}:${lineNum}: field "${key}": ${(err as Error).message}`);
  }
}

/** Validate that a fully-parsed model item has all required fields. */
function finaliseModel(
  partial: Partial<SourceModel> & { aliases: string[] },
  filename: string,
): SourceModel {
  const required = [
    "id",
    "inputPerMTokUSD",
    "outputPerMTokUSD",
    "cacheReadPerMTokUSD",
    "cacheWritePerMTokUSD",
  ] as const;

  const missing = required.filter((k) => partial[k] === undefined);
  if (missing.length > 0) {
    const id = partial.id ?? "<unknown>";
    throw new Error(`${filename}: model "${id}" missing required fields: ${missing.join(", ")}`);
  }

  // provider is set during assembly, not parsed from the model block.
  return partial as SourceModel;
}

// ---------------------------------------------------------------------------
// Staleness check
// ---------------------------------------------------------------------------

const STALE_DAYS = 180;

/** Returns true if the asOf date string is older than STALE_DAYS days. */
function isStale(asOf: string): boolean {
  const asOfMs = new Date(asOf).getTime();
  if (Number.isNaN(asOfMs)) return true; // malformed date = treat as stale
  const ageMs = Date.now() - asOfMs;
  return ageMs > STALE_DAYS * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const checkMode = process.argv.includes("--check");
  const repoRoot = process.cwd();
  const sourcesDir = join(repoRoot, "pricing-sources");
  const outPath = join(repoRoot, "store", "src", "pricing", "rates.json");
  const distPath = join(repoRoot, "store", "dist", "src", "pricing", "rates.json");

  // ── 1. Read and parse all YAML source files ───────────────────────────────
  let yamlFiles: string[];
  try {
    yamlFiles = readdirSync(sourcesDir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .sort(); // sort for deterministic ordering
  } catch {
    console.error(`[generate-pricing] Cannot read pricing-sources/: ${sourcesDir}`);
    process.exit(1);
  }

  if (yamlFiles.length === 0) {
    console.error("[generate-pricing] No .yaml files found in pricing-sources/");
    process.exit(1);
  }

  const parsedSources: SourceFile[] = [];
  let hasError = false;

  for (const filename of yamlFiles) {
    const filePath = join(sourcesDir, filename);
    try {
      const content = readFileSync(filePath, "utf8");
      const parsed = parseSourceYaml(content, filename);
      parsedSources.push(parsed);
    } catch (err) {
      console.error(`[generate-pricing] ${(err as Error).message}`);
      hasError = true;
    }
  }

  if (hasError) {
    console.error("[generate-pricing] Aborting due to parse errors.");
    process.exit(1);
  }

  // ── 2. Check staleness ────────────────────────────────────────────────────
  for (const src of parsedSources) {
    if (isStale(src.asOf)) {
      const msg =
        `[generate-pricing] WARNING: pricing-sources/${src.provider}.yaml has ` +
        `asOf="${src.asOf}" which is more than ${STALE_DAYS} days old. ` +
        `Update the rates and bump asOf to today.`;
      if (checkMode) {
        console.error(msg);
        hasError = true;
      } else {
        console.warn(msg);
      }
    }
  }

  // ── 3. Assemble the output RatesJson object ───────────────────────────────
  // Collect all models across providers, attach the provider field, and sort
  // by id for a stable, reproducible diff.
  const allModels: SourceModel[] = [];
  for (const src of parsedSources) {
    for (const model of src.models) {
      allModels.push({ ...model, provider: src.provider });
    }
  }

  // Sort by id (case-insensitive) for reproducible diffs.
  allModels.sort((a, b) => a.id.localeCompare(b.id, "en", { sensitivity: "base" }));

  const generated: RatesJson = {
    generatedAt: new Date().toISOString(),
    sources: parsedSources.map(({ provider, asOf, sourceUrl }) => ({
      provider,
      asOf,
      sourceUrl,
    })),
    models: allModels,
  };

  // ── 4. Check mode: compare with existing file ─────────────────────────────
  if (checkMode) {
    let existing: RatesJson | null = null;
    try {
      existing = JSON.parse(readFileSync(outPath, "utf8")) as RatesJson;
    } catch {
      console.error(
        `[generate-pricing] --check: cannot read ${outPath}. ` +
          "Run 'pnpm exec tsx scripts/generate-pricing.ts' to generate it first.",
      );
      process.exit(1);
    }

    // Compare everything except generatedAt (which changes every run).
    const newPayload = JSON.stringify({ sources: generated.sources, models: generated.models });
    const oldPayload = JSON.stringify({ sources: existing.sources, models: existing.models });

    if (newPayload !== oldPayload) {
      console.error(
        "[generate-pricing] --check: rates.json is out of sync with pricing-sources/. " +
          "Run 'pnpm exec tsx scripts/generate-pricing.ts' to regenerate.",
      );
      hasError = true;
    } else {
      console.log("[generate-pricing] --check: rates.json is up to date.");
    }

    if (hasError) process.exit(1);
    return;
  }

  // ── 5. Write output ───────────────────────────────────────────────────────
  const json = JSON.stringify(generated, null, 2) + "\n";

  // Primary output: store/src/pricing/rates.json (source of truth, committed).
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, json, "utf8");
  console.log(`[generate-pricing] Written: ${outPath}`);

  // Mirror to dist/ so the compiled store package finds the JSON at
  // require("./rates.json") without an extra copy step. TypeScript's tsc does
  // not copy non-TS files, so we do it here. mkdir -p is safe on re-runs.
  mkdirSync(resolve(distPath, ".."), { recursive: true });
  writeFileSync(distPath, json, "utf8");
  console.log(`[generate-pricing] Mirrored: ${distPath}`);

  // Warn about stale dates (already printed above in non-check mode).
}

main();
