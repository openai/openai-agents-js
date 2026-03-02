# OpenAI Agents SDK (JavaScript/TypeScript)

[![npm version](https://badge.fury.io/js/@openai%2Fagents.svg)](https://badge.fury.io/js/@openai%2Fagents)
[![CI](https://github.com/openai/openai-agents-js/actions/workflows/test.yml/badge.svg)](https://github.com/openai/openai-agents-js/actions/workflows/test.yml)

The OpenAI Agents SDK is a lightweight yet powerful framework for building multi-agent workflows in JavaScript/TypeScript. It is provider-agnostic, supporting OpenAI APIs and more.

<img src="https://cdn.openai.com/API/docs/images/orchestration.png" alt="Image of the Agents Tracing UI" style="max-height: 803px;">

> [!NOTE]
> Looking for the Python version? Check out [OpenAI Agents SDK Python](https://github.com/openai/openai-agents-python).

## Core concepts

1. [**Agents**](https://openai.github.io/openai-agents-js/guides/agents): LLMs configured with instructions, tools, guardrails, and handoffs
1. **[Agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools) / [Handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/)**: Delegating to other agents for specific tasks
1. [**Tools**](https://openai.github.io/openai-agents-js/guides/tools/): Various Tools let agents take actions (functions, MCP, hosted tools)
1. [**Guardrails**](https://openai.github.io/openai-agents-js/guides/guardrails/): Configurable safety checks for input and output validation
1. [**Human in the loop**](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/): Built-in mechanisms for involving humans across agent runs
1. [**Sessions**](https://openai.github.io/openai-agents-js/guides/sessions/): Automatic conversation history management across agent runs
1. [**Tracing**](https://openai.github.io/openai-agents-js/guides/tracing/): Built-in tracking of agent runs, allowing you to view, debug and optimize your workflows
1. [**Realtime Agents**](https://openai.github.io/openai-agents-js/guides/voice-agents/quickstart/): Build powerful voice agents with full features

Explore the [`examples/`](https://github.com/openai/openai-agents-js/tree/main/examples) directory to see the SDK in action.

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
