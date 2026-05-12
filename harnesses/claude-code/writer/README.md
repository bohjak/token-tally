# Claude Code writer — ToTally

This package implements the ToTally writer for Claude Code. It is installed as a
Claude Code hook command and writes sessions, turns, LLM messages, and tool
calls to the central ToTally store.

## Architecture

Claude Code executes hooks as short-lived commands and sends a JSON payload on
stdin. The compiled command is:

```text
dist/bin/token-tally-claude-hook.js
```

`make install` symlinks it to:

```text
~/.local/bin/token-tally-claude-hook
```

The command reads the hook payload, opens `@token-tally/store`, dispatches to
the matching handler, and always exits 0 so a writer failure cannot block a
Claude Code tool call.

## Hook events

The installer registers hooks for:

- `SessionStart`
- `SessionEnd`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `SubagentStop`

`Notification` and `PreCompact` are intentionally ignored.

## Transcript draining

Claude Code hook payloads do not include token usage. Every payload includes a
`transcript_path`, so the writer incrementally reads the JSONL transcript and
records assistant entries that contain `message.usage`.

The transcript reader is defensive: malformed lines are skipped, unknown shapes
are ignored, and idempotency is enforced by the store via the
`(harness_id, harness_message_id)` unique key.

## State files

Because each hook runs in a new process, cross-hook state lives in:

```text
~/.local/state/token-tally/claude-code/<session_id>.json
```

State files contain only bookkeeping:

- ToTally session ID
- current turn ID and turn index
- transcript offset
- active tool IDs and start times
- optional subscription ID

They never contain prompts, assistant text, tool inputs, tool outputs, file
contents, environment variables, or secrets. It is safe to delete the state
directory; the writer will recreate state as needed.

## Subscription mode

Claude Pro/Max accounting is opt-in. Add this to
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

When configured, ToTally records a monthly subscription period and marks
computed message costs as `subscription_covered`. The stored cost is still the
PAYG list-price equivalent.

## Manual hook installation

If the installer cannot edit `~/.claude/settings.json`, use
`settings.template.json` as a reference and merge its `hooks` entries into your
existing settings file. Do not replace your full settings file unless it only
contains ToTally hooks.

Make sure `token-tally-claude-hook` is on Claude Code's PATH. The installer uses
`~/.local/bin`; if that directory is not on PATH, either add it or use an
absolute command path in the settings entry.

## Development

```sh
pnpm --filter @token-tally/claude-code-writer build
pnpm --filter @token-tally/claude-code-writer test
```

The integration test runs the compiled hook command against fixture payloads and
a temporary ToTally database, then verifies idempotent replay.
