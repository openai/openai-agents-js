# OpenAI Agents SDK (JavaScript/TypeScript)

[![npm version](https://badge.fury.io/js/@openai%2Fagents.svg)](https://badge.fury.io/js/@openai%2Fagents)
[![CI](https://github.com/openai/openai-agents-js/actions/workflows/test.yml/badge.svg)](https://github.com/openai/openai-agents-js/actions/workflows/test.yml)

The OpenAI Agents SDK is a lightweight yet powerful framework for building multi-agent workflows in JavaScript/TypeScript. It is provider-agnostic, supporting OpenAI APIs and more.

<img src="https://cdn.openai.com/API/docs/images/orchestration.png" alt="Image of the Agents Tracing UI" style="max-height: 803px;">

> [!NOTE]
> Looking for the Python version? Check out [OpenAI Agents SDK Python](https://github.com/openai/openai-agents-python).

## Core concepts

1. **Agents**: LLMs configured with instructions, tools, guardrails, and handoffs.
2. **Handoffs**: Specialized tool calls for transferring control between agents.
3. **Guardrails**: Configurable safety checks for input and output validation.
4. **Tracing**: Built-in tracking of agent runs, allowing you to view, debug, and optimize your workflows.

Explore the [`examples/`](examples/) directory to see the SDK in action.

## Supported Features

- [x] **Multi-Agent Workflows**: Compose and orchestrate multiple agents in a single workflow.
- [x] **Tool Integration**: Seamlessly call tools/functions from within agent responses.
- [x] **Handoffs**: Transfer control between agents dynamically during a run.
- [x] **Structured Outputs**: Support for both plain text and schema-validated structured outputs.
- [x] **Streaming Responses**: Stream agent outputs and events in real time.
- [x] **Tracing & Debugging**: Built-in tracing for visualizing and debugging agent runs.
- [x] **Guardrails**: Input and output validation for safety and reliability.
- [x] **Parallelization**: Run agents or tool calls in parallel and aggregate results.
- [x] **Human-in-the-Loop**: Integrate human approval or intervention into workflows.
- [x] **Realtime Voice Agents**: Build realtime voice agents using WebRTC or WebSockets
- [x] **Local MCP Server Support**: Give an Agent access to a locally running MCP server to provide tools
- [x] **Separate optimized browser package**: Dedicated package meant to run in the browser for Realtime agents.
- [x] **Broader model support**: Use non-OpenAI models through the Vercel AI SDK adapter
- [ ] **Long running functions**: Suspend an agent loop to execute a long-running function and revive it later <img src="https://img.shields.io/badge/Future-lightgrey" alt="Future" style="width: auto; height: 1em; vertical-align: middle;">
- [ ] **Voice pipeline**: Chain text-based agents using speech-to-text and text-to-speech into a voice agent <img src="https://img.shields.io/badge/Future-lightgrey" alt="Future" style="width: auto; height: 1em; vertical-align: middle;">

## Get started

### Supported environments

- Node.js 22 or later
- Deno
- Bun

Experimental support:

- Cloudflare Workers with `nodejs_compat` enabled

[Check out the documentation](https://openai.github.io/openai-agents-js/guides/troubleshooting/) for more detailed information.

### Installation

```bash
npm install @openai/agents zod
```

The Agents SDK requires Zod v4; `npm install zod` pulls the latest v4.x by default.

## Hello world example

```js
import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant',
});

const result = await run(
  agent,
  'Write a haiku about recursion in programming.',
);
console.log(result.finalOutput);
// Code within the code,
// Functions calling themselves,
// Infinite loop's dance.
```

(_If running this, ensure you set the `OPENAI_API_KEY` environment variable_)

## Functions example

```js
import { z } from 'zod';
import { Agent, run, tool } from '@openai/agents';

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const agent = new Agent({
  name: 'Data agent',
  instructions: 'You are a data agent',
  tools: [getWeatherTool],
});

async function main() {
  const result = await run(agent, 'What is the weather in Tokyo?');
  console.log(result.finalOutput);
}

main().catch(console.error);
```

## Handoffs example

```js
import { z } from 'zod';
import { Agent, run, tool } from '@openai/agents';

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const dataAgent = new Agent({
  name: 'Data agent',
  instructions: 'You are a data agent',
  handoffDescription: 'You know everything about the weather',
  tools: [getWeatherTool],
});

// Use Agent.create method to ensure the finalOutput type considers handoffs
const agent = Agent.create({
  name: 'Basic test agent',
  instructions: 'You are a basic agent',
  handoffs: [dataAgent],
});

async function main() {
  const result = await run(agent, 'What is the weather in San Francisco?');
  console.log(result.finalOutput);
}

main().catch(console.error);
```

## Voice Agent

```js
import { z } from 'zod';
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents-realtime';

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const agent = new RealtimeAgent({
  name: 'Data agent',
  instructions:
    'You are a data agent. When you are asked to check weather, you must use the available tools.',
  tools: [getWeatherTool],
});

// Intended to run in the browser
const { apiKey } = await fetch('/path/to/ephemeral/key/generation').then(
  (resp) => resp.json(),
);
// Automatically configures audio input/output — start talking
const session = new RealtimeSession(agent);
await session.connect({ apiKey });
```

## Running Complete Examples

The [`examples/`](examples/) directory contains a series of examples to get started:

- `pnpm examples:basic` - Basic example with handoffs and tool calling
- `pnpm examples:agents-as-tools` - Using agents as tools for translation
- `pnpm examples:tools-web-search` - Using the web search tool
- `pnpm examples:tools-file-search` - Using the file search tool
- `pnpm examples:deterministic` - Deterministic multi-agent workflow
- `pnpm examples:parallelization` - Running agents in parallel and picking the best result
- `pnpm examples:human-in-the-loop` - Human approval for certain tool calls
- `pnpm examples:streamed` - Streaming agent output and events in real time
- `pnpm examples:streamed:human-in-the-loop` - Streaming output with human-in-the-loop approval
- `pnpm examples:routing` - Routing between agents based on language or context
- `pnpm examples:realtime-demo` - Framework agnostic Voice Agent example
- `pnpm examples:realtime-next` - Next.js Voice Agent example application

## The agent loop

When you call `Runner.run()`, the SDK executes a loop until a final output is produced.

1. The agent is invoked with the given input, using the model and settings configured on the agent (or globally).
2. The LLM returns a response, which may include tool calls or handoff requests.
3. If the response contains a final output (see below), the loop ends and the result is returned.
4. If the response contains a handoff, the agent is switched to the new agent and the loop continues.
5. If there are tool calls, the tools are executed, their results are appended to the message history, and the loop continues.

You can control the maximum number of iterations with the `maxTurns` parameter.

### Final output

The final output is the last thing the agent produces in the loop.

1. If the agent has an `outputType` (structured output), the loop ends when the LLM returns a response matching that type.
2. If there is no `outputType` (plain text), the first LLM response without tool calls or handoffs is considered the final output.

**Summary of the agent loop:**

- If the current agent has an `outputType`, the loop runs until structured output of that type is produced.
- If not, the loop runs until a message is produced with no tool calls or handoffs.

### Error handling

- If the maximum number of turns is exceeded, a `MaxTurnsExceededError` is thrown.
- If a guardrail is triggered, a `GuardrailTripwireTriggered` exception is raised.

## Documentation

To view the documentation locally:

```bash
pnpm docs:dev
```

Then visit [http://localhost:4321](http://localhost:4321) in your browser.

## Development

If you want to contribute or edit the SDK/examples:

1. Install dependencies

   ```bash
   pnpm install
   ```

2. Build the project

   ```bash
   pnpm build && pnpm -r build-check
   ```

3. Run tests and linter

   ```bash
   pnpm test && pnpm lint
   ```

See `AGENTS.md` and `CONTRIBUTING.md` for the full contributor guide.

## Acknowledgements

We'd like to acknowledge the excellent work of the open-source community, especially:

- [zod](https://github.com/colinhacks/zod) (schema validation)
- [Starlight](https://github.com/withastro/starlight)
- [vite](https://github.com/vitejs/vite) and [vitest](https://github.com/vitest-dev/vitest)
- [pnpm](https://pnpm.io/)
- [Next.js](https://github.com/vercel/next.js)

We're committed to building the Agents SDK as an open source framework so others in the community can expand on our approach.

For more details, see the [documentation](https://openai.github.io/openai-agents-js) or explore the [`examples/`](examples/) directory.
