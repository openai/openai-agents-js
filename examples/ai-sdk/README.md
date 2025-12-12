# AI SDK Examples

These examples show how to wrap models from the [AI SDK](https://www.npmjs.com/package/@ai-sdk/openai) (and compatible providers) with the `aisdk()` helper from `@openai/agents-extensions`, then run them inside the Agents runtime.

## Available scripts

| Script                                         | Command                                  | Provider                          | Description                                                                                                 |
| ---------------------------------------------- | ---------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [index.ts](./index.ts)                         | `pnpm -F ai-sdk start`                   | OpenRouter (`OPENROUTER_API_KEY`) | Runs a parent agent that hands off a weather question to a child agent equipped with a `get_weather` tool.  |
| [gpt-5.ts](./gpt-5.ts)                         | `pnpm -F ai-sdk start:gpt-5`             | OpenAI (`OPENAI_API_KEY`)         | Shows a single agent that must call the `get_weather` tool using `gpt-5-mini` with custom provider options. |
| [stream.ts](./stream.ts)                       | `pnpm -F ai-sdk start:stream`            | OpenAI (`OPENAI_API_KEY`)         | Demonstrates streaming text output from an AI SDK model wrapped with `aisdk()`.                             |
| [image-tool-output.ts](./image-tool-output.ts) | `pnpm -F ai-sdk start:image-tool-output` | OpenRouter (`OPENROUTER_API_KEY`) | Returns a `ToolOutputImage` from a tool call and asks the model to describe the image.                      |

## Prerequisites

- Run `pnpm install` at the repo root.
- Export the relevant API key(s) shown in the table above before running a script.

Once the environment variable is set, run the corresponding command from the repository root. Each script prints the final output produced by the Agents runner.
