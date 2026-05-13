# Cursor writer — ToTally

This package implements the ToTally writer for Cursor. It is installed as a
Cursor hook command and writes sessions, turns, LLM messages, and tool calls
to the central ToTally store.

## Architecture

Cursor executes hooks as short-lived commands and sends a JSON payload on
stdin. The compiled command is:

```text
dist/bin/token-tally-cursor-hook.js
```

`make install` symlinks it to:

```text
~/.local/bin/token-tally-cursor-hook
```

The command reads the hook payload, opens `@token-tally/store`, dispatches to
the matching handler, and always exits 0 so a writer failure cannot block a
Cursor tool call.

## Hook events

The installer registers hooks for 10 events in `~/.cursor/hooks.json` using
the **Cursor-native flat format** (lower-camel names, `{ "command": "..." }`
entries):

- `sessionStart` / `sessionEnd`
- `beforeSubmitPrompt`
- `afterAgentResponse`
- `preToolUse` / `postToolUse` / `postToolUseFailure`
- `stop` / `subagentStop`
- `preCompact`

The `hooks.template.json` file shows the exact block the installer merges.

## Token counts and cost — best-effort only

Cursor hook payloads do **not** include token counts. This writer captures
every session, turn, message, and tool call reliably, but token counts and
costs are best-effort:

- On `stop` / `sessionEnd`, the writer attempts to read token data from the
  hook-provided `transcript_path` (when present and readable).
- As a fallback, it inspects Cursor's private `state.vscdb` (read-only).
- If neither source yields token data, messages are stored with
  `cost_source = 'unknown'` and zero-cost columns. This is valid schema state
  and correctly excluded from headline cost totals by all readers.

Only `preCompact` payloads carry `context_tokens` / `context_window_size`;
those are emitted as minimal `raw_events` only when `captureRaw` is enabled
in config.

## State files

Because each hook runs in a new process, cross-hook state lives in:

```text
~/.local/state/token-tally/cursor/<harness_session_id>.json
```

State files contain only bookkeeping (session/turn/message counters, active
tool IDs). They never contain prompts, responses, or secrets. Safe to delete.

## Subscription mode

Cursor Pro accounting is opt-in. Add this to
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

When configured, ToTally records a monthly subscription period and marks
computed message costs as `subscription_covered`. The stored cost is still the
PAYG list-price equivalent.

## Manual hook installation

If the installer cannot edit `~/.cursor/hooks.json`, use `hooks.template.json`
as a reference and merge its `hooks` entries into your existing file. The
format is Cursor-native (lower-camel event names, flat `{ "command": "..." }`
entries) — do **not** use the nested Claude Code format.

Make sure `token-tally-cursor-hook` is on Cursor's PATH. The installer uses
`~/.local/bin`; if that directory is not on PATH, use an absolute command path
in the hooks entry.

## Development

```sh
pnpm --filter @token-tally/cursor-writer build
pnpm --filter @token-tally/cursor-writer test
```
