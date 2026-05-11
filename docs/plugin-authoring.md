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
  id: "claude-pro:2026-05",
  harnessId: "claude-code",
  planName: "claude-pro",         // writer-defined slug
  periodStart: 1746057600,        // Unix seconds
  periodEnd: 1748736000,
  fixedCost: 20.00,               // flat fee in currency units (float OK here)
  currency: "USD",
  quotaLimit: null,               // optional
  quotaUsed: null,
  quotaUnit: null,
});

// Link a covered message.
await writer.recordLlmMessage({
  ...messageFields,
  cost_source: "subscription_covered",
  subscription_id: sub.id,
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
