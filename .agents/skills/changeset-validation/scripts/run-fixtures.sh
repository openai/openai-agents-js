#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(git rev-parse --show-toplevel)
SKILL_DIR="$ROOT_DIR/.agents/skills/changeset-validation"

node "$SKILL_DIR/scripts/changeset-prompt.mjs" --output "$SKILL_DIR/tmp/prompt.md" >/dev/null

TMP_DIR=$(mktemp -d)
PASS_JSON="$TMP_DIR/pass.json"
FAIL_JSON="$TMP_DIR/fail.json"
SCHEMA_JSON="$TMP_DIR/schema.json"
PATCH_JSON="$TMP_DIR/patch.json"

cat > "$PASS_JSON" <<'JSON'
{"ok":true,"errors":[],"warnings":[],"required_bump":"none"}
JSON

cat > "$FAIL_JSON" <<'JSON'
{"ok":false,"errors":["Missing changeset."],"warnings":[],"required_bump":"patch"}
JSON

cat > "$SCHEMA_JSON" <<'JSON'
{"ok":true}
JSON

cat > "$PATCH_JSON" <<'JSON'
{"ok":true,"errors":[],"warnings":[],"required_bump":"patch"}
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

MILESTONE_REPO="$TMP_DIR/milestone-repo"
mkdir -p "$MILESTONE_REPO"
git -C "$MILESTONE_REPO" init >/dev/null
git -C "$MILESTONE_REPO" config user.email test@example.com
git -C "$MILESTONE_REPO" config user.name "Test User"
mkdir -p "$MILESTONE_REPO/.changeset"
git -C "$MILESTONE_REPO" commit --allow-empty -m "base" >/dev/null
BASE_SHA=$(git -C "$MILESTONE_REPO" rev-parse HEAD)
cat > "$MILESTONE_REPO/.changeset/minor.md" <<'MD'
---
'@openai/agents-core': minor
---

feat: add test feature
MD
git -C "$MILESTONE_REPO" add .changeset/minor.md
git -C "$MILESTONE_REPO" commit -m "head" >/dev/null
HEAD_SHA=$(git -C "$MILESTONE_REPO" rev-parse HEAD)
cat > "$TMP_DIR/event.json" <<JSON
{
  "repository": {
    "owner": { "login": "openai" },
    "name": "openai-agents-js"
  },
  "pull_request": {
    "number": 1210,
    "base": { "sha": "$BASE_SHA" },
    "head": { "sha": "$HEAD_SHA" }
  }
}
JSON

output=$(
  cd "$MILESTONE_REPO"
  GITHUB_TOKEN=dummy \
    GITHUB_EVENT_PATH="$TMP_DIR/event.json" \
    CHANGESET_ASSIGN_MILESTONE_DRY_RUN=1 \
    CHANGESET_ASSIGN_MILESTONE_MILESTONES_JSON='[{"title":"0.8.x","number":6},{"title":"0.9.x","number":7}]' \
    node "$SKILL_DIR/scripts/changeset-assign-milestone.mjs" "$PATCH_JSON"
)
if [ "$output" != "Milestone would be set to 0.9.x." ]; then
  echo "FAIL: milestone assignment uses changeset release bump"
  echo "$output"
  exit 1
fi
echo "OK: milestone assignment uses changeset release bump"

STALE_REPO="$TMP_DIR/stale-repo"
mkdir -p "$STALE_REPO"
git -C "$STALE_REPO" init >/dev/null
git -C "$STALE_REPO" config user.email test@example.com
git -C "$STALE_REPO" config user.name "Test User"
mkdir -p "$STALE_REPO/.changeset"
cat > "$STALE_REPO/.changeset/stale.md" <<'MD'
---
'@openai/agents-core': minor
---

feat: old branch-local changeset
MD
git -C "$STALE_REPO" add .changeset/stale.md
git -C "$STALE_REPO" commit -m "common" >/dev/null
COMMON_SHA=$(git -C "$STALE_REPO" rev-parse HEAD)
git -C "$STALE_REPO" checkout -b pr-head "$COMMON_SHA" >/dev/null 2>&1
HEAD_SHA=$(git -C "$STALE_REPO" rev-parse HEAD)
git -C "$STALE_REPO" checkout -b current-base "$COMMON_SHA" >/dev/null 2>&1
git -C "$STALE_REPO" rm .changeset/stale.md >/dev/null
git -C "$STALE_REPO" commit -m "remove stale changeset on base" >/dev/null
BASE_SHA=$(git -C "$STALE_REPO" rev-parse HEAD)
cat > "$TMP_DIR/stale-event.json" <<JSON
{
  "repository": {
    "owner": { "login": "openai" },
    "name": "openai-agents-js"
  },
  "pull_request": {
    "number": 1210,
    "base": { "sha": "$BASE_SHA" },
    "head": { "sha": "$HEAD_SHA" }
  }
}
JSON

output=$(
  cd "$STALE_REPO"
  GITHUB_TOKEN=dummy \
    GITHUB_EVENT_PATH="$TMP_DIR/stale-event.json" \
    CHANGESET_ASSIGN_MILESTONE_DRY_RUN=1 \
    CHANGESET_ASSIGN_MILESTONE_MILESTONES_JSON='[{"title":"0.8.x","number":6},{"title":"0.9.x","number":7}]' \
    node "$SKILL_DIR/scripts/changeset-assign-milestone.mjs" "$PATCH_JSON"
)
if [ "$output" != "Milestone would be set to 0.8.x." ]; then
  echo "FAIL: milestone assignment ignores base-only stale changesets"
  echo "$output"
  exit 1
fi
echo "OK: milestone assignment ignores base-only stale changesets"

rm -rf "$TMP_DIR"
rm -rf "$SKILL_DIR/tmp"

echo "changeset-validation fixture checks passed."
