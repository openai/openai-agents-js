# OpenAI Agents SDK (JavaScript/TypeScript)

[![npm version](https://badge.fury.io/js/@openai%2Fagents.svg)](https://badge.fury.io/js/@openai%2Fagents) [![CI](https://github.com/openai/openai-agents-js/actions/workflows/test.yml/badge.svg)](https://github.com/openai/openai-agents-js/actions/workflows/test.yml)

The OpenAI Agents SDK is a lightweight yet powerful framework for building multi-agent workflows in JavaScript/TypeScript. It is provider-agnostic, supporting OpenAI APIs and more.

<img src="https://cdn.openai.com/API/docs/images/orchestration.png" alt="Image of the Agents Tracing UI" style="max-height: 803px;">

> [!NOTE] 
> Looking for the Python version? Check out [OpenAI Agents SDK Python](https://github.com/openai/openai-agents-python).

## Core concepts

1. [**Agents**](https://openai.github.io/openai-agents-js/guides/agents): LLMs configured with instructions, tools, guardrails, and handoffs
1. [**Sandbox Agents**](https://openai.github.io/openai-agents-js/guides/sandbox-agents): Agents paired with a filesystem workspace and sandbox environment for longer-running work
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

### Run your first Sandbox Agent

[Sandbox Agents](https://openai.github.io/openai-agents-js/guides/sandbox-agents) are in beta. A sandbox agent can inspect files, run commands, apply patches, and carry workspace state across longer tasks.

```js
import { run } from '@openai/agents';
import { gitRepo, SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const agent = new SandboxAgent({
  name: 'Workspace Assistant',
  instructions: 'Inspect the sandbox workspace before answering.',
  defaultManifest: {
    entries: {
      repo: gitRepo({
        repo: 'openai/openai-agents-js',
        ref: 'main',
      }),
    },
  },
});

const result = await run(
  agent,
  'Inspect repo/README.md and summarize what this project does.',
  {
    sandbox: {
      client: new UnixLocalSandboxClient(),
    },
  },
);

console.log(result.finalOutput);
// This project provides a JavaScript/TypeScript SDK for building agent workflows.
```

(_If running this, ensure you set the `OPENAI_API_KEY` environment variable_)

### Run an agent without a sandbox

You can still use a regular `Agent` when your workflow does not need a filesystem workspace or sandbox lifecycle.

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


## FAQ

### What is OpenAI Agents SDK?

OpenAI Agents SDK is a lightweight yet powerful framework for building multi-agent workflows in JavaScript/TypeScript. Provider-agnostic, supports OpenAI APIs and more.

### Core Concepts

| Concept | Description |
|---------|-------------|
| **Agents** | LLMs configured with instructions, tools, guardrails, handoffs |
| **Sandbox Agents** | Agents with filesystem workspace + sandbox environment |
| **Agents as Tools** | Delegating to other agents for specific tasks |
| **Handoffs** | Multi-agent delegation mechanism |
| **Tools** | Functions, MCP, hosted tools for agent actions |
| **Guardrails** | Input/output validation, safety checks |
| **Human-in-the-Loop** | Built-in human involvement mechanisms |
| **Sessions** | Automatic conversation history management |
| **Tracing** | Track runs, debug, optimize workflows |
| **Realtime Agents** | Voice agents with full features |

### Supported Environments

- Node.js 22+
- Deno
- Bun
- Cloudflare Workers (experimental with `nodejs_compat`)

### LLM Providers

| Provider | Models |
|----------|--------|
| **OpenAI** | GPT-4o, GPT-4o-mini, o1, o3-mini |
| **Anthropic** | Claude 3.5 Sonnet, Claude 3 Opus |
| **Google** | Gemini 2.0 Flash, Gemini 1.5 Pro |
| **Azure OpenAI** | All OpenAI models via Azure |
| **Custom** | OpenAI-compatible APIs |

### How to install?

```bash
npm install @openai/agents zod
```

### Sandbox Agent Example

```js
import { run } from '@openai/agents';
import { SandboxAgent, gitRepo } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const agent = new SandboxAgent({
  name: 'Workspace Assistant',
  instructions: 'Inspect sandbox workspace before answering.',
  defaultManifest: {
    entries: { repo: gitRepo({ repo: 'openai/openai-agents-js', ref: 'main' }) }
  }
});

const result = await run(agent, 'Summarize README.md', {
  sandbox: { client: new UnixLocalSandboxClient() }
});
```

### Regular Agent Example

```js
import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant'
});

const result = await run(agent, 'Write a haiku about recursion');
```

### Why Choose OpenAI Agents SDK?

1. **Official SDK** - Built by OpenAI, first-class support
2. **Provider-agnostic** - Works with OpenAI, Anthropic, Google
3. **Multi-agent native** - Handoffs, agents as tools
4. **Production-ready** - Guardrails, tracing, sessions
5. **Sandbox support** - Filesystem workspace for complex tasks
6. **TypeScript-first** - Full type safety, modern DX
7. **Realtime voice** - Build voice agents easily

### Use Cases

- Multi-step research agents
- Code review automation
- Content generation pipelines
- Voice assistants
- Document processing workflows
- API orchestration agents

### License

MIT License

### Help Resources

- [Documentation](https://openai.github.io/openai-agents-js)
- [Examples](https://github.com/openai/openai-agents-js/tree/main/examples)
- [Python version](https://github.com/openai/openai-agents-python)
