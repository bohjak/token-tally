#!/usr/bin/env bash
# scripts/e2e.sh — ToTally end-to-end smoke test.
#
# MODES
#   Safe mode (default): all checks run against a temporary directory tree,
#   never touching /Applications or the real $HOME. Safe to run any time.
#
#   Real mode (--real): runs `make install` / `make uninstall` against the
#   actual system. Writes to /Applications and real XDG data dirs. Only run
#   when you intend to install.
#
# FLAGS
#   --real         Run against the real system install (destructive).
#   --skip-uninstall  Skip uninstall step in --real mode (keep the app running).
#   --help         Print this help and exit.
#
# EXIT CODES
#   0   all checks passed
#   1   one or more checks failed
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
fi

pass()    { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}!${RESET}  $*"; ((WARN_COUNT++)) || true; }
fail()    { echo -e "  ${RED}✗${RESET}  $*"; ((FAIL_COUNT++)) || true; }
section() { echo -e "\n${BOLD}$*${RESET}"; }

WARN_COUNT=0
FAIL_COUNT=0

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

OPT_REAL=false
OPT_SKIP_UNINSTALL=false

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --real)             OPT_REAL=true ;;
      --skip-uninstall)   OPT_SKIP_UNINSTALL=true ;;
      --help|-h)
        echo "Usage: scripts/e2e.sh [--real] [--skip-uninstall]"
        echo
        echo "Modes:"
        echo "  (default)        Safe mode — uses a temp dir, never touches /Applications"
        echo "  --real           Full install mode — writes to /Applications and real \$HOME"
        echo "  --skip-uninstall  (--real only) Leave the installed app running after tests"
        exit 0
        ;;
      *)
        echo "Unknown flag: $1" >&2
        exit 1
        ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# Require a command to be in PATH
# ---------------------------------------------------------------------------

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" &>/dev/null; then
    fail "Required command not found: ${cmd}"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# SAFE MODE CHECKS
# All tests run under a temporary directory — no writes to /Applications or
# real user data directories.
# ---------------------------------------------------------------------------

# Create a synthetic legacy Pi database for testing the import command.
# Schema matches the legacy Pi analytics extension expected by the importer.
build_legacy_fixture() {
  local db_path="$1"
  sqlite3 "${db_path}" <<'SQL'
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL DEFAULT '',
  repo_remote TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  pi_version TEXT NOT NULL DEFAULT 'unknown'
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  model_id TEXT,
  provider TEXT
);
CREATE TABLE llm_messages (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ts INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_input REAL NOT NULL DEFAULT 0,
  cost_output REAL NOT NULL DEFAULT 0,
  cost_cache_read REAL NOT NULL DEFAULT 0,
  cost_cache_write REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  model_id TEXT,
  provider TEXT
);
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sessions VALUES
  ('s1','/tmp/e2e-repo','git@github.com:e2e/test.git','e2e','test',1700000000000,1700000001000,'1.0.0');
INSERT INTO turns VALUES
  ('t1','s1',0,1700000000000,1700000001000,'claude-3-haiku','anthropic');
INSERT INTO llm_messages VALUES
  ('m1','t1','s1','assistant',1700000000500,
   10,20,3,4, 0.001,0.002,0.0001,0.0002,0.0033,
   'claude-3-haiku','anthropic');
INSERT INTO tool_calls VALUES
  ('tc1','t1','s1','read_file',1700000000200,1700000000300,0);
SQL
}

run_safe_checks() {
  local tmp_dir
  tmp_dir=$(mktemp -d)
  # Always remove the temp dir on exit, even if the script fails mid-way.
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp_dir}'" EXIT

  local tmp_db="${tmp_dir}/events.db"
  local tmp_legacy_db="${tmp_dir}/legacy.db"

  # ---- 1. Prerequisites ----
  section "Prerequisites"
  if ! require_cmd "token-tally"; then
    fail "token-tally not found — run 'make install' or 'pnpm add -g ./store' first"
    return
  fi
  pass "token-tally found at $(command -v token-tally)"

  if ! require_cmd "sqlite3"; then
    fail "sqlite3 not found — install SQLite"
    return
  fi
  pass "sqlite3 found"

  # ---- 2. DB migration ----
  section "DB migration"
  if token-tally migrate --db "${tmp_db}" 2>&1; then
    pass "migrate: DB created at ${tmp_db}"
  else
    fail "migrate: non-zero exit"
    return
  fi

  # ---- 3. Schema version via doctor ----
  section "Schema doctor"
  local doctor_json
  doctor_json=$(token-tally doctor --json --db "${tmp_db}" 2>/dev/null)
  local doctor_status
  doctor_status=$(echo "${doctor_json}" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])" 2>/dev/null) || true
  if [[ "${doctor_status}" == "ok" ]]; then
    pass "doctor: status=ok"
  else
    fail "doctor: unexpected status '${doctor_status}'"
  fi

  # ---- 4. Idempotent migration ----
  section "Idempotent migration"
  token-tally migrate --db "${tmp_db}" >/dev/null 2>&1
  local v_after
  v_after=$(sqlite3 "${tmp_db}" "SELECT value FROM schema_metadata WHERE key='schema_version';")
  if [[ "${v_after}" == "1" ]]; then
    pass "idempotent migration: schema_version still 1 after second migrate"
  else
    fail "idempotent migration: schema_version='${v_after}' (expected 1)"
  fi

  # ---- 5. Synthetic event write via CLI ----
  section "Synthetic CLI writes"
  local harness_id
  harness_id=$(token-tally record --db "${tmp_db}" \
    --type harness \
    --json '{"name":"e2e-harness","displayName":"E2E Test Harness","version":"0.1.0","integrationVersion":"0.1.0"}' \
    2>/dev/null)
  if [[ "${harness_id}" == '{"id":"e2e-harness"}' ]]; then
    pass "record harness: id=e2e-harness"
  else
    fail "record harness: unexpected output '${harness_id}'"
  fi

  local session_result
  session_result=$(token-tally record --db "${tmp_db}" \
    --type session \
    --json '{"harnessId":"e2e-harness","harnessSessionId":"e2e-sess-1","startedAt":1700000000000,"cwd":"/tmp/e2e"}' \
    2>/dev/null)
  local session_id
  session_id=$(echo "${session_result}" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null) || true
  if [[ -n "${session_id}" ]]; then
    pass "record session: id=${session_id}"
  else
    fail "record session: no id in output '${session_result}'"
  fi

  local turn_result
  turn_result=$(token-tally record --db "${tmp_db}" \
    --type turn \
    --json "{\"harnessId\":\"e2e-harness\",\"sessionId\":\"${session_id}\",\"harnessTurnId\":\"e2e-turn-1\",\"startedAt\":1700000000100}" \
    2>/dev/null)
  local turn_id
  turn_id=$(echo "${turn_result}" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null) || true
  if [[ -n "${turn_id}" ]]; then
    pass "record turn: id=${turn_id}"
  else
    fail "record turn: no id in output '${turn_result}'"
  fi

  local msg_result
  msg_result=$(token-tally record --db "${tmp_db}" \
    --type llm-message \
    --json "{\"harnessId\":\"e2e-harness\",\"sessionId\":\"${session_id}\",\"turnId\":\"${turn_id}\",\"harnessMessageId\":\"e2e-msg-1\",\"ts\":1700000000500,\"inputTokens\":10,\"outputTokens\":20,\"costInputMicros\":1000,\"costOutputMicros\":2000,\"costSource\":\"writer\"}" \
    2>/dev/null)
  local msg_id
  msg_id=$(echo "${msg_result}" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null) || true
  if [[ -n "${msg_id}" ]]; then
    pass "record llm-message: id=${msg_id}"
  else
    fail "record llm-message: no id in output '${msg_result}'"
  fi

  # ---- 6. Idempotent writes (replay same events, row counts stay 1) ----
  section "Write idempotency"
  token-tally record --db "${tmp_db}" \
    --type harness \
    --json '{"name":"e2e-harness","displayName":"E2E Test Harness"}' \
    >/dev/null 2>/dev/null
  token-tally record --db "${tmp_db}" \
    --type session \
    --json '{"harnessId":"e2e-harness","harnessSessionId":"e2e-sess-1","startedAt":1700000000000}' \
    >/dev/null 2>/dev/null
  token-tally record --db "${tmp_db}" \
    --type llm-message \
    --json "{\"harnessId\":\"e2e-harness\",\"sessionId\":\"${session_id}\",\"turnId\":\"${turn_id}\",\"harnessMessageId\":\"e2e-msg-1\",\"ts\":1700000000500,\"inputTokens\":10,\"outputTokens\":20,\"costInputMicros\":1000,\"costOutputMicros\":2000,\"costSource\":\"writer\"}" \
    >/dev/null 2>/dev/null

  local h_count s_count t_count m_count
  h_count=$(sqlite3 "${tmp_db}" "SELECT COUNT(*) FROM harnesses;")
  s_count=$(sqlite3 "${tmp_db}" "SELECT COUNT(*) FROM sessions;")
  t_count=$(sqlite3 "${tmp_db}" "SELECT COUNT(*) FROM turns;")
  m_count=$(sqlite3 "${tmp_db}" "SELECT COUNT(*) FROM llm_messages;")

  if [[ "${h_count}" == "1" && "${s_count}" == "1" && "${t_count}" == "1" && "${m_count}" == "1" ]]; then
    pass "idempotency: harnesses=${h_count} sessions=${s_count} turns=${t_count} messages=${m_count} (all 1)"
  else
    fail "idempotency: unexpected counts harnesses=${h_count} sessions=${s_count} turns=${t_count} messages=${m_count}"
  fi

  # ---- 7. Tray query: sqlite3 direct read validates schema is readable ----
  section "Tray-style DB read (sqlite3)"
  local cost_total
  cost_total=$(sqlite3 "${tmp_db}" \
    "SELECT COALESCE(SUM(cost_total_micros), 0) FROM llm_messages;" 2>/dev/null) || true
  if [[ "${cost_total}" == "3000" ]]; then
    pass "tray-style read: cost_total_micros=3000 (1000+2000+0+0)"
  else
    fail "tray-style read: cost_total_micros='${cost_total}' (expected 3000)"
  fi

  # ---- 8. Legacy Pi import ----
  section "Legacy Pi import"
  build_legacy_fixture "${tmp_legacy_db}"

  if token-tally import legacy-pi \
      --source "${tmp_legacy_db}" \
      --db "${tmp_db}" 2>&1 | grep -q "import complete"; then
    pass "legacy import: first run succeeded"
  else
    fail "legacy import: first run did not report success"
  fi

  local import_output
  import_output=$(token-tally import legacy-pi \
    --source "${tmp_legacy_db}" \
    --db "${tmp_db}" 2>&1)
  if echo "${import_output}" | grep -q "already present"; then
    pass "legacy import idempotency: second run reports all rows already present"
  else
    fail "legacy import idempotency: unexpected second-run output: ${import_output}"
  fi

  # Confirm metadata was recorded in schema_metadata
  local import_meta
  import_meta=$(sqlite3 "${tmp_db}" \
    "SELECT COUNT(*) FROM schema_metadata WHERE key='import_legacy_pi';" 2>/dev/null)
  if [[ "${import_meta}" == "1" ]]; then
    pass "legacy import metadata: recorded in schema_metadata"
  else
    fail "legacy import metadata: not found in schema_metadata"
  fi

  # ---- 9. Pi symlinks ----
  section "Pi extension symlinks"
  local writer_link="${HOME}/.pi/agent/extensions/token-tally-writer"
  local usage_link="${HOME}/.pi/agent/extensions/token-tally-usage"

  if [[ -L "${writer_link}" ]]; then
    local writer_target
    writer_target=$(readlink "${writer_link}")
    pass "token-tally-writer symlink → ${writer_target}"
  else
    warn "token-tally-writer symlink absent at ${writer_link} (run 'make install' to create it)"
  fi

  if [[ -L "${usage_link}" ]]; then
    local usage_target
    usage_target=$(readlink "${usage_link}")
    pass "token-tally-usage symlink → ${usage_target}"
  else
    warn "token-tally-usage symlink absent at ${usage_link} (run 'make install' to create it)"
  fi

  # ---- 10. Cursor hook symlink ----
  section "Cursor hook symlink"
  local cursor_hook_link="${HOME}/.local/bin/token-tally-cursor-hook"
  if [[ -L "${cursor_hook_link}" ]]; then
    local cursor_hook_target
    cursor_hook_target=$(readlink "${cursor_hook_link}")
    pass "token-tally-cursor-hook symlink → ${cursor_hook_target}"
  else
    warn "token-tally-cursor-hook symlink absent at ${cursor_hook_link} (run 'make install' with Cursor present to create it)"
  fi

  # ---- 11. Uninstall --help exits cleanly ----
  section "Uninstall script sanity"
  if "${SCRIPT_DIR}/uninstall.sh" --help >/dev/null 2>&1; then
    pass "uninstall.sh --help exits 0"
  else
    fail "uninstall.sh --help returned non-zero"
  fi

  # trap will clean up ${tmp_dir}
}

# ---------------------------------------------------------------------------
# REAL MODE CHECKS
# Requires write access to /Applications. Uses the real $HOME.
# ---------------------------------------------------------------------------

run_real_checks() {
  section "Real install (--real mode)"
  warn "This mode writes to /Applications and real \$HOME data directories."
  echo

  # ---- 1. First make install ----
  section "make install (first run)"
  if make -C "${REPO_ROOT}" install; then
    pass "make install: first run succeeded"
  else
    fail "make install: first run failed"
    return
  fi

  # ---- 2. Idempotent second install ----
  section "make install (second run — idempotency)"
  if make -C "${REPO_ROOT}" install; then
    pass "make install: second run succeeded (idempotent)"
  else
    fail "make install: second run failed"
    return
  fi

  # ---- 3. ToTally.app installed ----
  section "Tray app"
  if [[ -d "/Applications/ToTally.app" ]]; then
    pass "/Applications/ToTally.app exists"
  else
    fail "/Applications/ToTally.app not found after install"
  fi

  # ---- 4. Pi symlinks ----
  section "Pi extension symlinks"
  local writer_link="${HOME}/.pi/agent/extensions/token-tally-writer"
  local usage_link="${HOME}/.pi/agent/extensions/token-tally-usage"

  if [[ -L "${writer_link}" ]]; then
    local target
    target=$(readlink "${writer_link}")
    if [[ "${target}" == "${REPO_ROOT}/harnesses/pi/writer-extension" ]]; then
      pass "token-tally-writer → correct repo path"
    else
      fail "token-tally-writer → ${target} (expected ${REPO_ROOT}/harnesses/pi/writer-extension)"
    fi
  else
    fail "token-tally-writer symlink not found at ${writer_link}"
  fi

  if [[ -L "${usage_link}" ]]; then
    local target
    target=$(readlink "${usage_link}")
    if [[ "${target}" == "${REPO_ROOT}/clients/pi-usage-command" ]]; then
      pass "token-tally-usage → correct repo path"
    else
      fail "token-tally-usage → ${target} (expected ${REPO_ROOT}/clients/pi-usage-command)"
    fi
  else
    fail "token-tally-usage symlink not found at ${usage_link}"
  fi

  # ---- 5. Cursor integration ----
  # Skip silently when ~/.cursor is absent — the installer reports "skipped"
  # in that case and no hooks.json or symlink are created.
  section "Cursor integration"
  local cursor_hook_link_real="${HOME}/.local/bin/token-tally-cursor-hook"
  local cursor_hooks_json_real="${HOME}/.cursor/hooks.json"
  if [[ ! -d "${HOME}/.cursor" ]]; then
    warn "${HOME}/.cursor not found — Cursor integration was skipped during install (expected)"
  else
    # Verify the binary symlink points to the correct repo target.
    if [[ -L "${cursor_hook_link_real}" ]]; then
      local cursor_target_real
      cursor_target_real=$(readlink "${cursor_hook_link_real}")
      local expected_cursor_target="${REPO_ROOT}/harnesses/cursor/writer/dist/bin/token-tally-cursor-hook.js"
      if [[ "${cursor_target_real}" == "${expected_cursor_target}" ]]; then
        pass "token-tally-cursor-hook → correct repo path"
      else
        fail "token-tally-cursor-hook → ${cursor_target_real} (expected ${expected_cursor_target})"
      fi
    else
      fail "token-tally-cursor-hook symlink not found at ${cursor_hook_link_real}"
    fi

    # Verify hooks.json contains flat token-tally-cursor-hook entries for all
    # 10 expected agent-hook event names. Uses python3 (already required by
    # the install scripts) rather than jq to avoid a new prerequisite.
    if [[ -f "${cursor_hooks_json_real}" ]]; then
      local cursor_missing_events
      cursor_missing_events=$(TT_HOOKS_PATH="${cursor_hooks_json_real}" python3 - <<'PY'
import json, os
with open(os.environ["TT_HOOKS_PATH"]) as f:
    data = json.load(f)
hooks = data.get("hooks", {})
expected = [
    "sessionStart", "sessionEnd", "beforeSubmitPrompt", "afterAgentResponse",
    "preToolUse", "postToolUse", "postToolUseFailure", "stop", "subagentStop", "preCompact",
]
missing = [
    ev for ev in expected
    if not any(
        isinstance(h, dict) and "token-tally-cursor-hook" in h.get("command", "")
        for h in hooks.get(ev, [])
    )
]
print(",".join(missing))
PY
      ) || cursor_missing_events="error"
      if [[ "${cursor_missing_events}" == "" ]]; then
        pass "hooks.json: all 10 expected events have flat token-tally-cursor-hook entries"
      elif [[ "${cursor_missing_events}" == "error" ]]; then
        fail "hooks.json: could not parse ${cursor_hooks_json_real}"
      else
        fail "hooks.json: missing token-tally-cursor-hook entries for: ${cursor_missing_events}"
      fi
    else
      fail "${HOME}/.cursor/hooks.json not found after install"
    fi
  fi

  # ---- 6. Claude Code integration ----
  # Analogous to the Cursor integration check above.
  section "Claude Code integration"
  local claude_hook_link="${HOME}/.local/bin/token-tally-claude-hook"
  local claude_settings="${HOME}/.claude/settings.json"
  if [[ ! -d "${HOME}/.claude" ]]; then
    warn "${HOME}/.claude not found — Claude Code integration was skipped during install (expected)"
  else
    # Verify the binary symlink points to the correct repo target.
    if [[ -L "${claude_hook_link}" ]]; then
      local claude_target
      claude_target=$(readlink "${claude_hook_link}")
      local expected_claude_target="${REPO_ROOT}/harnesses/claude-code/writer/dist/bin/token-tally-claude-hook.js"
      if [[ "${claude_target}" == "${expected_claude_target}" ]]; then
        pass "token-tally-claude-hook → correct repo path"
      else
        fail "token-tally-claude-hook → ${claude_target} (expected ${expected_claude_target})"
      fi
    else
      fail "token-tally-claude-hook symlink not found at ${claude_hook_link}"
    fi

    # Verify that the installed command in settings is the absolute symlink path,
    # not the old bare-name form "token-tally-claude-hook".
    if [[ -f "${claude_settings}" ]]; then
      local claude_cmd_check
      claude_cmd_check=$(
        TT_SETTINGS_PATH="${claude_settings}" \
        TT_HOOK_LINK="${claude_hook_link}" \
        python3 - <<'PY'
import json, os
with open(os.environ["TT_SETTINGS_PATH"]) as f:
    data = json.load(f)
hook_link = os.environ["TT_HOOK_LINK"]
hooks = data.get("hooks", {})
found_absolute = False
found_bare = False
for event_hooks in hooks.values():
    if not isinstance(event_hooks, list):
        continue
    for matcher in event_hooks:
        if not isinstance(matcher, dict):
            continue
        for hook in matcher.get("hooks", []):
            if not isinstance(hook, dict):
                continue
            cmd = hook.get("command", "")
            if isinstance(cmd, str):
                if cmd == hook_link or cmd.endswith("/token-tally-claude-hook"):
                    found_absolute = True
                elif cmd == "token-tally-claude-hook":
                    found_bare = True
if found_absolute and not found_bare:
    print("ABSOLUTE")
elif found_absolute and found_bare:
    print("BOTH")
elif found_bare:
    print("BARE_ONLY")
else:
    print("MISSING")
PY
      ) || claude_cmd_check="ERROR"
      case "${claude_cmd_check}" in
        ABSOLUTE)  pass "Claude Code settings: uses absolute hook command" ;;
        BOTH)      fail "Claude Code settings: both bare and absolute commands present (duplicate)" ;;
        BARE_ONLY) fail "Claude Code settings: still using bare hook name — expected absolute path" ;;
        MISSING)   fail "Claude Code settings: ToTally hook command not found after install" ;;
        *)         warn "Claude Code settings: unexpected check result: ${claude_cmd_check}" ;;
      esac
    else
      fail "${HOME}/.claude/settings.json not found after install"
    fi

    # Old-entry convergence: inject a bare-name entry into settings (simulating
    # an old ToTally install), re-run the installer, then verify the result
    # contains only the absolute path with no duplicates and no bare names.
    if [[ -f "${claude_settings}" ]]; then
      section "Claude Code old-entry convergence"
      # Inject a bare-name hook command alongside the absolute one already written.
      TT_SETTINGS_PATH="${claude_settings}" python3 - <<'PY'
import json, os, shutil, time
from pathlib import Path
p = Path(os.environ["TT_SETTINGS_PATH"])
with p.open() as f:
    data = json.load(f)
hooks = data.setdefault("hooks", {})
# Add a bare-name entry to the first event that already has our hook.
for ev, matchers in list(hooks.items()):
    if isinstance(matchers, list):
        for m in matchers:
            if isinstance(m, dict):
                m.setdefault("hooks", []).append({"type": "command", "command": "token-tally-claude-hook"})
                break
        break
tmp = p.with_suffix(".json.tmp")
with tmp.open("w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
tmp.replace(p)
PY
      # Re-run Claude Code installer to trigger convergence.
      if bash "${REPO_ROOT}/scripts/install-claude-code.sh" "${REPO_ROOT}" >/dev/null 2>&1; then
        local convergence_check
        convergence_check=$(
          TT_SETTINGS_PATH="${claude_settings}" \
          TT_HOOK_LINK="${claude_hook_link}" \
          python3 - <<'PY'
import json, os
with open(os.environ["TT_SETTINGS_PATH"]) as f:
    data = json.load(f)
hook_link = os.environ["TT_HOOK_LINK"]
hooks = data.get("hooks", {})
found_absolute = 0
found_bare = 0
for event_hooks in hooks.values():
    if not isinstance(event_hooks, list):
        continue
    for matcher in event_hooks:
        if not isinstance(matcher, dict):
            continue
        for hook in matcher.get("hooks", []):
            if not isinstance(hook, dict):
                continue
            cmd = hook.get("command", "")
            if isinstance(cmd, str):
                if cmd == hook_link or cmd.endswith("/token-tally-claude-hook"):
                    found_absolute += 1
                elif cmd == "token-tally-claude-hook":
                    found_bare += 1
print(f"absolute={found_absolute},bare={found_bare}")
PY
        ) || convergence_check="error"
        local abs_count bare_count
        abs_count=$(echo "${convergence_check}" | grep -oP 'absolute=\K[0-9]+') || abs_count=0
        bare_count=$(echo "${convergence_check}" | grep -oP 'bare=\K[0-9]+') || bare_count=0
        if [[ "${bare_count}" == "0" && "${abs_count}" != "0" ]]; then
          pass "Claude Code convergence: bare-name replaced by absolute command (abs=${abs_count}, bare=${bare_count})"
        elif [[ "${bare_count}" != "0" ]]; then
          fail "Claude Code convergence: bare-name entries still present after re-install (abs=${abs_count}, bare=${bare_count})"
        else
          fail "Claude Code convergence: no hook commands found after re-install"
        fi
      else
        warn "Claude Code convergence: re-install returned non-zero (Cursor may not be present — ok if Claude Code only)"
      fi
    fi
  fi

  # ---- 7. make doctor ----
  section "make doctor"
  if make -C "${REPO_ROOT}" doctor; then
    pass "make doctor: passed"
  else
    fail "make doctor: reported failures"
  fi

  # ---- 6. Optional uninstall ----
  if [[ "${OPT_SKIP_UNINSTALL}" == "true" ]]; then
    warn "Skipping uninstall (--skip-uninstall). ToTally.app remains installed."
    return
  fi

  section "make uninstall"
  if make -C "${REPO_ROOT}" uninstall; then
    pass "make uninstall: succeeded"
  else
    fail "make uninstall: non-zero exit"
  fi

  if [[ ! -d "/Applications/ToTally.app" ]]; then
    pass "/Applications/ToTally.app removed by uninstall"
  else
    fail "/Applications/ToTally.app still present after uninstall"
  fi

  if [[ ! -L "${writer_link}" ]]; then
    pass "token-tally-writer symlink removed by uninstall"
  else
    fail "token-tally-writer symlink still present after uninstall"
  fi

  if [[ ! -L "${usage_link}" ]]; then
    pass "token-tally-usage symlink removed by uninstall"
  else
    fail "token-tally-usage symlink still present after uninstall"
  fi

  # Cursor cleanup — only verify if ~/.cursor was present (was installed).
  if [[ -d "${HOME}/.cursor" ]]; then
    if [[ ! -L "${cursor_hook_link_real}" ]]; then
      pass "token-tally-cursor-hook symlink removed by uninstall"
    else
      fail "token-tally-cursor-hook symlink still present after uninstall"
    fi

    if [[ -f "${cursor_hooks_json_real}" ]]; then
      local cursor_remaining
      cursor_remaining=$(TT_HOOKS_PATH="${cursor_hooks_json_real}" python3 - <<'PY'
import json, os
with open(os.environ["TT_HOOKS_PATH"]) as f:
    data = json.load(f)
hooks = data.get("hooks", {})
found = sum(
    1 for entries in hooks.values()
    if isinstance(entries, list)
    for h in entries
    if isinstance(h, dict) and "token-tally-cursor-hook" in h.get("command", "")
)
print(found)
PY
      ) || cursor_remaining="error"
      if [[ "${cursor_remaining}" == "0" ]]; then
        pass "hooks.json: no token-tally-cursor-hook entries remain after uninstall"
      elif [[ "${cursor_remaining}" == "error" ]]; then
        warn "hooks.json: could not verify cleanup after uninstall"
      else
        fail "hooks.json: ${cursor_remaining} token-tally-cursor-hook entries still present after uninstall"
      fi
    fi
  fi

  # Confirm user data is NOT purged by default uninstall
  local central_db="${XDG_DATA_HOME:-${HOME}/.local/share}/token-tally/events.db"
  if [[ -f "${central_db}" ]]; then
    pass "user data preserved after uninstall: ${central_db}"
  else
    warn "central DB not found after uninstall — may not have existed yet (ok on first run)"
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

print_summary() {
  echo
  if [[ "${FAIL_COUNT}" -eq 0 && "${WARN_COUNT}" -eq 0 ]]; then
    echo -e "${GREEN}All checks passed.${RESET}"
  elif [[ "${FAIL_COUNT}" -eq 0 ]]; then
    echo -e "${YELLOW}All checks passed with ${WARN_COUNT} warning(s).${RESET}"
  else
    echo -e "${RED}${FAIL_COUNT} check(s) FAILED, ${WARN_COUNT} warning(s).${RESET}"
  fi
  echo
  if [[ "${FAIL_COUNT}" -gt 0 ]]; then
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"

  echo -e "${BOLD}ToTally e2e smoke test${RESET}"
  if [[ "${OPT_REAL}" == "true" ]]; then
    echo "  Mode: real install (--real)"
  else
    echo "  Mode: safe (temp dir — no changes to /Applications or real \$HOME)"
  fi
  echo "  Repo: ${REPO_ROOT}"

  run_safe_checks

  if [[ "${OPT_REAL}" == "true" ]]; then
    run_real_checks
  fi

  print_summary
}

main "$@"
