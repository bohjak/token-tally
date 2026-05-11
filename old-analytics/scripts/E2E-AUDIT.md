# E2E Audit Report
**Date:** 2026-05-07  
**Auditor:** worker subagent  
**Scope:** Static analysis, doctor dry-run, SMOKE.md drift check — no real pi/API calls made.

---

## 1. Static Checks

| Check | Result | Detail |
|-------|--------|--------|
| `bash -n e2e.sh` | ✅ PASS | No syntax errors |
| `shellcheck` | ⚠️ SKIP | Not installed on this machine |
| Env vars documented | ✅ PASS | `PI_E2E_MODEL`, `PI_BIN`, `SQLITE3_BIN` all documented in header |
| API key documented | ✅ PASS | "Matching API key env var must also be set (ANTHROPIC_API_KEY, etc.)" |
| `EXT_DIR` symlink resolves | ✅ PASS | `$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)` resolves to `/Users/j.bohacek/.pi/agent/extensions/analytics` |
| SQLite table names | ✅ PASS | All five tables queried (`sessions`, `prompts`, `turns`, `llm_messages`, `tool_calls`) exist in `001_init.sql` |
| `jq -e` shape vs actual JSON | ❌ **FAIL** | See §1a below |
| `awk` checks 5 columns, tests 4 | ⚠️ WARN | `tool_calls` is selected (`$5`) but never asserted in awk |

### §1a — `jq` assertion mismatch (CRITICAL)

The script asserts:
```bash
jq -e '.today and .week and .session'
```

The actual `tabSummary` return shape (added since T14 was written) is:
```json
{ "today": {…}, "week": {…}, "month": {…}, "session": {…}, "top_model": {…} }
```

The assertion would pass (`.today`, `.week`, `.session` are all present). **However the shape check doesn't verify `.month`**, which was added recently and is also expected. Low severity — the current assertion won't fail — but it also won't catch a regression that drops `month`.

**Recommended fix** (1 line in `e2e.sh`):
```diff
-  | jq -e '.today and .week and .session' >/dev/null
+  | jq -e '.today and .week and .month and .session and (.today.cost_usd | type == "number")' >/dev/null
```

### §1b — `awk` selects 5 columns but only checks 4

`tool_calls` is the 5th column in the SELECT but awk only checks `$1`–`$4`. The `tool_calls` count is echoed in the log line but silently passes even if zero.

**Recommended fix**:
```diff
+  if ($5 < 1) { print "FAIL: tool_calls < 1"; ok = 0 }
```

---

## 2. Doctor Dry-Run

### 2a — Empty DB (exit code check)

```
$ node24 scripts/doctor.mjs --db /tmp/doctor-empty-test.db
analytics doctor — ✅ all checks passed

  No anomalies.

Info:
  ndjson_skipped: "rawLogDir not provided — checks 5 & 6 skipped"
  events_db_bytes: 4096

EXIT: 0
```

✅ Empty DB produces exit code 0 with "all checks passed".  
⚠️ Note: requires Node 24.x. `better-sqlite3` in `node_modules/` was compiled against Node 24 (MODULE_VERSION 137). Running `node scripts/doctor.mjs` with the default shell `node` (v22.22.2, MODULE_VERSION 127) produces a fatal `ERR_DLOPEN_FAILED`. e2e.sh does not check or enforce the Node version.

### 2b — Real DB (`~/.pi/analytics/events.db`)

```json
{
  "ok": true,
  "anomalies": [
    {
      "check": "stale_sessions",
      "severity": "warn",
      "count": 1,
      "sample": [{ "id": "97d4e07b-…", "started_at": 1778069626988 }]
    },
    {
      "check": "ndjson_sqlite_drift",
      "severity": "warn",
      "count": 3983,
      "sample": { "ndjson_lines": 10105, "sqlite_count": 6122, "diff": 3983 }
    }
  ],
  "info": [
    { "label": "redaction_telemetry_7d",
      "value": [{ "rule": "cli-password-flag", "count": 35 }] },
    { "label": "ndjson_files_scanned", "value": 2 },
    { "label": "events_db_bytes", "value": 2375680 },
    { "label": "raw_dir_bytes", "value": 4315334 }
  ]
}
```

**`ok: true`** — both anomalies are `severity: "warn"`, so doctor exits 0 as expected.

**Anomaly analysis:**
- `stale_sessions` (1 row) — one session without `ended_at` older than 24h. Likely the very first pi session before the extension was loaded. Expected; not a code bug.
- `ndjson_sqlite_drift` (3983) — NDJSON has 10,105 lines vs SQLite's 6,122 trackable rows for today. This is **expected and by design**: NDJSON also records session_start/end, model_select, thinking_level_select, branch_transition, etc. events that have no corresponding SQLite table rows. The ±5 tolerance in the code is too tight for normal operation and will always fire. The check is informational but the threshold makes it a constant false-positive. Not blocking for e2e, but noisy.
- `redaction_telemetry_7d` — 35 `cli-password-flag` hits over 7 days. Healthy sign that redaction is running. No `github-token` hits, which is expected (no fake secret was pasted in a smoke run yet).

---

## 3. SMOKE.md Drift

### Step 3 — `/usage` interactive

| SMOKE says | Actual state |
|---|---|
| Switch to **Models** tab (`]` or right arrow) | ✅ Correct — `]` = `Key.rightbracket`, right arrow = `Key.right` |
| Switch to **Tools** tab | ✅ Exists. SMOKE skips **Repos** and **PRs** tabs — these exist but aren't exercised. Minor gap. |
| Close with `q` or `Esc` | ✅ Correct |
| Tab order implied by steps | ✅ Matches `["summary","models","repos","tools","prs","daily"]` |

### Step 4 — `/usage --json` expected keys

**SMOKE says:** `keys today, week, allTime, top_model`  
**Actual shape:** `{ today, week, month, session, top_model }`

Two drifts:
1. `allTime` → does not exist. Was never implemented.
2. `session` → exists; not mentioned.
3. `month` → added recently; not mentioned.
4. The daily tab JSON shape listed as `{ date, cost_usd, input_tokens, output_tokens, turns }` — actual shape is `{ date, cost_usd, tokens, cached_tokens, cached_cost_usd, turns }`. `input_tokens`/`output_tokens` are separate in `llm_messages` but the daily tab aggregates them into a single `tokens` field.

**Recommended SMOKE.md patch for step 4:**
```diff
-- [ ] Confirm the output is valid JSON with keys `today`, `week`, `allTime`, `top_model`
++ [ ] Confirm the output is valid JSON with keys `today`, `week`, `month`, `session`, `top_model`
-- [ ] Confirm JSON is a list of `{ date, cost_usd, input_tokens, output_tokens, turns }` objects
++ [ ] Confirm JSON is a list of `{ date, cost_usd, tokens, cached_tokens, cached_cost_usd, turns }` objects
```

### Step 7 — Redaction (ghp_ token)

- `ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` (37 A's) matches the rule `/\bgh[ousprt]_[A-Za-z0-9_]{36,}\b/g` ✅
- Doctor redaction telemetry reads NDJSON files for the last 7 days (UTC) and sums `redacted` fields — will surface `github-token` hits ✅
- SMOKE step 7 says to check NDJSON for the token not appearing. The doctor's redaction section counts rule hits from NDJSON, so this is consistent ✅

### Step 6 — NDJSON file path

**Potential mismatch:** SMOKE uses `date +%Y-%m-%d` (local time). `NdjsonSink.todayFilePath()` uses `getUTCFullYear()` / `getUTCDate()` (UTC).

At offsets ≥ UTC+1 after midnight local time, the NDJSON file will be dated tomorrow (UTC) while `date +%Y-%m-%d` returns today. The `tail` command in SMOKE would silently tail an empty or non-existent file.

**Recommended SMOKE.md patch for step 6:**
```diff
-- tail -20 ~/.pi/analytics/raw/events-$(date +%Y-%m-%d).ndjson | jq .kind
++ tail -20 ~/.pi/analytics/raw/events-$(date -u +%Y-%m-%d).ndjson | jq .kind
```
(Same for the `grep` command two lines below.)

---

## 4. Gaps That Block a Real e2e Run

### 🔴 CRITICAL

**Gap 1: `/usage --json` output is silently swallowed in `-p` mode.**

`index.ts` runs `ctx.ui.notify(JSON.stringify(data, null, 2), "info")`.  
In `-p` mode, the extension runner wires `notify: () => {}` (a hard no-op, confirmed in `dist/core/extensions/runner.js` line 63). The JSON is produced but never written to stdout.

The e2e step 4 assertion:
```bash
HOME="$HOME_FAKE" "$PI_BIN" -p "/usage --json" --model "$PI_E2E_MODEL" \
  | jq -e '.today and .week and .session' >/dev/null
```
will receive empty stdout → `jq` will exit non-zero → **the script will abort at `set -e`**.

**Fix:** Use `console.log` instead of `ctx.ui.notify` when `!ctx.hasUI`:
```ts
// In index.ts usage command handler, json branch:
if (args.json) {
  const data = runUsageJson(sqlite, { tab: args.tab, since: args.since });
  if ((ctx as { hasUI?: boolean }).hasUI === false) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    ctx.ui.notify(JSON.stringify(data, null, 2), "info");
  }
}
```

**Gap 2: `doctor.mjs` requires Node 24; e2e.sh uses shell `node` (v22.22.2).**

`better-sqlite3` in `node_modules/` was compiled for Node 24 (MODULE_VERSION 137). The default `node` on this machine is v22 (MODULE_VERSION 127). Running `node scripts/doctor.mjs` from e2e.sh will crash with `ERR_DLOPEN_FAILED`.

**Fix option A** (recommended): rebuild `better-sqlite3` for Node 22 (the shell default):
```bash
cd ~/.pi/agent/extensions/analytics && npm rebuild better-sqlite3
```
Then verify with `node --version` that the shell node matches what was used for `npm install`.

**Fix option B**: add a node version gate in `e2e.sh`:
```bash
node_major=$(node -e "process.stdout.write(String(process.versions.modules))")
if [[ "$node_major" -ne 137 ]]; then
  echo "[e2e] WARN: node modules version $node_major != 137 (Node 24); doctor step may fail"
fi
```

### 🟡 WARN

**Gap 3: `session_shutdown` async flush in `-p` mode.**

The extension registers `session_shutdown` to call `sink.flush()` then `sink.close()`. In `-p` mode, pi emits `session_shutdown` before exiting (`dist/core/extensions/runner.js` confirms this). However, there is a potential race: if the shutdown handler is not awaited before the process exits, the SQLite WAL checkpoint may be incomplete and the DB file may not be visible to the subsequent `sqlite3` assertion.

This is likely fine in practice (better-sqlite3 flushes on `db.close()`), but should be verified on first real run. If row counts come back as 0, this is the first suspect.

**Gap 4: `ndjson_sqlite_drift` warning will always fire.**

The ±5 tolerance was set assuming only a handful of extra NDJSON-only event types, but in practice the gap is ~4000 rows per day (session events, model_select, etc. with no table rows). Doctor exits 0 (both anomalies are `warn`) so the e2e script passes — but the warning is a constant false-positive that will erode trust in the doctor output.

**Gap 5: `awk` count check doesn't assert `tool_calls ≥ 1`** (see §1b above).  
A prompt of "List files in this directory" might use an `ls` tool that isn't captured as a `tool_call` row depending on how the model responds. Worth checking.

**Gap 6: SMOKE.md step 4 references non-existent `allTime` key** (see §3 above).  
Not blocking for `e2e.sh` but would confuse a manual smoke tester.

---

## 5. Recommended Fixes (ordered by impact)

| # | File | Fix | Severity |
|---|------|-----|----------|
| 1 | `src/index.ts` | Use `console.log` for `--json` when `!ctx.hasUI` | 🔴 Critical — e2e step 4 will always fail without this |
| 2 | `package.json` / `npm install` | Ensure `better-sqlite3` is compiled for the Node version used by e2e.sh | 🔴 Critical — doctor step crashes |
| 3 | `scripts/e2e.sh` | Update `jq -e` to include `.month` and a type check | 🟡 Warn |
| 4 | `scripts/e2e.sh` | Add `$5 < 1` check for `tool_calls` in awk | 🟡 Warn |
| 5 | `SMOKE.md` step 4 | Fix key list (`allTime` → `month`+`session`), fix daily shape | 🟡 Warn |
| 6 | `SMOKE.md` step 6 | Use `date -u` for NDJSON filename | 🟡 Warn (timezone-dependent) |
| 7 | `src/commands/doctor.ts` | Raise `ndjson_sqlite_drift` threshold to 2000+ or make it informational-only | 🟢 Nice |
