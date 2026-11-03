# OpenAI Agents SDK

Build agents with the Codex harness in JavaScript and TypeScript. Define instructions, connect your tools, and run agents in your application. Codex runs model turns and keeps conversation history.

## Build agents in TypeScript

Connect your functions and application data. The SDK validates tool arguments, calls your functions, and parses structured results into typed values. You can also connect tools from MCP servers.

Use the [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) when you want OpenAI to run the agent and manage sessions and recovery.

## Install

Use Node.js 24. The `0.22.0-alpha.1` starter bundles include the built SDK, the compiled Codex runtime, and a JavaScript example. Follow the [installation guide](packages/agents/examples/guides/installation.md) to choose a bundle and run the example, or [add the SDK to an existing application](packages/agents/examples/guides/installation.md#add-the-sdk-to-an-existing-application).

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

Set `OPENAI_API_KEY` in your environment. From your project directory, run `npx tsx greeting.ts`.

The example makes a live model request. When the model asks for the greeting tool, the SDK calls your function and sends the result back to the model. The script prints a greeting such as `Hello, Ada!`.

## SDK guides

Start with the [native SDK overview](packages/agents/README.md), or choose a topic below.

| Guide | What you can do |
| --- | --- |
| [Agents and sessions](packages/agents/examples/guides/sessions.md) | Set instructions and a provider, stream events, and cancel turns. |
| [Tools and input](packages/agents/examples/guides/tools.md) | Declare functions and select tools for a turn. |
| [Output contracts](packages/agents/examples/guides/output.md) | Return plain text or validated structured output. |
| [MCP tools](packages/agents/examples/guides/mcp.md) | Connect tools from native or application-owned MCP servers. |
| [Remote executors](packages/agents/examples/guides/executors.md) | Connect a workspace and admit child agents. |
| [Session history and state](packages/agents/examples/guides/state.md) | Read conversation history and restore saved state. |
| [Native interactions](packages/agents/examples/guides/interactions.md) | Handle approvals, forms, and verification. |
| [Native API guide](packages/agents/NATIVE.md) | Browse all native SDK topics. |

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and tests. The [source build instructions](packages/agents/examples/guides/building.md) cover the native runtime and SDK packages.
