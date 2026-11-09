# AI SDK Examples

These examples use the `aisdk()` helper from `@openai/agents-extensions/ai-sdk` to wrap models from the [AI SDK](https://www.npmjs.com/package/@ai-sdk/openai) and compatible providers. The Agents runtime runs the wrapped models.

## Available scripts

| Script | Command | Provider | Description |
| --- | --- | --- | --- |
| [index.ts](./index.ts) | `pnpm -F ai-sdk start` | OpenRouter (`OPENROUTER_API_KEY`) | Runs a parent agent that hands off a weather question to a child agent with a `get_weather` tool. |
| [gpt-5.ts](./gpt-5.ts) | `pnpm -F ai-sdk start:gpt-5` | OpenAI (`OPENAI_API_KEY`) | Runs one agent that uses `gpt-5.4` with custom provider options and must call the `get_weather` tool. |
| [retry.ts](./retry.ts) | `pnpm -F ai-sdk start:retry` | OpenAI (`OPENAI_API_KEY`) | Configures opt-in model retries for an agent that uses an AI SDK model. Logs retry decisions on transient failures. |
| [stream.ts](./stream.ts) | `pnpm -F ai-sdk start:stream` | OpenAI (`OPENAI_API_KEY`) | Streams text from an AI SDK model wrapped with `aisdk()`. |
| [image-tool-output.ts](./image-tool-output.ts) | `pnpm -F ai-sdk start:image-tool-output` | OpenAI (`OPENAI_API_KEY`) | Returns a `ToolOutputImage` from a tool call and asks `gpt-5.6-luna` to describe the image. |

## Prerequisites

- Follow the [classic example setup](../README.md) to install dependencies and build the SDK.
- Export the API keys shown for your script in the table above before you run it.

After you set the environment variable, run the corresponding command from the repository root. Each script prints the Agents runner's final output.

## Runtime requirements

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The following commands execute TypeScript directly with Node.js: `start:gpt-5`, `start:retry`, `start:stream`, `start:image-tool-output`.
