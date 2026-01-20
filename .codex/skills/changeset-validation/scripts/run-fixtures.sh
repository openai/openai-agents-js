#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(git rev-parse --show-toplevel)
SKILL_DIR="$ROOT_DIR/.codex/skills/changeset-validation"

node "$SKILL_DIR/scripts/changeset-prompt.mjs" --output "$SKILL_DIR/tmp/prompt.md" >/dev/null

TMP_DIR=$(mktemp -d)
PASS_JSON="$TMP_DIR/pass.json"
FAIL_JSON="$TMP_DIR/fail.json"
SCHEMA_JSON="$TMP_DIR/schema.json"

cat > "$PASS_JSON" <<'JSON'
{"ok":true,"errors":[],"warnings":[],"required_bump":"none"}
JSON

cat > "$FAIL_JSON" <<'JSON'
{"ok":false,"errors":["Missing changeset."],"warnings":[],"required_bump":"patch"}
JSON

cat > "$SCHEMA_JSON" <<'JSON'
{"ok":true}
JSON

run_expect() {
  local expected=$1
  local label=$2
  shift 2
  local output
  set +e
  output=$("$@" 2>&1)
  local status=$?
  set -e
  if [ "$status" -ne "$expected" ]; then
    echo "FAIL: $label"
    echo "$output"
    exit 1
  fi
  if [ "$expected" -eq 0 ]; then
    echo "OK: $label"
  else
    echo "OK (expected failure): $label"
  fi
}

run_expect 0 "valid JSON passes" node "$SKILL_DIR/scripts/changeset-validation-result.mjs" "$PASS_JSON"
run_expect 1 "invalid JSON fails" node "$SKILL_DIR/scripts/changeset-validation-result.mjs" "$FAIL_JSON"
run_expect 1 "schema errors fail" node "$SKILL_DIR/scripts/changeset-validation-result.mjs" "$SCHEMA_JSON"

run_expect 0 "milestone assignment skips without token" node "$SKILL_DIR/scripts/changeset-assign-milestone.mjs" "$PASS_JSON"
run_expect 0 "milestone assignment handles fail case" node "$SKILL_DIR/scripts/changeset-assign-milestone.mjs" "$FAIL_JSON"

rm -rf "$TMP_DIR"
rm -rf "$SKILL_DIR/tmp"

echo "changeset-validation fixture checks passed."
