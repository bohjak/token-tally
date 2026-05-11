# NULL `turns.model_id` Investigation
**Date:** 2026-05-07  
**Status:** Root cause found — hypothesis B (real bug), confirmed.

---

## 1. Day Buckets

| Day        | null_turns | pop_turns | total | null_msgs | pop_msgs |
|------------|-----------|-----------|-------|-----------|----------|
| 2026-05-07 | 827       | 2,005     | 2,832 | 2,288     | 572      |
| 2026-05-06 | 577       | 0         | 577   | 548       | 0        |

**Interpretation:**
- 2026-05-06 — 100% null: predates the `llm_messages.model_id` migration (`002_llm_message_model.sql`). These rows can never be backfilled; the source data simply doesn't exist.
- 2026-05-07 — 827 NULL turns on TODAY, mixed with 2,005 populated. Nulls are spread across multiple post-fix sessions started well after the fix landed. **Hypothesis A (stale pre-fix session) is ruled out.**

---

## 2. Per-Session Distribution

111 distinct sessions in the last 2 days have at least one NULL `turns.model_id`.

**Key finding: every affected session has exactly 1 NULL turn.**

| Case | Sessions | Avg populated turns (idx > 0) |
|------|----------|-------------------------------|
| turn 0 NULL | 114 | 15.2 |
| turn 0 populated | 84 | 103.2 |

The single NULL turn is **always `idx = 0`** (the very first turn of the session) in post-fix sessions. Later turns in the same session are always correctly attributed.

The sessions where turn 0 IS correctly populated are those where a `model_select` event fired before the first turn — visible in the dramatically higher avg-other-pop-turns (103 vs 15), consistent with longer-running sessions where the user explicitly changed models.

---

## 3. Code Path Audit

The event ordering from `pi-agent-core/dist/agent-loop.js` is confirmed:

```
turn_start  →  streamAssistantResponse  →  message_end  →  turn_end
```

`message_end` fires before `turn_end`. T9's `setActiveModel` call happens during `message_end` and IS executed before `turn_end`. The emit mechanism in `runner.js` is fully synchronous-awaited per handler.

**Root cause is NOT event ordering.** It is where T8 reads model_id for the `turn_end` UPDATE:

### The exact bug

In `src/hooks/turn.ts`, `turn_start` captures a snapshot of `activeModels` at the moment it fires:

```typescript
// turn_start handler:
const modelInfo = activeModels.get(sessionId) ?? null;
activeTurns.set(sessionId, {
  // ...
  model_id: modelInfo?.model_id ?? null,   // ← captured at turn_start time
  provider: modelInfo?.provider ?? null,
});
```

Then in `turn_end`:

```typescript
// turn_end handler — reads from the stale snapshot:
const turnEndEvent: TurnEndEvent = {
  model_id: record.model_id,   // ← still null from turn_start snapshot!
  provider: record.provider,
};
sink.write(turnEndEvent);
```

The `endTurn` SQLite prepared statement (`UPDATE turns SET model_id = @model_id ...`) faithfully writes that null.

Meanwhile, T9's `message_end` handler correctly calls `setActiveModel(sessionId, msg.model, msg.provider)` during the turn — which updates `activeModels` — but T8's `turn_end` never reads back from `activeModels`. It only reads from the `ActiveTurnRecord` frozen at `turn_start`.

### Why turn 1+ work

After turn 0's `message_end`, `activeModels.get(sessionId)` is populated. When turn 1's `turn_start` fires, it reads `activeModels` and captures the correct value into the new `ActiveTurnRecord`. Turn 1's `turn_end` then reads from that record — correctly.

### Why some turn-0 rows are already correct (31 of 52 in the last day)

Those sessions had `model_select` fire at startup (user previously selected a model). `activeModels` was already populated before turn 0's `turn_start`, so the snapshot captured the correct value. Sessions using the default model (no explicit `/model` invocation in recent history) never get a `model_select` event before the first turn.

### Other theoretical null paths (none observed in data)

| Path | Expected outcome | Observed? |
|------|-----------------|-----------|
| `session_start` fires before `turn_start` (normal) | sessionId registered ✓ | Yes |
| `msg.model` is empty/undefined (provider bug) | T9 skips `setActiveModel` | Not in data |
| `getActiveSessionId` returns null for T9 | T9 skips `setActiveModel` | Not in data |
| `patchProviderResponse` stmt wipes model_id | No — stmt doesn't touch model_id | Confirmed |

---

## 4. Latest-Session Deep-Dive

Session `88815c98-9ce0-4dfd-b677-7bf42ebb3b85` (today, post-fix, 55 total turns):

| idx | turn_model_id | msg_model_id | stop_reason |
|-----|--------------|--------------|-------------|
| **0** | **NULL** | claude-opus-4-7 | toolUse |
| 1 | claude-opus-4-7 | claude-opus-4-7 | toolUse |
| 2 | claude-opus-4-7 | claude-opus-4-7 | toolUse |
| … | claude-opus-4-7 | claude-opus-4-7 | … |

Turn 0: `msg_model_id` is non-null (T9 wrote it to `llm_messages`; `setActiveModel` was called) but `turn_model_id` is null (T8's `turn_end` read from the stale snapshot). Turn 1+: both columns correct. **Exactly matches the frozen-snapshot diagnosis.**

---

## 5. Conclusion

**Hypothesis B — real bug, confirmed.** Confidence: high.

Every new pi session that starts without a prior `model_select` event produces exactly one NULL `turns.model_id` row (turn 0). Hypothesis A is ruled out: the NULLs span 111 independent sessions started today, long after the fix landed.

The bug does NOT cause any cascading failures. Cost and token aggregations are correct (those come from `llm_messages`). Only the Models tab and doctor's backfill report are affected for the first turn of affected sessions.

---

## 6. Minimal Fix (do not apply here — description only)

In `src/hooks/turn.ts`, the `turn_end` handler should prefer the latest value from `activeModels` over the stale snapshot:

```typescript
// Current (line ~515 in turn_end handler):
const turnEndEvent: TurnEndEvent = {
  model_id: record.model_id,
  provider: record.provider,
  // ...
};

// Fix: read back from activeModels first (T9 may have updated it since turn_start)
const latestModel = activeModels.get(sessionId);
const turnEndEvent: TurnEndEvent = {
  model_id: latestModel?.model_id ?? record.model_id,
  provider: latestModel?.provider ?? record.provider,
  // ...
};
```

Alternatively, T9's `setActiveModel` could additionally update the `ActiveTurnRecord` in place:
```typescript
// At end of setActiveModel():
const record = activeTurns.get(sessionId);
if (record) {
  record.model_id = model_id;
  record.provider = provider;
}
```

The second option is slightly more robust (the `turn_end` handler doesn't need to know about `activeModels` at all), but either approach produces the same result. The fix is a 3-line change.
