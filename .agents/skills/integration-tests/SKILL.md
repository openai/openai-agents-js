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
pnpm i && pnpm build && pnpm local-npm:reset && pnpm local-npm:publish && pnpm test:integration
```

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
