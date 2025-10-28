# Agent Pattern Examples

This directory contains small scripts that demonstrate different agent patterns.
Run them with `pnpm` using the commands shown below.

- `agents-as-tools.ts` – Orchestrate translator agents using them as tools.
  ```bash
  pnpm examples:agents-as-tools
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
