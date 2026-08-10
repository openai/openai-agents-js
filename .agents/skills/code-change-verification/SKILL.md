---
name: code-change-verification
description: Run the mandatory verification stack when changes affect runtime code, tests, or build/test behavior in the OpenAI Agents JS monorepo.
---

# Code Change Verification

## Overview

Ensure work is only marked complete after installing dependencies, building, linting, type checking (including generated declarations), and tests pass. Use this skill when changes affect runtime code, tests, or build/test configuration. This is a post-review final gate: when `$implementation-final-review` applies, do not invoke the broad stack until its clean-review condition applies to the stable task diff.

## Quick start

1. Keep this skill at `./.agents/skills/code-change-verification` so it loads automatically for the repository.
2. Run the skill in the user's selected checkout without changing worktrees or branches.
3. macOS/Linux: `bash .agents/skills/code-change-verification/scripts/run.sh`.
4. Windows: `powershell -ExecutionPolicy Bypass -File .agents/skills/code-change-verification/scripts/run.ps1`.
5. If any command fails, fix the issue, rerun the script, and report the failing output.
6. Confirm completion only when all commands succeed with no remaining issues.

## Start condition and host capacity

- During iterative review, use only focused tests and a narrowly targeted static check when the changed typing boundary requires one. Defer repository-wide `pnpm -r build-check` and the rest of this complete stack until review is clean.
- Immediately before starting the complete stack, use available read-only task or process evidence to check whether another repository-wide test, typecheck, build, examples runner, or integration command is already active on the same host.
- When concrete contention is visible, continue useful non-heavy work such as review, remediation, evidence preparation, or focused checks, then check again later. Do not create or wait on a repository lock, host-wide mutex, or sentinel file.
- Start automatically once review is clean, the diff is stable, and observable host capacity is available. Do not require a user-triggered `finalize` message. If host telemetry is unavailable, do not block solely because capacity cannot be measured.

## Manual workflow

- Run from the repository root in these phases: `pnpm i --frozen-lockfile`, `pnpm build`, then `pnpm -r build-check`, `pnpm -r -F "@openai/*" dist:check`, `pnpm lint`, `pnpm test`, and `pnpm format:check:changed`.
- The skill may execute the final validation phase in parallel, but every step above must still pass.
- Do not skip steps; stop and fix issues immediately when any step fails.
- Re-run the full stack after applying fixes so the commands execute with the same barriers and coverage.
- The install intentionally runs without forcing CI or prompt-confirmation settings. If pnpm reports incompatible `node_modules`, stop and diagnose the configuration mismatch instead of silently recreating dependencies.

## Resources

### scripts/run.sh

- Executes the full verification sequence (including declaration checks) with fail-fast semantics.
- Keeps `pnpm i --frozen-lockfile` and `pnpm build` as barriers, then delegates independent validation steps to `concurrently`.
- Prefer this entry point to ensure the commands always run from the repo root with the expected fail-fast behavior.

### scripts/run.ps1

- Windows-friendly wrapper that runs the same verification sequence with fail-fast semantics.
- Use from PowerShell with execution policy bypass if required by your environment.
