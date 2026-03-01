# OpenAI Agents SDK (JavaScript/TypeScript)

[![npm version](https://badge.fury.io/js/@openai%2Fagents.svg)](https://badge.fury.io/js/@openai%2Fagents)
[![CI](https://github.com/openai/openai-agents-js/actions/workflows/test.yml/badge.svg)](https://github.com/openai/openai-agents-js/actions/workflows/test.yml)

The OpenAI Agents SDK is a lightweight yet powerful framework for building multi-agent workflows in JavaScript/TypeScript. It is provider-agnostic, supporting OpenAI APIs and more.

<img src="https://cdn.openai.com/API/docs/images/orchestration.png" alt="Image of the Agents Tracing UI" style="max-height: 803px;">

> [!NOTE]
> Looking for the Python version? Check out [OpenAI Agents SDK Python](https://github.com/openai/openai-agents-python).

## Core concepts

1. **Agents**: LLMs configured with instructions, tools, guardrails, and handoffs.
2. **Agents as tools / Handoffs**: Delegating to other agents for specific tasks.
3. **Guardrails**: Configurable safety checks for input and output validation.
4. **Tracing**: Built-in tracking of agent runs, allowing you to view, debug, and optimize your workflows.

Explore the [`examples/`](https://github.com/openai/openai-agents-js/tree/main/examples) directory to see the SDK in action.

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

#### Experimental support:

- Cloudflare Workers with `nodejs_compat` enabled

[Check out the documentation](https://openai.github.io/openai-agents-js/guides/troubleshooting/) for more detailed information.

### Installation

```bash
npm install @openai/agents zod
```

### Run your first agent

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

Explore the [`examples/`](https://github.com/openai/openai-agents-js/tree/main/examples) directory to see the SDK in action.

## Acknowledgements

We'd like to acknowledge the excellent work of the open-source community, especially:

- [zod](https://github.com/colinhacks/zod) (schema validation)
- [Starlight](https://github.com/withastro/starlight)
- [vite](https://github.com/vitejs/vite) and [vitest](https://github.com/vitest-dev/vitest)
- [pnpm](https://pnpm.io/)
- [Next.js](https://github.com/vercel/next.js)

We're committed to building the Agents SDK as an open source framework so others in the community can expand on our approach.

For more details, see the [documentation](https://openai.github.io/openai-agents-js) or explore the [`examples/`](https://github.com/openai/openai-agents-js/tree/main/examples) directory.
