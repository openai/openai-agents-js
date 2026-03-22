---
name: code-change-verification
description: Run the mandatory verification stack when changes affect runtime code, tests, or build/test behavior in the OpenAI Agents JS monorepo.
---

# Code Change Verification

## Overview

Ensure work is only marked complete after installing dependencies, building, linting, type checking (including generated declarations), and tests pass. Use this skill when changes affect runtime code, tests, or build/test configuration.

## Quick start

1. Keep this skill at `./.agents/skills/code-change-verification` so it loads automatically for the repository.
2. macOS/Linux: `bash .agents/skills/code-change-verification/scripts/run.sh`.
3. Windows: `powershell -ExecutionPolicy Bypass -File .agents/skills/code-change-verification/scripts/run.ps1`.
4. If any command fails, fix the issue, rerun the script, and report the failing output.
5. Confirm completion only when all commands succeed with no remaining issues.

## Manual workflow

- Run from the repository root in these phases: `pnpm i`, `pnpm build`, then `pnpm -r build-check`, `pnpm -r -F "@openai/*" dist:check`, `pnpm lint`, and `pnpm test`.
- The skill may execute the final validation phase in parallel, but every step above must still pass.
- Do not skip steps; stop and fix issues immediately when any step fails.
- Re-run the full stack after applying fixes so the commands execute with the same barriers and coverage.

## Resources

### scripts/run.sh

- Executes the full verification sequence (including declaration checks) with fail-fast semantics.
- Keeps `pnpm i` and `pnpm build` as barriers, then runs independent validation steps in parallel.
- Prefer this entry point to ensure the commands always run from the repo root with the expected fail-fast behavior.

### scripts/run.ps1

- Windows-friendly wrapper that runs the same verification sequence with fail-fast semantics.
- Use from PowerShell with execution policy bypass if required by your environment.
