# AI SDK Example

This example shows how to run the Agents SDK with a model provided by the [AI SDK](https://www.npmjs.com/package/@ai-sdk/openai).

The [ai-sdk-model.ts](./ai-sdk-model.ts) script:

- Wraps the AI SDK `openai` provider with `aisdk` from `@openai/agents-extensions`.
- Creates a simple `get_weather` tool that returns a mock weather string.
- Defines a data agent that uses this model and tool.
- Runs a parent agent that hands off to the data agent to answer a weather question.

## Running the script

From the repository root, execute:

```bash
pnpm -F ai-sdk-v1 start
```

The script prints the final output produced by the runner.
