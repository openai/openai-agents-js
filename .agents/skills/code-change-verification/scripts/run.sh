#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v git >/dev/null 2>&1; then
  REPO_ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null || true)"
fi
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../../../.." && pwd)}"

cd "${REPO_ROOT}"

echo "Running pnpm i..."
pnpm i

echo "Running pnpm build..."
pnpm build

echo "Running pnpm -r build-check..."
pnpm -r build-check

echo "Running pnpm -r -F \"@openai/*\" dist:check..."
pnpm -r -F "@openai/*" dist:check

echo "Running pnpm lint..."
pnpm lint

echo "Running pnpm test..."
pnpm test

echo "code-change-verification: all commands passed."
