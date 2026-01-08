---
name: verify-changes
description: Run all mandatory verification steps for code changes in the OpenAI Agents JS monorepo.
---

# Verify Changes

## Overview

Ensure work is only marked complete after installing dependencies, building, linting, type checking, and tests pass. Use this skill whenever wrapping up a task, before opening a PR, or when asked to confirm that changes are ready to hand off.

## Quick start

1. Keep this skill at `./.codex/skills/verify-changes` so it loads automatically for the repository.
2. macOS/Linux: `bash .codex/skills/verify-changes/scripts/run.sh`.
3. Windows: `powershell -ExecutionPolicy Bypass -File .codex/skills/verify-changes/scripts/run.ps1`.
4. If any command fails, fix the issue, rerun the script, and report the failing output.
5. Confirm completion only when all commands succeed with no remaining issues.

## Manual workflow

- Run from the repository root in this order: `pnpm i`, `pnpm build`, `pnpm -r build-check`, `pnpm lint`, `pnpm test`.
- Do not skip steps; stop and fix issues immediately when a command fails.
- Re-run the full stack after applying fixes so the commands execute in the required order.

## Resources

### scripts/run.sh

- Executes the full verification sequence with fail-fast semantics.
- Prefer this entry point to ensure the commands always run in the correct order from the repo root.

### scripts/run.ps1

- Windows-friendly wrapper that runs the same verification sequence with fail-fast semantics.
- Use from PowerShell with execution policy bypass if required by your environment.
