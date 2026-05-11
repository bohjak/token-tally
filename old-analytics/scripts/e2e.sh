#!/usr/bin/env bash
# =============================================================================
# Hermetic E2E smoke test for the pi analytics extension.
#
# What it does:
#   1. Creates a temp git repo + fake HOME directory.
#   2. Symlinks the extension into the fake HOME.
#   3. Runs pi with a single prompt and verifies that analytics rows are created.
#   4. Validates /usage --json output shape.
#   5. Runs /analytics doctor via the standalone scripts/doctor.mjs CLI.
#
# Required environment:
#   PI_E2E_MODEL   — model string passed to pi, e.g.
#                    "anthropic/claude-3-5-haiku-latest"
#   Matching API key env var must also be set (ANTHROPIC_API_KEY, etc.)
#
# Optional:
#   PI_BIN         — path to the pi binary (default: "pi" on $PATH)
#   SQLITE3_BIN    — path to sqlite3 (default: "sqlite3" on $PATH)
#
# Usage:
#   PI_E2E_MODEL=anthropic/claude-3-5-haiku-latest bash scripts/e2e.sh
#
# Exit codes:
#   0  all assertions passed
#   1  an assertion failed or a required tool is missing
#
# Runtime: typically <30 s on a modern laptop with a Haiku-class model.
# =============================================================================
set -euo pipefail

PI_BIN="${PI_BIN:-pi}"
SQLITE3_BIN="${SQLITE3_BIN:-sqlite3}"

# ── Precondition checks ───────────────────────────────────────────────────────

if ! command -v "$PI_BIN" &>/dev/null; then
  echo "[e2e] ERROR: pi binary not found (PI_BIN=${PI_BIN})" >&2
  exit 1
fi

if ! command -v "$SQLITE3_BIN" &>/dev/null; then
  echo "[e2e] ERROR: sqlite3 not found (SQLITE3_BIN=${SQLITE3_BIN})" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "[e2e] ERROR: jq not found — required for JSON assertions" >&2
  exit 1
fi

: "${PI_E2E_MODEL:?PI_E2E_MODEL must be set (e.g. anthropic/claude-3-5-haiku-latest)}"

# ── Setup ─────────────────────────────────────────────────────────────────────

TMP=$(mktemp -d)
HOME_FAKE=$(mktemp -d)
trap 'echo "[e2e] cleaning up..."; rm -rf "$TMP" "$HOME_FAKE"' EXIT

echo "[e2e] tmp dir:      $TMP"
echo "[e2e] fake home:    $HOME_FAKE"
echo "[e2e] model:        $PI_E2E_MODEL"

# Resolve the extension directory BEFORE we cd elsewhere.  BASH_SOURCE[0] may
# be a relative path ("scripts/e2e.sh") so we have to dereference it while
# the working directory is still the user's invocation directory.
EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Create a minimal git repo so analytics can capture git context.
cd "$TMP"
git init -q
git -c user.email="t@t" -c user.name="t" commit --allow-empty -m "init" -q
echo "[e2e] git repo initialised at $TMP"

# Symlink the extension into the fake home so pi auto-discovers it.
mkdir -p "$HOME_FAKE/.pi/agent/extensions"
ln -s "$EXT_DIR" "$HOME_FAKE/.pi/agent/extensions/analytics"
echo "[e2e] extension symlinked: $EXT_DIR -> $HOME_FAKE/.pi/agent/extensions/analytics"

# Inherit credentials from the real home so the test doesn't require manual
# API-key env setup.  Everything else (models.json, settings.json, sessions,
# events.db) stays hermetic so we measure the extension in isolation.
#
# Subtlety: pi-ai provider modules (anthropic, openai, google, ...) read the
# API key via `options.apiKey || getEnvApiKey()`.  In `pi -p` mode the
# auth-storage `!command` resolver is bypassed for some providers, so we
# also resolve the key locally and export the canonical env var.
if [[ -f "${HOME}/.pi/agent/auth.json" ]]; then
  cp "${HOME}/.pi/agent/auth.json" "$HOME_FAKE/.pi/agent/auth.json"
  echo "[e2e] auth.json copied from real \$HOME"

  # Best-effort: extract provider from PI_E2E_MODEL ("anthropic/claude-haiku-4-5" -> "anthropic")
  # and export the matching env var if a !command resolver is configured.
  PROVIDER="${PI_E2E_MODEL%%/*}"
  KEY_CMD=$(jq -r --arg p "$PROVIDER" '.[$p].key // empty' "$HOME_FAKE/.pi/agent/auth.json")
  if [[ "$KEY_CMD" == "!"* ]]; then
    RESOLVED=$(/bin/bash -c "${KEY_CMD#!}" 2>/dev/null || true)
    if [[ -n "$RESOLVED" ]]; then
      case "$PROVIDER" in
        anthropic) export ANTHROPIC_API_KEY="$RESOLVED" ;;
        openai)    export OPENAI_API_KEY="$RESOLVED" ;;
        google)    export GOOGLE_GENERATIVE_AI_API_KEY="$RESOLVED" ;;
        *)         echo "[e2e] WARN: don't know which env var to set for provider '$PROVIDER'" ;;
      esac
      echo "[e2e] resolved $PROVIDER api key from auth.json (\${${PROVIDER^^}_API_KEY:0:8}\u2026)"
    fi
  fi
else
  echo "[e2e] WARN: \$HOME/.pi/agent/auth.json not found \u2014 pi will need API key env vars"
fi

DB="$HOME_FAKE/.pi/analytics/events.db"

# ── Pre-flight: ensure better-sqlite3 is compiled for the current Node ABI ─────
# better-sqlite3 is a native addon.  If npm install was run under a different
# Node version than the one on $PATH, doctor.mjs will crash with
# ERR_DLOPEN_FAILED.  Rebuilding is fast (<10 s) and idempotent.
echo "[e2e] rebuilding better-sqlite3 for $(node --version)..."
(cd "$EXT_DIR" && npm rebuild better-sqlite3 --silent) || {
  echo "[e2e] ERROR: npm rebuild better-sqlite3 failed" >&2
  exit 1
}
echo "[e2e] better-sqlite3 rebuild OK"

# ── Step 1: run pi with a single prompt ───────────────────────────────────────

echo "[e2e] step 1: running pi prompt..."
HOME="$HOME_FAKE" "$PI_BIN" -p "List files in this directory" --model "$PI_E2E_MODEL"

# ── Step 2: assert DB was created ─────────────────────────────────────────────

echo "[e2e] step 2: checking DB exists..."
if [[ ! -f "$DB" ]]; then
  echo "[e2e] FAIL: events.db not created at $DB" >&2
  exit 1
fi
echo "[e2e] DB found: $DB"

# ── Step 3: row count assertions ──────────────────────────────────────────────

echo "[e2e] step 3: asserting row counts..."
counts=$("$SQLITE3_BIN" "$DB" \
  "SELECT
     (SELECT count(*) FROM sessions),
     (SELECT count(*) FROM prompts),
     (SELECT count(*) FROM turns),
     (SELECT count(*) FROM llm_messages),
     (SELECT count(*) FROM tool_calls);")
echo "[e2e] counts (sessions|prompts|turns|llm_messages|tool_calls) = $counts"

echo "$counts" | awk -F'|' '{
  ok = 1
  if ($1 < 1) { print "FAIL: sessions < 1"; ok = 0 }
  if ($2 < 1) { print "FAIL: prompts < 1";  ok = 0 }
  if ($3 < 1) { print "FAIL: turns < 1";    ok = 0 }
  if ($4 < 1) { print "FAIL: llm_messages < 1";  ok = 0 }
  if ($5 < 1) { print "FAIL: tool_calls < 1";    ok = 0 }
  if (ok) print "OK: all row counts >= 1"
  exit (ok ? 0 : 1)
}'

# ── Step 4: /usage --json shape ───────────────────────────────────────────────

echo "[e2e] step 4: checking /usage --json output shape..."
HOME="$HOME_FAKE" "$PI_BIN" -p "/usage --json" --model "$PI_E2E_MODEL" \
  | jq -e '.today and .week and .month and .session and (.today.cost_usd | type == "number")' >/dev/null
echo "[e2e] /usage --json shape OK"

# ── Step 5: analytics doctor via standalone CLI ───────────────────────────────

echo "[e2e] step 5: running analytics doctor..."
DOCTOR_MJS="$EXT_DIR/scripts/doctor.mjs"
if [[ -f "$DOCTOR_MJS" ]]; then
  HOME="$HOME_FAKE" node "$DOCTOR_MJS" \
    --db "$DB" \
    --raw-log-dir "$HOME_FAKE/.pi/analytics/raw"
  echo "[e2e] doctor OK"
else
  echo "[e2e] WARN: scripts/doctor.mjs not found — skipping doctor step"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo "[e2e] PASS"
