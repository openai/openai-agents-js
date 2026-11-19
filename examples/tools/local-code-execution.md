# Local code execution with either provider

This example uses a local Python 3 interpreter to solve a numeric problem, streams SDK tool events, and returns a structured answer. It checks the command output and final numeric answer independently.

## Setup and run

Follow [Codex provider setup](./codex-provider.md) and install Python 3 on the host. The default provider uses `OPENAI_API_KEY`; Codex uses the stock CLI's authentication. Optional `OPENAI_MODEL` and `CODEX_MODEL` variables select the model for each mode.

`UnixLocalSandboxClient` runs commands as your current user and does not provide OS isolation. Use a trusted, disposable development host.

From the repository root:

```bash
pnpm -F tools exec tsx local-code-execution.ts
pnpm -F tools exec tsx local-code-execution.ts --codex
```

Both commands ask the model to run Python through the SDK's `exec_command` tool. They print `Verified local computation.` only after a tool call produces the expected number and the structured answer matches. The example closes the temporary session on success or failure.

The original [hosted code-interpreter example](./code-interpreter.ts) uses a Responses API managed container and emits `code_interpreter_call` events. This local example emits SDK shell-tool events. It does not provide hosted container IDs, persistence, or isolation.
