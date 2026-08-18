#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
if [[ "$SCRIPT_DIR" == "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="."
fi
if [[ "$SCRIPT_DIR" != /* ]]; then
  SCRIPT_DIR="$PWD/$SCRIPT_DIR"
fi
ROOT="$SCRIPT_DIR/.."
STATE_DIR="${EXAMPLES_WORKFLOW_STATE_DIR:-$ROOT/.tmp}"
PID_FILE="$STATE_DIR/examples-auto-run.pid"
LOG_DIR="$STATE_DIR/examples-start-logs"

local_helper() {
  env -u OPENAI_API_KEY "$@"
}

ensure_dirs() {
  local_helper mkdir -p "$LOG_DIR" "$STATE_DIR"
}

is_running() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && local_helper ps -p "$pid" >/dev/null 2>&1
}

is_owned_supervisor() {
  local pid="$1"
  local token="$2"
  local owner_command
  owner_command="$(local_helper ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$owner_command" == *"run-examples-background.mjs --token $token"* ]]
}

run_examples_preflight() {
  env -u OPENAI_API_KEY pnpm build
  env -u OPENAI_API_KEY pnpm -r build-check
}

run_examples_start() {
  pnpm examples:start-all --include-interactive "$@"
}

require_service_account_key() {
  if [[ "${OPENAI_API_KEY_SOURCE:-}" != "service-account" ]]; then
    echo "Refusing to run examples without OPENAI_API_KEY_SOURCE=service-account." >&2
    return 78
  fi
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    echo "Refusing to run examples without OPENAI_API_KEY." >&2
    return 78
  fi
}

start_runner() {
  local log_file="$1"
  shift

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
  run_examples_preflight
  run_examples_start "$@"
}

cmd_start() {
  require_service_account_key
  ensure_dirs
  local background=0
  if [[ "${1:-}" == "--background" ]]; then
    background=1
    shift
  fi

  local ts log_file
  ts="$(local_helper date +%Y%m%d-%H%M%S)"
  log_file="$LOG_DIR/main_${ts}.log"

  if [[ "$background" -eq 1 ]]; then
    if [[ -f "$PID_FILE" ]]; then
      local pid token state
      IFS=' ' read -r pid token state <"$PID_FILE" || true
      if is_running "$pid"; then
        if is_owned_supervisor "$pid" "$token"; then
          echo "examples:start-all already running (pid=$pid)."
        else
          echo "Refusing to replace stale state for unowned pid $pid. Inspect and remove $PID_FILE manually." >&2
        fi
        return 1
      fi
      local_helper rm -f "$PID_FILE"
    fi
    local token
    token="$(
      local_helper node --input-type=module --eval \
        'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID());'
    )"
    (
      trap '' HUP
      exec node "$ROOT/scripts/run-examples-background.mjs" \
        --token "$token" \
        --pid-file "$PID_FILE" \
        --script "$ROOT/scripts/run-examples-workflow.sh" \
        --log "$log_file" \
        -- "$@"
    ) >>"$log_file" 2>&1 &
    local pid=$!
    printf '%s %s pending\n' "$pid" "$token" >"$PID_FILE"
    local ready=0
    for _attempt in {1..100}; do
      if [[ -f "$PID_FILE" ]]; then
        local current_pid current_token current_state
        IFS=' ' read -r current_pid current_token current_state <"$PID_FILE" || true
        if [[ "$current_pid" == "$pid" && "$current_token" == "$token" && "$current_state" == "ready" ]] && is_owned_supervisor "$pid" "$token"; then
          ready=1
          break
        fi
      fi
      if ! is_running "$pid"; then
        break
      fi
      local_helper sleep 0.05
    done
    if [[ "$ready" -ne 1 ]]; then
      local_helper rm -f "$PID_FILE"
      echo "Background example supervisor failed to start. See $log_file." >&2
      return 1
    fi
    echo "Started examples:start-all (pid=$pid)"
    echo "Log: $log_file"
    return 0
  fi

  start_runner "$log_file" "$@" 2>&1 | local_helper tee "$log_file"
  return $?
}

cmd_background_worker() {
  local log_file="$1"
  shift
  start_runner "$log_file" "$@" 2>&1 | local_helper tee "$log_file" >/dev/null
  return "${PIPESTATUS[0]}"
}

cmd_stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No pid file; nothing to stop."
    return 0
  fi
  local pid token state
  IFS=' ' read -r pid token state <"$PID_FILE" || true
  if [[ -z "${pid:-}" || -z "${token:-}" ]]; then
    local_helper rm -f "$PID_FILE"
    echo "Pid file empty; cleaned."
    return 0
  fi
  if ! is_running "$pid"; then
    local_helper rm -f "$PID_FILE"
    echo "Process $pid not running; cleaned pid file."
    return 0
  fi
  if ! is_owned_supervisor "$pid" "$token"; then
    echo "Refusing to signal unowned pid $pid from stale state $PID_FILE." >&2
    return 1
  fi
  if [[ "$state" != "ready" ]]; then
    echo "Background supervisor $pid is still starting; retry stop after it reports ready." >&2
    return 1
  fi
  echo "Stopping pid $pid ..."
  kill "$pid" 2>/dev/null || true
  for _attempt in {1..140}; do
    if ! is_running "$pid"; then
      local_helper rm -f "$PID_FILE"
      echo "Stopped."
      return 0
    fi
    local_helper sleep 0.05
  done
  echo "Background supervisor $pid did not stop its owned process group cleanly." >&2
  return 1
}

cmd_status() {
  if [[ -f "$PID_FILE" ]]; then
    local pid token state
    IFS=' ' read -r pid token state <"$PID_FILE" || true
    if is_running "$pid"; then
      if is_owned_supervisor "$pid" "$token"; then
        if [[ "$state" == "ready" ]]; then
          echo "Running (pid=$pid)"
        else
          echo "Starting (pid=$pid)"
        fi
        return 0
      fi
      echo "Stale state references unowned pid $pid."
      return 1
    fi
  fi
  echo "Not running."
}

cmd_logs() {
  ensure_dirs
  local_helper ls -1t "$LOG_DIR"
}

cmd_tail() {
  ensure_dirs
  local file="$1"
  if [[ -z "${file:-}" ]]; then
    file="$(local_helper ls -1t "$LOG_DIR" | local_helper head -n1)"
  fi
  if [[ -z "$file" ]]; then
    echo "No log files yet."
    exit 1
  fi
  local_helper tail -f "$LOG_DIR/$file"
}

usage() {
  cat <<'EOF'
Usage: run-examples-workflow.sh <start|stop|status|logs|tail> [args...]

Commands:
  start [--background] [runner args]  Run examples:start-all in auto mode (foreground by default).
  stop                                Kill the running examples:start-all (if any).
  status                              Show whether it is running.
  logs                                List log files (.tmp/examples-start-logs).
  tail [logfile]                      Tail the latest (or specified) log.

Environment overrides:
  EXAMPLES_CONCURRENCY (default 4)
  EXAMPLES_EXECA_TIMEOUT_MS (default 300000)
  EXAMPLES_INCLUDE_SERVER/INTERACTIVE/AUDIO/EXTERNAL (defaults: 0/1/0/0)
  EXAMPLES_AUTO_SKIP (comma/space separated list; overrides built-in defaults)
EOF
}

case "${1:-start}" in
  __background_worker) shift; cmd_background_worker "$@" ;;
  start) shift || true; cmd_start "$@" ;;
  stop) shift || true; cmd_stop ;;
  status) shift || true; cmd_status ;;
  logs) shift || true; cmd_logs ;;
  tail) shift; cmd_tail "${1:-}" ;;
  help|--help|-h) usage ;;
  *) usage; exit 1 ;;
esac
