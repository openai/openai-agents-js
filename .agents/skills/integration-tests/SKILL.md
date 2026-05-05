---
name: integration-tests
description: Run the integration-tests pipeline that depends on a local npm registry (Verdaccio). Use when asked to execute integration tests or local publish workflows in this repo.
---

# Integration Tests

## Overview

Run integration tests that require a local npm registry by starting `pnpm local-npm:start` in a background subprocess, executing the build/reset/publish/test pipeline in the main process, then cleanly shutting down the registry process and returning results.

## Workflow

### 1. Start the local registry (subprocess)

- Start a background process with `pnpm local-npm:start` and keep its session id so it can be stopped later.
- Wait until the registry is ready (look for a Verdaccio listen message or the default `http://localhost:4873` line). If no explicit ready line appears, wait a few seconds and proceed.
- If the port is already in use, note that an existing registry may be running and proceed only if it matches the expected local registry; otherwise stop it and restart.

### 2. Run the main pipeline (main process)

Run this exact sequence in the main process and capture the output:

```bash
pnpm i && pnpm build:ci && pnpm local-npm:reset && pnpm local-npm:publish && OPENAI_AGENTS_RUN_STORAGE_MOUNT_INTEGRATION=1 pnpm test:integration
```

- Use `pnpm build:ci` here so the skill validates the same serialized build path that GitHub Actions now uses, while still running the normal `prebuild` and `postbuild` lifecycle steps.
- Run `pnpm test:integration` with `OPENAI_AGENTS_RUN_STORAGE_MOUNT_INTEGRATION=1` so the optional sandbox storage mount coverage runs by default when this skill is used. This enables the local Azurite and MinIO smoke tests without changing the repository's plain `pnpm test:integration` default.

- Return the full success/failure outcome and a concise summary of the results.
- Always capture the stdout/stderr from `pnpm test:integration` and include it in the final response (trim obvious noise if extremely long) inside a fenced code block.
- Do not use watch mode.

#### If `pnpm local-npm:publish` fails

Troubleshoot using `integration-tests/README.md`, which lists the canonical recovery steps. If time is short, prioritize the fixes in the order given there and surface the exact error text in your response.

### 3. Clean up the registry process

- Send Ctrl+C to the registry subprocess and wait for it to exit.
- If it does not exit, terminate it by PID and confirm the port is free before finishing.

## Output expectations

- Always include the integration test results in the response.
- If any step fails, include the failing command, the error output summary, and the next recommended action.
