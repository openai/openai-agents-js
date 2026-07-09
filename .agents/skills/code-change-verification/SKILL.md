---
name: code-change-verification
description: Run the mandatory verification stack when changes affect runtime code, tests, or build/test behavior in the OpenAI Agents JS monorepo.
---

# Code Change Verification

## Overview

Ensure work is only marked complete after installing dependencies, building, linting, type checking (including generated declarations), and tests pass. Use this skill when changes affect runtime code, tests, or build/test configuration.

## Quick start

1. Keep this skill at `./.agents/skills/code-change-verification` so it loads automatically for the repository.
2. Codex must run the skill from a linked Git worktree with its own `node_modules`. The runner refuses to start from the primary worktree in a Codex environment unless the user explicitly approved `CODEX_ALLOW_SHARED_PNPM=1` in the same turn.
3. macOS/Linux: `bash .agents/skills/code-change-verification/scripts/run.sh`.
4. Windows: `powershell -ExecutionPolicy Bypass -File .agents/skills/code-change-verification/scripts/run.ps1`.
5. If any command fails, fix the issue, rerun the script, and report the failing output.
6. Confirm completion only when all commands succeed with no remaining issues.

## Manual workflow

- Run from the repository root in these phases: `pnpm i --frozen-lockfile`, `pnpm build`, then `pnpm -r build-check`, `pnpm -r -F "@openai/*" dist:check`, `pnpm lint`, and `pnpm test`.
- The skill may execute the final validation phase in parallel, but every step above must still pass.
- Do not skip steps; stop and fix issues immediately when any step fails.
- Re-run the full stack after applying fixes so the commands execute with the same barriers and coverage.
- The runner sets `CI=1` and removes Codex-injected minimum-release-age overrides from every pnpm child process, so pnpm uses the repository policy and never waits for a TTY.

## Resources

### scripts/run.sh

- Executes the full verification sequence (including declaration checks) with fail-fast semantics.
- Keeps `pnpm i --frozen-lockfile` and `pnpm build` as barriers, then runs independent validation steps in parallel.
- Refuses to mutate dependencies in the primary worktree when it detects a Codex environment.
- Prefer this entry point to ensure the commands always run from the repo root with the expected fail-fast behavior.

### scripts/run.ps1

- Windows-friendly wrapper that runs the same verification sequence with fail-fast semantics.
- Use from PowerShell with execution policy bypass if required by your environment.
