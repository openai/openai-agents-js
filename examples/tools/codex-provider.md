# Codex as a model provider

This example has been running the same workspace task through the default OpenAI provider or `CodexProvider` by creating `hello.txt`, reading it, and reporting `Hello from Codex`. Both modes have been sharing the agent instructions, user prompt, file check, and final-output check.

## Setup

The example has been using the Node.js and pnpm versions in [CONTRIBUTING.md](../../CONTRIBUTING.md#getting-started).

From the repository root, install and build the SDK.

```sh
pnpm install
pnpm build
```

## OpenAI mode

The default provider has been using `OPENAI_API_KEY` for API authentication. The example has been providing two SDK function tools with access only to the temporary `hello.txt` file.

```sh
pnpm -F tools exec tsx codex-provider.ts openai
```

To choose a model, use the environment variable for that mode.

```sh
OPENAI_MODEL=gpt-5.4 pnpm -F tools exec tsx codex-provider.ts openai
```

## Codex mode

`CodexProvider` has been using stock Codex through `@openai/codex-sdk` 0.166.0 or newer. Codex has been creating and reading `hello.txt` with its native shell, without an MCP server. Codex has been handling authentication and configuration separately from the Agents SDK's OpenAI client. Use an existing Codex CLI login, `CODEX_API_KEY`, or `OPENAI_API_KEY` from the process environment.

```sh
pnpm -F tools exec tsx codex-provider.ts codex
```

To choose a model, use the environment variable for that mode.

```sh
CODEX_MODEL=gpt-5.4 pnpm -F tools exec tsx codex-provider.ts codex
```

Without `CODEX_MODEL`, the example has been leaving model selection to Codex. For the temporary directory, it has been selecting `workspace-write`, skipping the Git repository check, and setting the approval policy to `never` for unattended execution. Codex has been applying its own configuration and sandbox rules. On Linux, use a host permitting Codex to start its Bubblewrap sandbox. For sandbox startup failures in restricted containers, run the example on a compatible host with `workspace-write` enabled.

## Switching an application

The example has been selecting Codex through `Runner` configuration.

```ts
import { Runner } from '@openai/agents';
import { CodexProvider } from '@openai/agents-extensions/experimental/codex';

const runner = new Runner({
  modelProvider: new CodexProvider({
    threadOptions: {
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    },
  }),
  tracingDisabled: true,
});
```

OpenAI mode has been omitting `modelProvider` and supplying the application-owned SDK tools. Codex mode has been omitting those SDK tools and letting Codex execute its native tools. Both modes have been disabling SDK tracing; Codex has been handling its own diagnostics.

The provider has been passing agent instructions to Codex as developer instructions. It has been accepting text conversations and returning Codex's final text and reported token usage. It has been rejecting SDK tools, handoffs, structured output, multimodal input, response or conversation IDs, prompt IDs, and unsupported model settings. The Runner has been supporting `modelSettings.timeoutMs` for Codex calls. SDK tool approvals and guardrails have been governing SDK-executed tools; Codex has been governing its native tool execution. Each model call has been starting a fresh CLI thread. Continued conversations have been sending prior user and assistant text as prompt context. Codex has been managing its own session files. Streaming has been emitting the final text in one chunk after the turn completes.

For input checks that must finish before Codex acts, use `runInParallel: false`. Completed workspace writes can survive a failure, a timeout, cancellation, or output guardrail rejection.

## Verification

Each run has been creating a fresh temporary workspace, checking the actual file contents and the final response, printing `Verified hello.txt: Hello from Codex`, and removing the workspace in a `finally` block. A failure has been producing a nonzero exit code.
