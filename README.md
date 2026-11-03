# OpenAI Agents SDK

Build agents that call application tools and keep a conversation going. This branch embeds the Codex harness in the JavaScript and TypeScript SDK. Codex runs model turns and keeps conversation history in your application.

## Build agents in TypeScript

Connect your existing functions and application data. The SDK validates tool arguments, calls your functions, and parses structured results into typed values. You can also connect tools from MCP servers.

Use the [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) when you want OpenAI to run the agent and manage sessions and recovery.

## Install

Use Node.js 24 and follow the [source build instructions](packages/agents/NATIVE.md#build-from-source) from a checkout of `feat/codex-harness`. The build compiles the native addon and helper executables for your machine.

**The embedded harness is experimental.** The [npm package](https://www.npmjs.com/package/@openai/agents) installs the released SDK. In this checkout, use [`@openai/agents/classic`](packages/agents/CLASSIC.md) for the classic Agent and Runner APIs.

## Example

Save this as `packages/agents/examples/greeting.ts` in your checkout:

```ts
import { Agent, NativeProvider, tool } from '@openai/agents';
import { z } from 'zod';

async function main() {
  await using provider = new NativeProvider();
  const greeting = tool({
    name: 'greeting',
    description: 'Greet someone by name.',
    parameters: z.strictObject({ name: z.string() }),
    execute: ({ name }) => `Hello, ${name}!`,
  });

  const agent = new Agent({
    name: 'Assistant',
    instructions:
      'Use greeting to greet the user. ' +
      'After the tool returns, repeat its greeting in your final answer.',
    tools: [greeting],
    provider,
  });
  const result = await agent.run('Greet Ada.');
  console.log(result.finalOutput);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

Set `OPENAI_API_KEY` in your environment, then run `pnpm exec tsx packages/agents/examples/greeting.ts` from the repository root.

The example makes a live model request. When the model asks for the greeting tool, the SDK calls your function and sends the result back to the model. The script prints a greeting such as `Hello, Ada!`.

## SDK guides

Start with the [native SDK overview](packages/agents/README.md), or choose a topic below.

| Guide | What you can do |
| --- | --- |
| [Agent configuration](packages/agents/NATIVE.md#agents-and-sessions) | Set instructions, tools, and a provider. |
| [Function tools](packages/agents/NATIVE.md#input-tools-and-output) | Make TypeScript functions available with `tool`. |
| [MCP tools](packages/agents/NATIVE.md#remote-tools-and-children) | Connect an agent to tools from MCP servers. |
| [Sessions and state](packages/agents/NATIVE.md#history-and-state) | Continue conversations and restore saved state. |
| [Streaming](packages/agents/NATIVE.md#observations-and-interruption) | Read text and tool events as they arrive. |
| [Native API guide](packages/agents/NATIVE.md) | Look up runtime behavior and supported options. |

## More examples

After the source build, run an example such as `pnpm exec tsx packages/agents/examples/basic.ts` from the repository root. The examples that call a model need `OPENAI_API_KEY`. Use the [testing guide](packages/agents/TESTING.md) for scripted responses.

- [Function tools](packages/agents/examples/basic.ts). Call a greeting function.
- [Typed application context](packages/agents/examples/typed-context.ts). Use application context and return structured output.
- [Conversation and streaming](packages/agents/examples/conversation.ts). Stream a conversation and restore saved state.
- [Validated artifacts](packages/agents/examples/validated-artifact.ts). Validate an artifact before writing it.
- [All examples](packages/agents/examples/README.md). Find more workflows and their setup requirements.

## Get help

Use [GitHub issues](https://github.com/openai/openai-agents-js/issues) for questions, bug reports, and feedback. For security reports, follow [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and tests.
