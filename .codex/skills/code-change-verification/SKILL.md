---
name: code-change-verification
description: Run the mandatory verification stack when changes affect runtime code, tests, or build/test behavior in the OpenAI Agents JS monorepo.
---

# Code Change Verification

## Overview

Ensure work is only marked complete after installing dependencies, building, linting, type checking (including generated declarations), and tests pass. Use this skill when changes affect runtime code, tests, or build/test configuration.

## Quick start

1. Keep this skill at `./.codex/skills/code-change-verification` so it loads automatically for the repository.
2. macOS/Linux: `bash .codex/skills/code-change-verification/scripts/run.sh`.
3. Windows: `powershell -ExecutionPolicy Bypass -File .codex/skills/code-change-verification/scripts/run.ps1`.
4. If any command fails, fix the issue, rerun the script, and report the failing output.
5. Confirm completion only when all commands succeed with no remaining issues.

## Manual workflow

- Run from the repository root in this order: `pnpm i`, `pnpm build`, `pnpm -r build-check`, `pnpm -r -F "@openai/*" dist:check`, `pnpm lint`, `pnpm test`.
- Do not skip steps; stop and fix issues immediately when a command fails.
- Re-run the full stack after applying fixes so the commands execute in the required order.

## Resources

### scripts/run.sh

- Executes the full verification sequence (including declaration checks) with fail-fast semantics.
- Prefer this entry point to ensure the commands always run in the correct order from the repo root.

### scripts/run.ps1

- Windows-friendly wrapper that runs the same verification sequence with fail-fast semantics.
- Use from PowerShell with execution policy bypass if required by your environment.
