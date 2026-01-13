#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PID_FILE="$ROOT/.tmp/examples-auto-run.pid"
LOG_DIR="$ROOT/.tmp/examples-start-logs"
RERUN_FILE="$ROOT/.tmp/examples-rerun.txt"

ensure_dirs() {
  mkdir -p "$LOG_DIR" "$ROOT/.tmp"
}

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1
}

cmd_start() {
  ensure_dirs
  local background=0
  if [[ "${1:-}" == "--background" ]]; then
    background=1
    shift
  fi

  local ts log_file
  ts="$(date +%Y%m%d-%H%M%S)"
  log_file="$LOG_DIR/main_${ts}.log"

  if [[ "$background" -eq 1 ]]; then
    if [[ -f "$PID_FILE" ]]; then
      local pid
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
      if is_running "$pid"; then
        echo "examples:start-all already running (pid=$pid)."
        exit 1
      fi
    fi
    (
      trap '' HUP
      export EXAMPLES_MAIN_LOG="$log_file"
      export EXAMPLES_INTERACTIVE_MODE="${EXAMPLES_INTERACTIVE_MODE:-auto}"
      export AUTO_APPROVE_MCP="${AUTO_APPROVE_MCP:-1}"
      export APPLY_PATCH_AUTO_APPROVE="${APPLY_PATCH_AUTO_APPROVE:-1}"
      export AUTO_APPROVE_HITL="${AUTO_APPROVE_HITL:-1}"
      export EXAMPLES_CONCURRENCY="${EXAMPLES_CONCURRENCY:-4}"
      export EXAMPLES_EXECA_TIMEOUT_MS="${EXAMPLES_EXECA_TIMEOUT_MS:-300000}"
      export EXAMPLES_INCLUDE_INTERACTIVE="${EXAMPLES_INCLUDE_INTERACTIVE:-1}"
      export EXAMPLES_INCLUDE_SERVER="${EXAMPLES_INCLUDE_SERVER:-0}"
      export EXAMPLES_INCLUDE_AUDIO="${EXAMPLES_INCLUDE_AUDIO:-0}"
      export EXAMPLES_INCLUDE_EXTERNAL="${EXAMPLES_INCLUDE_EXTERNAL:-0}"
      cd "$ROOT"
      pnpm examples:start-all --include-interactive "$@" 2>&1 | tee "$log_file" >/dev/null
    ) &
    local pid=$!
    echo "$pid" >"$PID_FILE"
    echo "Started examples:start-all (pid=$pid)"
    echo "Log: $log_file"
    return 0
  fi

  export EXAMPLES_MAIN_LOG="$log_file"
  export EXAMPLES_INTERACTIVE_MODE="${EXAMPLES_INTERACTIVE_MODE:-auto}"
  export AUTO_APPROVE_MCP="${AUTO_APPROVE_MCP:-1}"
  export APPLY_PATCH_AUTO_APPROVE="${APPLY_PATCH_AUTO_APPROVE:-1}"
  export AUTO_APPROVE_HITL="${AUTO_APPROVE_HITL:-1}"
  export EXAMPLES_CONCURRENCY="${EXAMPLES_CONCURRENCY:-4}"
  export EXAMPLES_EXECA_TIMEOUT_MS="${EXAMPLES_EXECA_TIMEOUT_MS:-300000}"
  export EXAMPLES_INCLUDE_INTERACTIVE="${EXAMPLES_INCLUDE_INTERACTIVE:-1}"
  export EXAMPLES_INCLUDE_SERVER="${EXAMPLES_INCLUDE_SERVER:-0}"
  export EXAMPLES_INCLUDE_AUDIO="${EXAMPLES_INCLUDE_AUDIO:-0}"
  export EXAMPLES_INCLUDE_EXTERNAL="${EXAMPLES_INCLUDE_EXTERNAL:-0}"
  cd "$ROOT"
  pnpm examples:start-all --include-interactive "$@" 2>&1 | tee "$log_file"
  return $?
}

cmd_stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No pid file; nothing to stop."
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    rm -f "$PID_FILE"
    echo "Pid file empty; cleaned."
    return 0
  fi
  if ! is_running "$pid"; then
    rm -f "$PID_FILE"
    echo "Process $pid not running; cleaned pid file."
    return 0
  fi
  echo "Stopping pid $pid ..."
  kill "$pid" 2>/dev/null || true
  sleep 1
  if is_running "$pid"; then
    echo "Sending SIGKILL to $pid ..."
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "Stopped."
}

cmd_status() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_running "$pid"; then
      echo "Running (pid=$pid)"
      return 0
    fi
  fi
  echo "Not running."
}

cmd_logs() {
  ensure_dirs
  ls -1t "$LOG_DIR"
}

cmd_tail() {
  ensure_dirs
  local file="$1"
  if [[ -z "${file:-}" ]]; then
    file="$(ls -1t "$LOG_DIR" | head -n1)"
  fi
  if [[ -z "$file" ]]; then
    echo "No log files yet."
    exit 1
  fi
  tail -f "$LOG_DIR/$file"
}

collect_rerun() {
  ensure_dirs
  local log_file="${1:-}"
  if [[ -z "$log_file" ]]; then
    log_file="$(ls -1t "$LOG_DIR"/main_*.log 2>/dev/null | head -n1)"
  fi
  if [[ -z "$log_file" ]] || [[ ! -f "$log_file" ]]; then
    echo "No main log file found."
    exit 1
  fi
  node scripts/run-example-starts.mjs --collect "$log_file" --output "$RERUN_FILE"
}


rerun_list() {
  ensure_dirs
  local include_server="${EXAMPLES_INCLUDE_SERVER:-0}"
  local include_audio="${EXAMPLES_INCLUDE_AUDIO:-0}"
  local include_interactive="${EXAMPLES_INCLUDE_INTERACTIVE:-0}"
  local include_external="${EXAMPLES_INCLUDE_EXTERNAL:-0}"
  local interactive_mode="${EXAMPLES_INTERACTIVE_MODE:-auto}"
  local file="${1:-$RERUN_FILE}"
  if [[ ! -f "$file" ]]; then
    echo "Rerun list not found: $file"
    exit 1
  fi
  # same keywords as scripts/run-example-starts.mjs
  # Simplified tag detection aligned with start: interactiveは特別扱いしない
  local -a server_keywords=("realtime" "nextjs" "server" "vite" "next")
  local -a audio_keywords=("realtime" "voice" "audio")
  local -a external_keywords=("prisma" "redis" "twilio" "dapr" "playwright")

  load_auto_skip() {
    node --input-type=module - "$ROOT" <<'NODE'
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const rootDir = process.argv[2];
const { loadAutoSkip, DEFAULT_AUTO_SKIP } = await import(pathToFileURL(path.join(rootDir, 'scripts', 'run-example-starts.mjs')));
const set = loadAutoSkip ? loadAutoSkip() : new Set(DEFAULT_AUTO_SKIP);
for (const item of [...set]) {
  console.log(item);
}
NODE
  }

  local -a auto_skip_list=()
  while IFS= read -r auto_skip_entry; do
    [[ -z "$auto_skip_entry" ]] && continue
    auto_skip_list+=("$auto_skip_entry")
  done < <(load_auto_skip | awk NF)
  has_keyword() {
    local name="$1"; shift
    local kw
    for kw in "$@"; do
      if [[ "$name" == *"$kw"* ]]; then
        return 0
      fi
    done
    return 1
  }

  detect_tags() {
    local name="$1"
    local tags=()
    if has_keyword "$name" "${server_keywords[@]}"; then tags+=("server"); fi
    if has_keyword "$name" "${audio_keywords[@]}"; then tags+=("audio"); fi
    if has_keyword "$name" "${external_keywords[@]}"; then tags+=("external"); fi
    printf '%s\n' "${tags[@]:-}"
  }

  should_skip() {
    local name="$1"
    local tags
    tags="$(detect_tags "$name")"
    local t
    for t in $tags; do
      case "$t" in
        server) [[ "$include_server" == "1" ]] || { echo "Skipping $name (server). Set EXAMPLES_INCLUDE_SERVER=1 to run."; return 0; } ;;
        audio) [[ "$include_audio" == "1" ]] || { echo "Skipping $name (audio). Set EXAMPLES_INCLUDE_AUDIO=1 to run."; return 0; } ;;
        external) [[ "$include_external" == "1" ]] || { echo "Skipping $name (external). Set EXAMPLES_INCLUDE_EXTERNAL=1 to run."; return 0; } ;;
      esac
    done
    return 1
  }

  local -a remaining=()

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    IFS=':' read -r pkg rest <<<"$entry"
    script="$rest"
    if [[ -z "$pkg" || -z "$script" ]]; then
      echo "Skipping invalid entry: $entry"
      continue
    fi
    local full="${pkg}:${script}"
    local skip_auto=0
    for a in "${auto_skip_list[@]}"; do
      if [[ "$full" == "$a" ]]; then
        skip_auto=1
        break
      fi
    done
    if [[ $skip_auto -eq 1 ]]; then
      echo "Skipping $full (auto-skip list)."
      continue
    fi

    if should_skip "$full"; then
      remaining+=("$entry")
      continue
    fi
    log_name="${pkg}__${script//:/-}.rerun.log"
    echo ">>> Rerunning $pkg:${script}"
    (
      cd "$ROOT"
      export EXAMPLES_INTERACTIVE_MODE="${EXAMPLES_INTERACTIVE_MODE:-auto}"
      export AUTO_APPROVE_MCP="${AUTO_APPROVE_MCP:-1}"
      export APPLY_PATCH_AUTO_APPROVE="${APPLY_PATCH_AUTO_APPROVE:-1}"
      export AUTO_APPROVE_HITL="${AUTO_APPROVE_HITL:-1}"
      { pnpm -C "examples/$pkg" run "${script}"; rc=$?; } 2>&1 | tee "$LOG_DIR/$log_name"
      rc=${PIPESTATUS[0]}
      if [[ $rc -ne 0 ]]; then
        echo "!!! Rerun failed: ${pkg}:${script} (exit $rc)"
        exit $rc
      fi
      exit 0
    )
    rc=$?
    if [[ $rc -ne 0 ]]; then
      remaining+=("$entry")
    fi
  done <"$file"

  # De-duplicate and persist remaining list
  if [[ ${#remaining[@]} -gt 0 ]]; then
    printf "%s\n" "${remaining[@]}" | awk '!seen[$0]++' >"$file"
    echo "Updated rerun list with ${#remaining[@]} remaining entries."
  else
    : >"$file"
    echo "All rerun entries completed successfully; rerun list cleared."
  fi
}

usage() {
  cat <<'EOF'
Usage: run.sh <start|stop|status|logs|tail|collect|rerun> [args...]

Commands:
  start [--filter ... | other args]   Start examples:start-all in background with auto mode.
  stop                                Kill the running examples:start-all (if any).
  status                              Show whether it is running.
  logs                                List log files (.tmp/examples-start-logs).
  tail [logfile]                      Tail the latest (or specified) log.
  collect [main_log]                  Parse a main log and write non-passed examples to .tmp/examples-rerun.txt.
  rerun [rerun_file]                  Run only the examples listed in .tmp/examples-rerun.txt (one per line: package:script).

Environment overrides:
  EXAMPLES_CONCURRENCY (default 4)
  EXAMPLES_EXECA_TIMEOUT_MS (default 300000)
  EXAMPLES_INCLUDE_SERVER/INTERACTIVE/AUDIO/EXTERNAL (defaults: 0/1/0/0)
  EXAMPLES_AUTO_SKIP (comma/space separated list; overrides built-in defaults)
EOF
}

# Decide default command
default_cmd="start"
if [[ $# -eq 0 && -s "$RERUN_FILE" ]]; then
  default_cmd="rerun"
fi

case "${1:-$default_cmd}" in
  start) shift || true; cmd_start "$@" ;;
  stop) shift || true; cmd_stop ;;
  status) shift || true; cmd_status ;;
  logs) shift || true; cmd_logs ;;
  tail) shift; cmd_tail "${1:-}" ;;
  collect) shift || true; collect_rerun "${1:-}" ;;
  rerun) shift || true; rerun_list "${1:-}" ;;
  *) usage; exit 1 ;;
esac
