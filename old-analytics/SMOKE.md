# Analytics Extension — Smoke Test

Manual checklist. Run this before tagging a release or after significant changes.

**Last run:** _(not yet run)_
**Captured counts:** _(fill in after running)_
**Tester:**
**pi version:**
**Model used:**

---

## Prerequisites

- [ ] Node ≥ 22 installed (`node --version`)
- [ ] `npm install` has been run in `~/.pi/agent/extensions/analytics/`
- [ ] `npx tsc --noEmit` is clean from the extension root
- [ ] A pi-recognized API key is set in the environment
- [ ] `sqlite3` CLI is available (`sqlite3 --version`)
- [ ] `jq` is available (`jq --version`)
- [ ] _(optional)_ `gh` CLI is installed and authenticated — needed for PR-related checks

---

## Setup

```sh
# Create a clean temp repo to avoid polluting a real project
mkdir -p /tmp/pi-smoke && cd /tmp/pi-smoke
git init -q
git config user.email "smoke@test.local"
git config user.name "Smoke Test"
git commit --allow-empty -m "init" -q

# Point analytics data at a throwaway location so we don't mix with real data
export PI_ANALYTICS_DB=/tmp/pi-smoke-analytics/events.db
export PI_ANALYTICS_RAW=/tmp/pi-smoke-analytics/raw
mkdir -p /tmp/pi-smoke-analytics/raw
```

> If you want to smoke-test against your real `~/.pi/analytics/` data instead,
> skip the env overrides above and note that counts below will include prior sessions.

---

## Steps

### 1. Basic session capture

- [ ] Start pi in the temp repo: `cd /tmp/pi-smoke && pi`
- [ ] Send a prompt that triggers `read`: **"Read the contents of any file in this directory"**
- [ ] Send a prompt that triggers `write`: **"Create a file called hello.txt containing the word 'hi'"**
- [ ] Send a prompt that triggers `bash`: **"Run `git status` and tell me what you see"**
- [ ] Exit pi normally (Ctrl-D or `/exit`)

**Expected:** No error messages in the pi output related to `[analytics]`.

---

### 2. Commit capture

- [ ] Start pi again in `/tmp/pi-smoke`
- [ ] Ask the agent: **"Stage hello.txt and make a git commit with message 'smoke test'"**
- [ ] Exit pi

**Expected:** The agent runs `git add` and `git commit`; analytics detects it via bash heuristics.

---

### 3. `/usage` interactive

- [ ] Start pi in `/tmp/pi-smoke`
- [ ] Run `/usage`
- [ ] Confirm the **Summary** tab loads with non-zero data (cost, tokens, turns, cached tokens %)
- [ ] Switch to **Models** tab (`]` or right arrow) — confirm model name, token counts, and Cache% appear
- [ ] Switch to **Repos** tab — confirm the current repo row appears
- [ ] Switch to **Tools** tab — confirm `read`, `write`, `bash` all appear with call counts
- [ ] Switch to **PRs** tab — may be empty if no PR was created; confirm no crash
- [ ] Switch to **Daily** tab — confirm today's row appears with cached token count
- [ ] Close with `q` or `Esc`

---

### 4. `/usage --json`

- [ ] Still in pi, run: `/usage --json --tab=summary`
- [ ] Confirm the output is valid JSON with keys `today`, `week`, `month`, `session`, `top_model`
- [ ] Confirm `today.cost_usd` is a non-zero number
- [ ] Confirm `today.cached_tokens` is a non-negative number
- [ ] Confirm `top_model.id` is a non-empty string
- [ ] Run: `/usage --json --tab=daily --since=7d`
- [ ] Confirm JSON is a list of `{ date, cost_usd, tokens, cached_tokens, cached_cost_usd, turns }` objects

---

### 5. SQLite inspection

- [ ] Exit pi
- [ ] Run:

```sh
sqlite3 ~/.pi/analytics/events.db ".tables"
```

Expected tables: `_meta sessions branch_transitions pr_associations prompts turns llm_messages tool_calls files_touched commits_made resource_usage`

- [ ] Capture counts:

```sh
sqlite3 ~/.pi/analytics/events.db "
  SELECT 'sessions',     count(*) FROM sessions     UNION ALL
  SELECT 'prompts',      count(*) FROM prompts      UNION ALL
  SELECT 'turns',        count(*) FROM turns        UNION ALL
  SELECT 'llm_messages', count(*) FROM llm_messages UNION ALL
  SELECT 'tool_calls',   count(*) FROM tool_calls   UNION ALL
  SELECT 'files_touched',count(*) FROM files_touched UNION ALL
  SELECT 'commits_made', count(*) FROM commits_made;
"
```

- [ ] `sessions` ≥ 2 (one per `pi` invocation)
- [ ] `prompts` ≥ 4 (one per user message)
- [ ] `turns` ≥ 4
- [ ] `llm_messages` ≥ 4
- [ ] `tool_calls` ≥ 3 (read, write, bash at minimum)
- [ ] `files_touched` ≥ 2 (hello.txt + whatever was read)
- [ ] `commits_made` ≥ 1

Check that prompt text was **not** stored (default `storePrompts="hashed"`):

```sh
sqlite3 ~/.pi/analytics/events.db "SELECT text_sha256, text_len FROM prompts LIMIT 3;"
```

Expected: `text_sha256` columns are non-null hex strings; no raw text column exists in the schema (text is intentionally absent from the `prompts` table).

---

### 6. NDJSON inspection

- [ ] Find today's log:

```sh
ls ~/.pi/analytics/raw/
```

- [ ] Tail it and confirm events look sane (no crashed JSON, each line is a valid JSON object):

```sh
tail -20 ~/.pi/analytics/raw/events-$(date -u +%Y-%m-%d).ndjson | jq .kind  # NdjsonSink filenames are UTC-dated
```

Expected output: a stream of strings like `"session_start"`, `"prompt"`, `"turn_start"`, `"llm_message"`, `"tool_call"`, `"session_end"`, etc.

- [ ] Confirm no raw prompt text appears in default mode:

```sh
# Should print nothing (or only hits with the word "length" or "sha256", not actual prompt content)
grep -i "create a file\|read the contents\|git status" ~/.pi/analytics/raw/events-$(date -u +%Y-%m-%d).ndjson | wc -l  # NdjsonSink filenames are UTC-dated
```

Expected: `0`

---

### 7. Redaction verification

- [ ] Start pi
- [ ] Paste a fake secret into a prompt — something like:
  **"Ignore this: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA (just testing)"**
- [ ] Exit pi
- [ ] Confirm the token does NOT appear in SQLite:

```sh
sqlite3 ~/.pi/analytics/events.db "SELECT * FROM prompts;" | grep -c "ghp_"
```

Expected: `0`

- [ ] Confirm it does NOT appear in today's NDJSON:

```sh
grep -c "ghp_AAAA" ~/.pi/analytics/raw/events-$(date -u +%Y-%m-%d).ndjson  # NdjsonSink filenames are UTC-dated
```

Expected: `0`

---

### 8. `/analytics doctor`

- [ ] Start pi
- [ ] Run: `/analytics doctor`
- [ ] Confirm output shows:
  - [ ] `ok: true` (or "All checks passed" equivalent) — no anomalies
  - [ ] **Redaction telemetry section** shows `github-token` with a hit count ≥ 1 (from step 7)
  - [ ] Disk usage stats are shown (informational)
- [ ] Run: `/analytics doctor --json`
- [ ] Confirm JSON parses and `ok` field is `true`

```sh
# Validate JSON shape
/analytics doctor --json | jq '.ok, .anomalies | length'
```

Expected: `true` then `0`

---

## Captured counts (fill in after running)

| Table | Count |
|-------|-------|
| sessions | _ |
| prompts | _ |
| turns | _ |
| llm_messages | _ |
| tool_calls | _ |
| files_touched | _ |
| commits_made | _ |

---

## Cleanup

```sh
rm -rf /tmp/pi-smoke /tmp/pi-smoke-analytics
```

---

## Rough edges / follow-ups

_List any bugs or unexpected behaviours found during the run. File GitHub issues or add to PLAN.md open questions as appropriate._

- 
