# OpenAI Agents SDK

Build agents in TypeScript with an embedded Codex runtime. Give an Agent instructions and tools, run a model turn, and read its result. Open a Session when your application needs a conversation, streamed events, or saved state.

<a name="build-agents-in-typescript"></a>Use `@openai/agents` for the native SDK. Existing Agent and Runner applications can use the [classic API](packages/agents/CLASSIC.md). For OpenAI-managed sessions and recovery, see the [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview).

## Install

Use Node.js 24. Follow the [installation guide](packages/agents-codex/examples/guides/installation.md) to run the `0.22.0-alpha.1` starter for your platform or [add its packages to an existing application](packages/agents-codex/examples/guides/installation.md#add-the-sdk-to-an-existing-application). The starter includes the compiled runtime and a JavaScript example.

## Example

After installing the SDK in your application, set `OPENAI_API_KEY` in the server environment. Install Zod 4 with `npm install zod@4` and save the following file as `greeting.ts`.

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

Run `npx tsx greeting.ts` from your application directory. The model requests the greeting tool. The SDK calls your function and sends the result back to the model. The script prints the final answer, such as `Hello, Ada!`.

## SDK guides

| Task | Guide |
| --- | --- |
| Start a conversation, stream events, or cancel a Turn | [Agents and sessions](packages/agents-codex/examples/guides/sessions.md) |
| Choose a model, configure its provider, or compact model context | [Session configuration](packages/agents-codex/examples/guides/session-configuration.md) |
| Declare functions, select tools, or validate output | [Tools and input](packages/agents-codex/examples/guides/tools.md) and [output contracts](packages/agents-codex/examples/guides/output.md) |
| Connect an MCP server or a remote workspace | [MCP tools](packages/agents-codex/examples/guides/mcp.md) and [remote executors](packages/agents-codex/examples/guides/executors.md) |
| Restore a conversation or handle a pending request | [Session history and state](packages/agents-codex/examples/guides/state.md) and [native interactions](packages/agents-codex/examples/guides/interactions.md) |
| Supervise a worker or connect a remote Agent | [Supervised workers](packages/agents-codex/examples/supervised-worker/README.md) and [Agent2Agent (A2A)](packages/agents-codex/A2A.md) use the current [source build](packages/agents-codex/examples/guides/building.md). |

The [native SDK overview](packages/agents-codex/README.md) shows a minimal run. The [native guide index](packages/agents-codex/NATIVE.md) links to individual API topics.

## More examples

Use [the examples catalog](packages/agents-codex/examples/README.md) to choose a runnable program or a helper to import. Start with a [function tool](packages/agents-codex/examples/basic.ts), [typed application context](packages/agents-codex/examples/typed-context.ts), a [streamed conversation](packages/agents-codex/examples/conversation.ts), or a [validated artifact](packages/agents-codex/examples/validated-artifact.ts).

## Get help

Use [GitHub issues](https://github.com/openai/openai-agents-js/issues) for questions, bug reports, and feedback. For security reports, follow [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and tests. The [source build instructions](packages/agents-codex/examples/guides/building.md) cover the native runtime and SDK packages.
