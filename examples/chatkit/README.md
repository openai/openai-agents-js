# ChatKit UI Example

This example shows how to stream ChatKit-compatible thread events from the Agents SDK using the Responses API, plus a minimal ChatKit server that powers the ChatKit React UI. Note that this demo has been verified to work only with OpenAI's Responses API.

## Setup

```bash
pnpm -C examples/chatkit install
```

Set your API key:

```bash
export OPENAI_API_KEY=YOUR_KEY
```

Optionally set a ChatKit domain key (defaults to `local-dev`):

```bash
export NEXT_PUBLIC_CHATKIT_DOMAIN_KEY=YOUR_DOMAIN_KEY
```

## Run

```bash
pnpm -C examples/chatkit dev
```

Open http://localhost:3000.

## What it demonstrates

- A minimal ChatKit server at `/api/chatkit` for the ChatKit React UI.
- ChatKit-style streaming via the single `/api/chatkit` endpoint.
- Annotations, reasoning workflow tasks, and generated images (when the model emits them).
- Tool calls and handoffs via the demo agent in `src/app/lib/agents.ts`.

## Tips

- Ask for sources ("cite your sources") to see annotation updates.
- Ask for an image ("generate an image of...") to see image generation items.
- Reasoning summaries require a model that supports them and the agent config in `src/app/lib/agents.ts`.
- Ask "tool test: 2 \* 4" to trigger the demo tool call.
- Ask "handoff test" or a billing question to trigger the billing handoff.
- Set `CHATKIT_ENABLE_CODEX_HANDOFF=1` to enable the Codex handoff (requires `CODEX_API_KEY` or `OPENAI_API_KEY`, plus the Codex CLI in your PATH or `CODEX_PATH`).

## Running with Codex tools

The example can optionally attach the Codex tool at runtime when both conditions are met:

- `EXAMPLES_CHATKIT_CODEX_ENABLED=1` is set.
- The Codex optional dependency is available.

To run in dev with Codex enabled:

```bash
EXAMPLES_CHATKIT_CODEX_ENABLED=1 DEBUG=openai* pnpm -F chatkit dev
```
