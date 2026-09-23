# Agent Pattern Examples

This directory contains small scripts that demonstrate different agent patterns. Run them with `pnpm` using the commands shown below.

- `agents-as-tools.ts` – Orchestrate translator agents using them as tools.
  ```bash
  pnpm examples:agents-as-tools
  ```
- `agents-as-tools-structured.ts` – Use structured tool input with `Agent.asTool()`.
  ```bash
  pnpm examples:agents-as-tools-structured
  ```
- `agents-as-tools-conditional.ts` – Enable language tools based on user preference.
  ```bash
  pnpm examples:agents-as-tools-conditional
  ```
- `deterministic.ts` – Fixed agent flow with gating and quality checks.
  ```bash
  pnpm examples:deterministic
  ```
- `forcing-tool-use.ts` – Require specific tools before final output.
  ```bash
  pnpm -F agent-patterns start:forcing-tool-use
  ```
- `human-in-the-loop.ts` – Manually approve certain tool calls.
  ```bash
  pnpm examples:human-in-the-loop
  ```
- `human-in-the-loop-server.ts` – Keep approval snapshots on the server and accept only owner-authorized decisions. This CLI simulates a client and server in one process; it is not an HTTP service. The store is confined to one event loop and requires a complete decision batch. Consumed requests cannot be retried, including after failure or cancellation. Production applications need authentication, request protections, bounded storage retention, atomic owner-checked consumption in shared storage, and recovery that reconciles tool side effects.
  ```bash
  pnpm -F agent-patterns start:human-in-the-loop-server
  ```
- `human-in-the-loop-stream.ts` – Streaming version of human approval.
  ```bash
  pnpm examples:streamed:human-in-the-loop
  ```
- `input-guardrails.ts` – Reject unwanted requests with guardrails.
  ```bash
  pnpm examples:input-guardrails
  ```
- `llm-as-a-judge.ts` – Evaluate and iterate on story outlines.
  ```bash
  pnpm -F agent-patterns start:llm-as-a-judge
  ```
- `output-guardrails.ts` – Block unsafe output using guardrails.
  ```bash
  pnpm examples:output-guardrails
  ```
- `parallelization.ts` – Run translations in parallel and pick the best.
  ```bash
  pnpm examples:parallelization
  ```
- `routing.ts` – Route messages to language-specific agents.
  ```bash
  pnpm examples:routing
  ```
- `streamed.ts` – Stream agent output, both text and events.
  ```bash
  pnpm examples:streamed
  ```
- `streaming-guardrails.ts` – Check streaming output against guardrails.
  ```bash
  pnpm -F agent-patterns start:streaming-guardrails
  ```

## Runtime requirements

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The following commands execute TypeScript directly with Node.js: `start:agents-as-tools`, `start:agents-as-tools-conditional`, `start:agents-as-tools-structured`, `start:agents-as-tools-streaming`, `start:deterministic`, `start:forcing-tool-use`, `start:human-in-the-loop-stream`, `start:human-in-the-loop`, `start:input-guardrails`, `start:llm-as-a-judge`, `start:output-guardrails`, `start:parallelization`, `start:routing`, `start:streamed`, `start:streaming-guardrails`.
