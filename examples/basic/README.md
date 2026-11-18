# Basic Examples

This directory contains small scripts that demonstrate features of the Agents SDK. Run them with `pnpm` using the commands shown below.

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
- `stream-ws.ts` – Responses WebSocket streaming with tools, HITL approval, and `previousResponseId`.
  ```bash
  pnpm -F basic start:stream-ws
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
- `previous-response-id.ts` – Continue a conversation using `previousResponseId`.
  ```bash
  pnpm -F basic start:previous-response-id
  ```
- `retry.ts` – Configure retries for transient model failures and log each retry decision.
  ```bash
  pnpm -F basic start:retry
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

## Runtime requirements

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The following commands execute TypeScript directly with Node.js: `start`, `start:agent-lifecycle-example`, `start:chat`, `start:dynamic-system-prompt`, `start:hello-world`, `start:hello-world-gpt-5`, `start:lifecycle-example`, `start:local-image`, `start:image-tool-output`, `start:file-tool-output`, `start:previous-response-id`, `start:retry`, `start:remote-image`, `start:remote-pdf`, `start:stream-items`, `start:stream-ws`, `start:stream-text`, `start:json-schema-output-type`, `start:tool-use-behavior`, `start:tools`, `start:reasoning`, `start:local-file`, `start:conversations`.

## Running locally with Codex

The default commands have been keeping their original provider. In the examples below, `--codex` has been switching to the stock Codex CLI. These paths need access to Codex, but no cloud sandbox, prompt store, or third-party connector.

From the repo root:

```sh
pnpm -F basic start:previous-response-id --local --codex --stream
pnpm -F basic start:local-file --codex
pnpm -F basic start:image-tool-output --codex --file media/image_bison.jpg
```

The first command has been remembering the country between two turns using a local SDK session. It hasn't been creating a hosted response ID. The [conversations example](./conversations.ts) has also been accepting `--local --codex`.

The second has been reading the **text** of the bundled PDF via Poppler's `pdftotext`. Install Poppler first (`poppler-utils` on Debian/Ubuntu, `poppler` with Homebrew). The [file tool](./file-tool-output.ts) has been returning the same extracted text from a function call. Neither path has been interpreting pictures or doing OCR.

The third has been passing a JPEG returned by an SDK tool to Codex. Omitting `--file` has been using the sample's public URL. In [remote-image](./remote-image.ts) and [remote-pdf](./remote-pdf.ts), `--codex --file PATH` has likewise been reading a local JPEG or PDF instead of downloading anything. Paths passed to the commands above have been resolving from `examples/basic`, the selected pnpm package. The provider hasn't been fetching arbitrary URLs from prompts.
