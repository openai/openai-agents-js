# OpenAI Agents SDK

Build agents in TypeScript with an embedded Codex runtime. Give an Agent instructions and tools, run a model turn, and read its result. Open a Session when your application needs a conversation, streamed events, or saved state.

<a name="build-agents-in-typescript"></a>Use `@openai/agents` for the native SDK. Existing Agent and Runner applications can use the [classic API](packages/agents/CLASSIC.md). For OpenAI-managed sessions and recovery, see the [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview).

## Install

Use Node.js 24. Follow the [installation guide](examples/codex/guides/installation.md) to run the `0.22.0-alpha.1` starter for your platform or [add its packages to an existing application](examples/codex/guides/installation.md#add-the-sdk-to-an-existing-application). The starter includes the compiled runtime and a JavaScript example.

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

These guides follow the current source checkout. Features marked as requiring a source build are newer than the `0.22.0-alpha.1` starter. For that starter, use the [documentation at its release tag](https://github.com/openai/openai-agents-js/blob/v0.22.0-alpha.1/README.md).

| Task | Guide |
| --- | --- |
| Start a conversation, stream events, or cancel a Turn | [Agents and sessions](examples/codex/guides/sessions.md) |
| Choose a model, configure its provider, or compact model context | [Session configuration](examples/codex/guides/session-configuration.md) |
| Declare functions, select tools, or validate output | [Tools and input](examples/codex/guides/tools.md) and [output contracts](examples/codex/guides/output.md) |
| Run local commands or control workspace access | [Local execution](examples/codex/guides/local-execution.md) and [workspace grants](examples/codex/guides/workspace-grants.md) |
| Prepare model requests or inspect traces | [Request preparation](examples/codex/guides/request-preparation.md), [request metadata](examples/codex/guides/request-metadata.md), and [telemetry](examples/codex/guides/telemetry.md) |
| Connect an MCP server or a remote workspace | [MCP tools](examples/codex/guides/mcp.md) and [remote executors](examples/codex/guides/executors.md) |
| Restore a conversation or handle a pending request | [Session history and state](examples/codex/guides/state.md) and [native interactions](examples/codex/guides/interactions.md) |
| Supervise a worker or connect a remote Agent | [Supervised workers](examples/codex/supervised-worker/README.md) and [Agent2Agent (A2A)](packages/agents-codex/A2A.md) use the current [source build](examples/codex/guides/building.md). |

The [native SDK overview](packages/agents-codex/README.md) shows a minimal run. The [native guide index](packages/agents-codex/NATIVE.md) links to individual API topics.

## More examples

Use [the Codex examples catalog](examples/codex/README.md) to choose a runnable program or a helper to import. Start with a [function tool](examples/codex/basic.ts), [typed application context](examples/codex/typed-context.ts), a [streamed conversation](examples/codex/conversation.ts), or a [validated artifact](examples/codex/validated-artifact.ts). The retained SDK examples are in [examples/classic](examples/classic/README.md).

## Get help

Use [GitHub issues](https://github.com/openai/openai-agents-js/issues) for questions, bug reports, and feedback. For security reports, follow [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and tests. The [source build instructions](examples/codex/guides/building.md) cover the native runtime and SDK packages.
