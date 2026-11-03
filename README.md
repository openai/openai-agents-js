# OpenAI Agents SDK

Build agents with the Codex harness in JavaScript and TypeScript. Define instructions, connect your tools, and run agents in your application. Codex runs model turns and keeps conversation history.

## Build agents in TypeScript

Connect your existing functions and application data. The SDK validates tool arguments, calls your functions, and parses structured results into typed values. You can also connect tools from MCP servers.

Use the [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) when you want OpenAI to run the agent and manage sessions and recovery.

## Install

Use Node.js 24. Download one `agents-starter-<version>-<platform>.tar.gz` bundle for your platform from [GitHub Releases](https://github.com/openai/openai-agents-js/releases). It includes the built SDK, the compiled native runtime, and a JavaScript example. Follow the [installation guide](packages/agents/NATIVE.md#install) to install dependencies and run the example. For an existing application, use the same four SDK tarballs with the [local dependency setup](packages/agents/NATIVE.md#add-the-sdk-to-an-existing-application).

**The first release with the Codex harness is not available yet.**

## Example

Add Zod 4 to your project with `npm install zod@4`, then save this as `greeting.ts`.

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

Set `OPENAI_API_KEY` in your environment, then run `npx tsx greeting.ts` from your project directory.

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

For the classic Agent and Runner APIs, see the [classic guide](packages/agents/CLASSIC.md).

## More examples

Use examples from the same release as your installed SDK. The [example guide](packages/agents/examples/README.md) covers setup and commands. Examples that call a model need `OPENAI_API_KEY`.

- [Function tools](packages/agents/examples/basic.ts). Call a greeting function.
- [Typed application context](packages/agents/examples/typed-context.ts). Use application context and return structured output.
- [Conversation and streaming](packages/agents/examples/conversation.ts). Stream a conversation and restore saved state.
- [Validated artifacts](packages/agents/examples/validated-artifact.ts). Validate an artifact before writing it.
- [All examples](packages/agents/examples/README.md). Find more workflows and their setup requirements.

## Get help

Use [GitHub issues](https://github.com/openai/openai-agents-js/issues) for questions, bug reports, and feedback. For security reports, follow [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and tests. The [source build instructions](packages/agents/NATIVE.md#build-from-source) cover the native runtime and SDK packages.
