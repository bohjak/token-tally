# Plugin Authoring — ToTally

This document is for developers writing a ToTally harness integration (also
called a "writer"). A writer is a plugin, hook, or extension that captures
usage events from a specific coding-agent harness and records them in the
central ToTally store.

The Pi writer under `harnesses/pi/writer-extension/` is the reference
implementation.

---

## Core contract

Every writer must satisfy four invariants before events reach the store:

1. **Identity** — declare a stable harness `name`, harness version, and
   integration version on every run.
2. **Idempotency** — replay of the same event must not create duplicate rows.
3. **Cost provenance** — set `cost_source` accurately; never leave it `unknown`
   when cost information is available.
4. **Data minimization** — never record prompts, responses, tool arguments, tool
   outputs, file contents, secrets, or environment variables.

---

## Using the store library (preferred)

Writers import `@token-tally/store` and call its typed write methods. The
library handles connection setup, WAL mode, foreign-key enforcement,
migrations, spool fallback, and idempotent upserts automatically.

```ts
import { AnalyticsWriter } from "@token-tally/store";

const writer = await AnalyticsWriter.open();

// Always register the harness first so foreign-key constraints pass.
await writer.recordHarness({
  name: "my-harness",           // stable lowercase slug — see "Harness name" below
  displayName: "My Harness",
  version: harnessVersion,      // version of the harness itself
  integrationVersion: "0.1.0",  // version of this writer plugin
});

await writer.recordSession({ ... });
await writer.recordTurn({ ... });
await writer.recordLlmMessage({ ... });
await writer.recordToolCall({ ... });

await writer.close();
```

Do **not** open the database directly with ad-hoc SQL. Using the library
ensures:

- `PRAGMA foreign_keys = ON` is applied before any writes.
- `PRAGMA journal_mode = WAL` is in effect.
- Schema version is validated before any write is attempted.
- The spool fallback activates automatically if the DB is unavailable.
- Upsert semantics match the schema's idempotency keys.

---

## Using the CLI (for non-TypeScript harnesses)

If the harness cannot link a TypeScript package, use the `token-tally` CLI:

```sh
# Ensure the DB is migrated (safe to run on every harness startup).
token-tally migrate

# Record events by type with a JSON payload.
token-tally record --type harness     --json '{"name":"my-harness",...}'
token-tally record --type session     --json '{"id":"...","harnessId":"...",...}'
token-tally record --type llm-message --json '{"id":"...","harnessId":"...",...}'
token-tally record --type tool-call   --json '{"id":"...","harnessId":"...",...}'
```

The CLI applies the same idempotent upsert logic as the library.

Do **not** write SQL directly against the database file. The schema, WAL mode,
and foreign-key state are managed by the store; direct writes bypass those
guarantees.

---

## Harness name

The `name` field in `harnesses` is the primary key referenced by every child
table (`harness_id`). It must be:

- A **stable lowercase slug** — once chosen, never change it. Changing the
  name orphans all historical rows.
- Unique across all ToTally integrations.
- Lowercase, hyphen-separated (same convention as the `token-tally` package
  name). Examples: `pi`, `claude-code`, `opencode`, `cursor`.

Choose the name to match the harness's own identity, not the writer version.

---

## Event IDs and idempotency

Every child table has a harness-scoped unique constraint used as the upsert
key. Writers are responsible for providing stable, non-null IDs:

| Table | Idempotency key |
|---|---|
| `sessions` | `UNIQUE (harness_id, harness_session_id)` |
| `turns` | `UNIQUE (session_id, harness_turn_id)` |
| `llm_messages` | `UNIQUE (harness_id, harness_message_id)` |
| `tool_calls` | `UNIQUE (harness_id, harness_tool_call_id)` |

**If the harness does not expose a stable ID for a given event, the writer must
synthesize one** before calling the store. The synthesized ID must be
deterministic given the same underlying event:

```ts
// Example: synthesize a session ID from the session file path and start time.
const harness_session_id = `${sessionFile}:${startedAt}`;

// Example: synthesize a message ID from session ID and message index.
const harness_message_id = `${sessionId}:${messageIndex}`;
```

These IDs are `NOT NULL` in the schema. `NULL` values would silently break
upsert semantics because SQLite treats `NULL` as distinct in `UNIQUE`
constraints.

---

## Cost provenance

Writers are solely responsible for populating cost columns. The store ships no
pricing table and never synthesizes cost at query time.

### Setting `cost_source`

| Scenario | `cost_source` |
|---|---|
| Harness emits a dollar cost directly | `harness` |
| Harness emits token counts only; writer computes cost | `writer` |
| Tokens were used under a flat-fee subscription | `subscription_covered` |
| Cost is unknown; no pricing information available | `unknown` |

When `cost_source` is `writer`, provenance is implicitly `(harness_id,
integration_version)` — no extra tag is needed in the schema.

### Storing costs as integer micros

All `cost_*` columns are integers representing millionths of one unit of
`cost_currency` (default `USD`):

```ts
// Convert a float dollar value to the integer micro representation.
const cost_total_micros = Math.round(dollarAmount * 1_000_000);
```

The four breakdown columns are the source of truth. `cost_total_micros` is a
writer-maintained cached sum and must equal their exact sum:

```text
cost_total_micros = cost_input_micros + cost_output_micros
                  + cost_cache_read_micros + cost_cache_write_micros
```

The schema enforces this with a `CHECK` constraint. Writes that violate it will
be rejected.

### Cost semantics: list price, not actual spend

Store the **list-price equivalent** — what the message would cost on the
provider's published pay-as-you-go rate. Do not bake in subscription discounts
or proxy markups. The subscription layer handles actual-spend accounting
separately.

---

## Recording subscriptions

When the harness operates under a flat-fee subscription (e.g. Claude Pro,
Cursor Pro), record the subscription period and link each covered message to it:

```ts
const sub = await writer.recordSubscription({
  harnessId: "claude-code",
  planName: "claude-pro",         // writer-defined slug; the store mints the UUID
  periodStart: 1746057600000,     // Unix ms (not seconds)
  periodEnd: 1748735999999,       // Unix ms, inclusive end of billing period
  fixedCost: 20.00,               // flat fee in currency units (float OK here)
  currency: "USD",
  quotaLimit: null,               // optional quota counters
  quotaUsed: null,
  quotaUnit: null,
});
// sub.id is the ToTally-internal UUID for this subscription period.

// Link a covered message.
await writer.recordLlmMessage({
  ...messageFields,
  costSource: "subscription_covered",
  subscriptionId: sub.id,         // use the UUID returned above
  // cost_* columns still hold the PAYG list-price equivalent.
});
```

Writers upsert the subscription row and update `quota_used` / `period_end` as
the period progresses. A subscription row is unique per
`(harness_id, plan_name, period_start)`.

---

## Raw event capture

Writers must **not** emit `raw_events` by default. Raw capture is opt-in and
must be gated on user configuration:

```ts
const config = await loadConfig();
if (config.harnesses?.["my-harness"]?.captureRaw) {
  await writer.recordRawEvent({ kind: "model_select", payloadJson: json });
}
```

### Static allowlist of kinds

Declare a static allowlist of permitted `kind` values in code. Emit only kinds
on that list:

```ts
// Good: allowlist checked at compile time.
const RAW_EVENT_KINDS = ["model_select", "agent_restart"] as const;
type RawEventKind = (typeof RAW_EVENT_KINDS)[number];

function emitRaw(kind: RawEventKind, payload: unknown): void {
  writer.recordRawEvent({ kind, payloadJson: JSON.stringify(payload) });
}
```

Never decide at runtime which new `kind` values to emit based on user input or
harness-emitted data. Emitting a `kind` outside the allowlist is a writer bug.

### Payload data minimization

Even with raw capture enabled, **never include** in `payload_json`:

- Prompts or assistant message text
- Tool arguments or outputs
- File paths beyond the working directory
- Environment variables
- API keys or other secrets

`token-tally doctor` checks recent `raw_events` rows for known-sensitive keys
(`prompt`, `content`, `messages`, `arguments`, `output`, `env`, and common
secret patterns) and reports violations. Make sure your allowed payloads do not
trigger those checks.

---

## Data minimization checklist

Before shipping a writer, verify it never records:

- [ ] User prompts or assistant responses
- [ ] Tool arguments (inputs to tool calls)
- [ ] Tool outputs (stdout, stderr, returned content)
- [ ] File contents read or written by the harness
- [ ] Environment variables
- [ ] API keys, tokens, or other secrets

What the writer **should** record:

- [ ] Timestamps
- [ ] Harness identity and versions
- [ ] Provider and model identifiers
- [ ] Token counts (input, output, cache read, cache write)
- [ ] Cost breakdown in integer micros with accurate `cost_source`
- [ ] Session, turn, message, and tool call IDs
- [ ] Working directory and repo metadata (owner, name, remote)
- [ ] Tool name and error flag

---

## Spool fallback

The store library handles spool fallback automatically. If the database is busy,
unreachable, or running a schema version newer than the writer understands, it
writes events to a NDJSON spool file instead of dropping them.

Spool files live at `~/.local/share/token-tally/spool/`:

- Active: `<harness>-<pid>.ndjson` — append-only while the writer process runs.
- Closed: `<harness>-<pid>-<ts>.ndjson.closed` — rotated on size (≥ 4 MiB),
  age (≥ 1 h), or clean shutdown.

On the next successful DB open, the writer drains all closed spool files before
proceeding. Writers do not need to implement drain logic themselves when using
`@token-tally/store`.

Do not implement your own spool format. Use the library's spool path and naming
conventions so that `token-tally ingest` can recover events from any writer.

---

## Installation

Writers installed via `make install` use symlinks rather than copies:

```text
~/.pi/agent/extensions/token-tally-writer  ->  <repo>/harnesses/pi/writer-extension
```

The symlink name follows `token-tally-<component>` to avoid collisions with
other extensions. Never use the `tt` abbreviation in installed paths or
extension slugs.

---

## Summary of required steps for a new harness integration

1. Choose a stable lowercase `name` slug for the harness.
2. Implement the writer using `@token-tally/store` (or the `token-tally` CLI
   for non-TypeScript environments).
3. Call `recordHarness` with `name`, `displayName`, `version`, and
   `integrationVersion` on every startup.
4. Synthesize stable, deterministic harness-scoped IDs for any event type where
   the harness does not expose its own.
5. Populate all four cost breakdown columns in integer micros and set
   `cost_source` accurately.
6. Record subscription periods when the harness operates under a flat-fee plan.
7. Gate raw event emission behind user configuration; declare a static kind
   allowlist; exclude sensitive data from payloads.
8. Add an `install-<harness>.sh` component script and wire it into
   `scripts/install.sh`.
9. Document the integration in this file under a new harness-specific section.

---

## Claude Code integration

The Claude Code writer lives at `harnesses/claude-code/writer/` and builds a
Node hook command named `token-tally-claude-hook`. Unlike the Pi writer, Claude
Code does not load a long-lived extension process. It executes hook commands as
short-lived subprocesses and sends each hook payload as JSON on stdin.

### Installed hooks

`make install` runs `scripts/install-claude-code.sh` when `~/.claude/` exists.
The script builds the writer, symlinks:

```text
~/.local/bin/token-tally-claude-hook
  -> <repo>/harnesses/claude-code/writer/dist/bin/token-tally-claude-hook.js
```

and merges ToTally-owned commands into `~/.claude/settings.json` for these
Claude Code hook events:

- `SessionStart`
- `SessionEnd`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `SubagentStop`

The merge is idempotent. Existing settings are preserved and the previous file
is backed up before the first modification in an install run.

### Transcript drain strategy

Claude Code hook payloads identify the session (`session_id`), working
directory (`cwd`), and transcript file (`transcript_path`), but they do not
include token counts or costs. The writer therefore incrementally reads the
JSONL transcript at `transcript_path`, extracts assistant entries with
`message.usage`, and records them as `llm_messages` rows.

A per-session state file under `~/.local/state/token-tally/claude-code/` tracks
only the transcript offset, current turn, active tool IDs, and ToTally-internal
row IDs. It never stores prompts, responses, tool inputs, tool outputs, file
contents, or environment variables.

### Cost and subscriptions

The writer computes list-price costs from the static Anthropic pricing table at
`harnesses/claude-code/writer/src/pricing/models.ts` and records
`cost_source = 'writer'`. If a transcript entry contains a legacy `costUSD`
field, the writer treats that as harness-provided cost and records
`cost_source = 'harness'`.

Claude Pro/Max subscription accounting is opt-in because Claude Code hook
payloads do not reliably expose the active billing plan. Configure it in
`~/.config/token-tally/config.json`:

```json
{
  "harnesses": {
    "claude-code": {
      "subscription": "claude-pro",
      "subscriptionFixedCostUSD": 20,
      "subscriptionStartDay": 1
    }
  }
}
```

When configured, each computed message is linked to the current monthly
subscription period and recorded with `cost_source = 'subscription_covered'`.
The cost columns still hold the PAYG list-price equivalent.

---

## Cursor integration

The Cursor writer lives at `harnesses/cursor/writer/` and builds a Node hook
command named `token-tally-cursor-hook`. Like the Claude Code writer, it runs
as a short-lived subprocess per hook event, receiving the payload as JSON on
stdin.

### Installed hooks

`make install` runs `scripts/install-cursor.sh` when Cursor is detected.
The script builds the writer, symlinks:

```text
~/.local/bin/token-tally-cursor-hook
  -> <repo>/harnesses/cursor/writer/dist/bin/token-tally-cursor-hook.js
```

and merges ToTally-owned commands into `~/.cursor/hooks.json` for these
Cursor hook events:

- `sessionStart`
- `sessionEnd`
- `beforeSubmitPrompt`
- `afterAgentResponse`
- `preToolUse`
- `postToolUse`
- `postToolUseFailure`
- `stop`
- `subagentStop`
- `preCompact`

The merge is idempotent. Existing settings are preserved and the previous file
is backed up before the first modification in an install run.

### Native config shape

Cursor's `~/.cursor/hooks.json` uses **lower-camel event names** and **flat
hook entries** — this is different from Claude Code's nested
`{ "hooks": [{ "type": "command", ... }] }` format. A ToTally-owned entry
looks like:

```json
{
  "version": 1,
  "hooks": {
    "afterAgentResponse": [{ "command": "token-tally-cursor-hook" }],
    "preToolUse":         [{ "command": "token-tally-cursor-hook" }]
  }
}
```

Do not copy the Claude Code `settings.json` shape into `hooks.json`.

### Payload identity fields

Cursor hook payloads use different identity fields than Claude Code:

| Field | Description |
|---|---|
| `conversation_id` | Stable ID for the session across all turns. Present on most agent hooks. |
| `generation_id` | Changes with every user message; used as the turn/message correlation ID. |
| `session_id` | Documented only on `sessionStart` / `sessionEnd`; equivalent to `conversation_id`. |
| `model` | Model configured for the composer at hook time. |
| `transcript_path` | Path to the conversation transcript file, when transcripts are enabled. |

The writer maps these to ToTally IDs using these rules:

- `harness_session_id = conversation_id ?? session_id` — if neither is present
  the event is silently ignored.
- `harness_turn_id = generation_id` when present; otherwise synthesized from
  a per-session counter.
- `harness_message_id = cursor:<conversation_id>:<generation_id>:assistant`
  for `afterAgentResponse` when both fields exist; otherwise synthesized from
  a session message counter.
- `harness_tool_call_id = tool_use_id` when present; otherwise synthesized
  from the session id, turn id, and a per-turn tool counter.

### Token and cost handling

Cursor hook payloads do not include per-message token counts. The writer
therefore records `afterAgentResponse` as a zero-token placeholder with
`cost_source = 'unknown'` immediately, then best-effort backfills token and
model information on `stop` and `sessionEnd` in this order:

1. **Transcript** — if `transcript_path` is present and readable, the writer
   inspects it first. If the transcript contains stable message IDs and usable
   token metadata, this is the preferred source.
2. **Private SQLite fallback** — if transcript data is unavailable, the writer
   reads Cursor's `state.vscdb` (`cursorDiskKV` table, opened read-only with
   `query_only=1`) for token counts stored per bubble. This is experimental:
   counts are often zero in practice. Platform-specific paths:

   | Platform | Path |
   |---|---|
   | macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
   | Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |
   | Windows | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` |

   If the file is absent, locked, or on an unsupported platform, the writer
   skips the backfill — missing private state is never treated as an error.

After backfill, `cost_source` is set as follows:

- Tokens present and model resolves in the shared pricing table →
  `cost_source = 'writer'`
- Subscription configured and tokens resolved →
  `cost_source = 'subscription_covered'`, cost columns hold the PAYG
  list-price equivalent
- Otherwise → `cost_source = 'unknown'`, cost columns remain `0`

The backfill upserts are idempotent — re-running `stop` for the same session
never creates duplicate rows.

### Raw event capture

Raw capture is **off by default**. The only eligible event is `preCompact`,
which fires before Cursor summarises the context window. When `captureRaw` is
enabled, the writer emits a minimal raw event with these fields only — no
prompt text or response content:

| Field | Type | Notes |
|---|---|---|
| `trigger` | string | `"auto"` or event-provided value |
| `context_tokens` | number\|null | Tokens currently in the context window |
| `context_window_size` | number\|null | Maximum context window size |
| `context_usage_percent` | number\|null | Percentage of window in use |
| `is_first_compaction` | boolean\|null | Whether this is the first compaction in the session |
| `session_id` | string | Present when a harness session ID is available |

Enable it in `~/.config/token-tally/config.json`:

```json
{
  "harnesses": {
    "cursor": {
      "captureRaw": true
    }
  }
}
```

### Subscriptions

Cursor Pro subscription tracking is opt-in. Configure it in
`~/.config/token-tally/config.json`:

```json
{
  "harnesses": {
    "cursor": {
      "subscription": "cursor-pro",
      "subscriptionFixedCostUSD": 20,
      "subscriptionStartDay": 1,
      "captureRaw": false
    }
  }
}
```

When configured, each backfilled message is linked to the active monthly
subscription period and recorded with `cost_source = 'subscription_covered'`.
The cost columns still hold the PAYG list-price equivalent. Mirrors Claude
Code subscription behaviour exactly.
