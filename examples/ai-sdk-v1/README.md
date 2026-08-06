# AI SDK Example

This example shows how to run the Agents SDK with a model provided by the [AI SDK](https://www.npmjs.com/package/@ai-sdk/openai).

This example contains:

- [`index.ts`](./index.ts), the runnable example entrypoint.
- [`stream.ts`](./stream.ts), a streaming variant that writes text chunks as they arrive.
- [`ai-sdk-v1.ts`](./ai-sdk-v1.ts), the local AI SDK v1 adapter implementation that you can copy into your own project if you still need the older provider interface.

The example:

- Wraps the AI SDK `openai` provider with `aisdk` from `./ai-sdk-v1`.
- Creates a simple `get_weather` tool that returns a mock weather string.
- Defines a data agent that uses this model and tool.
- Runs a parent agent that hands off to the data agent to answer a weather question.

## Running the script

From the repository root, execute:

```bash
pnpm -F ai-sdk-v1 start
```

The script prints the final output produced by the runner.

To run the streaming variant:

```bash
pnpm -F ai-sdk-v1 start:stream
```
