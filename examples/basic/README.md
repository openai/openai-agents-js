# Basic Examples

This directory contains small scripts that demonstrate features of the Agents SDK.
Run them with `pnpm` using the commands shown below.

- `hello-world.ts` – Basic agent that responds in haiku.
  ```bash
  pnpm -F basic start:hello-world
  ```
- `chat.ts` – Interactive CLI chat with a weather handoff.
  ```bash
  pnpm -F basic start:chat
  ```
- `stream-text.ts` – Stream plain text responses.
  ```bash
  pnpm -F basic start:stream-text
  ```
- `stream-items.ts` – Stream events including tool usage.
  ```bash
  pnpm -F basic start:stream-items
  ```
- `dynamic-system-prompt.ts` – Instructions picked dynamically per run.
  ```bash
  pnpm -F basic start:dynamic-system-prompt
  ```
- `lifecycle-example.ts` – Logs detailed lifecycle events and usage.
  ```bash
  pnpm -F basic start:lifecycle-example
  ```
- `agent-lifecycle-example.ts` – Minimal lifecycle hooks demo.
  ```bash
  pnpm -F basic start:agent-lifecycle-example
  ```
- `local-image.ts` – Send a local image to the agent.
  ```bash
  pnpm -F basic start:local-image
  ```
- `image-tool-output.ts` – Return an image from a tool and let the agent describe it.
  ```bash
  pnpm -F basic start:image-tool-output
  ```
- `file-tool-output.ts` – Return a file from a tool and have the agent summarize it.
  ```bash
  pnpm -F basic start:file-tool-output
  ```
- `remote-image.ts` – Send an image URL to the agent.
  ```bash
  pnpm -F basic start:remote-image
  ```
- `previous-response-id.ts` – Continue a conversation using
  `previousResponseId`.
  ```bash
  pnpm -F basic start:previous-response-id
  ```
- `json-schema-output-type.ts` – Structured output with JSON Schema.
  ```bash
  pnpm -F basic start:json-schema-output-type
  ```
- `tool-use-behavior.ts` – Require specific tools before final output.
  ```bash
  pnpm -F basic start:tool-use-behavior
  ```
- `tools.ts` – Simple tool calling example.
  ```bash
  pnpm -F basic start:tools
  ```
- `index.ts` – Basic handoff between two agents.
  ```bash
  pnpm -F basic start
  ```
