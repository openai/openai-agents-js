# Codex runtime for the Agents SDK

<a name="native-agents-sdk-for-typescript"></a>`@openai/agents` runs agents through an embedded Codex runtime. Give an Agent instructions and tools, then run it to get an answer. Use a Session when you need follow-up messages, streamed output, or a saved conversation.

Applications import `@openai/agents` and its supported subpaths. Those imports load `@openai/agents-codex`, which contains the runtime and native helpers. Runnable examples live in the repository's [`examples/codex`](../../examples/codex/README.md) directory.

## Install

[Install the native SDK](../../examples/codex/guides/installation.md) to run the release starter or add the SDK to an existing application. The release includes the [A2A adapter](A2A.md) and [supervised-worker controls](../../examples/codex/supervised-worker/README.md). Run repository examples from a matching [source checkout](../../examples/codex/guides/building.md).

## Run an agent

After installing the SDK, set `OPENAI_API_KEY` in your environment and save this example as `hello.ts` in your application.

```ts
import { Agent, NativeProvider } from '@openai/agents';

async function main() {
  await using provider = new NativeProvider();
  const agent = new Agent({ instructions: 'Answer clearly.', provider });
  const result = await agent.run('Hello');
  console.log(result.finalOutput);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

From your application directory, run the example.

```sh
npx tsx hello.ts
```

The script makes a live model request and prints the reply. `agent.run()` closes the session it opens. `await using` closes the provider when `main()` returns.

Try the [greeting](../../examples/codex/basic.ts) and [typed-context](../../examples/codex/typed-context.ts) examples.

## Hosted prompts

Native Agents have been using `hostedPrompt` to select a stored Responses prompt. A static reference has been supplying fixed variables. A factory has been deriving variables from each request's application context.

Prerequisites: the matching native v1 build, `OPENAI_API_KEY`, and `OPENAI_PROMPT_ID` for a project prompt with a `topic` variable.

```ts
import { Agent, NativeProvider } from '@openai/agents';

async function main() {
  const promptId = process.env.OPENAI_PROMPT_ID;
  if (!promptId) throw new Error('OPENAI_PROMPT_ID is required');
  await using provider = new NativeProvider();

  const fixed = new Agent({
    hostedPrompt: { id: promptId, variables: { topic: 'native' } },
    provider,
  });
  console.log((await fixed.run('Give one example.')).finalOutput);

  const contextual = new Agent<{ topic: string }>({
    hostedPrompt: ({ context }) => ({
      id: promptId,
      variables: { topic: context.topic },
    }),
    provider,
  });
  const result = await contextual.run('Give one example.', {
    context: { topic: 'history' },
  });
  console.log(result.finalOutput);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

An optional `version` string in the reference has been selecting a specific prompt version. An asynchronous factory has been working through the same callback path.

Omitted settings have been inheriting prompt values. Explicit settings have been overriding them:

| Setting | Omitted | Explicit |
| --- | --- | --- |
| `model` | Stored prompt's model | The supplied model |
| `instructions` | Stored prompt's instructions | The supplied text, including `''` |
| `tools` | Stored prompt's tools | The declared native tools, including `[]` |

Native tool selections and policies have also been overriding inherited prompt tools, including explicit empty selections. Combining `hostedPrompt` with `modelSettings.extraBody.prompt` has been raising a configuration error.

After restoration, the current Agent declaration has been supplying the prompt reference or factory. Before dispatch, the SDK has been rejecting new explicit settings for fields previously inherited from the prompt.

## Hosted MCP approvals

`hostedMcp` has been declaring a remote Model Context Protocol (MCP) server for the Responses provider. The provider has been executing its tools, and the application has been deciding approval requests through `onApprovalRequest`.

Prerequisites: the matching native v1 build, `OPENAI_API_KEY`, a Responses-capable model selected through `OPENAI_MODEL`, and a remote MCP endpoint in `MCP_SERVER_URL`. Optional `MCP_AUTHORIZATION` has been supplying the server authorization value.

```ts
import { Agent, NativeProvider, hostedMcp } from '@openai/agents';

async function main() {
  const model = process.env.OPENAI_MODEL;
  const serverUrl = process.env.MCP_SERVER_URL;
  if (!model || !serverUrl)
    throw new Error('OPENAI_MODEL and MCP_SERVER_URL are required');
  const authorization = process.env.MCP_AUTHORIZATION;
  await using provider = new NativeProvider();
  const docs = hostedMcp({
    serverLabel: 'docs',
    serverUrl,
    ...(authorization ? { authorization } : {}),
    requireApproval: 'always',
    allowedTools: ['lookup'],
    onApprovalRequest: ({ name }) => ({ approve: name === 'lookup' }),
  });
  const agent = new Agent({
    model,
    provider,
    instructions: 'Use docs for the requested lookup.',
    tools: [docs],
  });
  console.log((await agent.run('Look up MCP approval behavior.')).finalOutput);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

The example's application policy has been approving `lookup`, and the Agent has been printing its final answer. An omitted `requireApproval` has been retaining the Classic default, `'never'`. Explicit `allowedTools` and `allowedCallers` have been narrowing the server's admitted calls before the application callback.

Without `onApprovalRequest`, a declaration requiring approval has been exposing the existing live manual request through `turn.wait({ until: 'manual_tool' })`, `docs.match(request)`, and `session.respond(request.reply({ approve, reason }))`. `Agent.run()` without an interaction handler has been raising `InteractionRequired`.

Server configuration and credentials have been remaining fixed for each Session. Same-configuration callback replacements have been working through `Session.update`; configuration changes have been requiring a new Session. Explicit tool selections, including `tools: []`, have been narrowing which servers reach the provider.

Pending approvals have been requiring live replies: `Session.suspend()` has been rejecting them without consuming the pending request. External restoration has also been rejecting positive MCP approval receipts because portable state has not been carrying live approval authority.

`Session.compact({ summary })` has been preserving approvals within the current live Session. Persistent resume has been forwarding completed MCP results without replaying saved positive approval decisions.

## SDK guides

- [Architecture](../../examples/codex/guides/architecture.md). Understand the native runtime, how it differs from v0, and which adoption route fits your application.
- [Native API guide](NATIVE.md). Find the reference for sessions, output, tools, and native interactions.
- [Decisions](../../examples/codex/guides/decisions.md). Make typed decisions directly or bind a replaceable provider to Agent callbacks.
- <a name="sessions"></a>[Sessions](../../examples/codex/guides/sessions.md). Open a conversation and run multiple turns. Use [session configuration](../../examples/codex/guides/session-configuration.md) to choose a provider, model, and tools.
- [Session history and state](../../examples/codex/guides/state.md). Save a checkpoint, resume pending work, or choose a persistent store.
- [Native telemetry](../../examples/codex/guides/telemetry.md). Trace one workflow or send native signals to a collector.
- [Native voice](../../examples/codex/guides/native-voice.md). Use Session-owned Realtime, custom adapters, and accepted-text speech pipelines.
- [Portable Realtime](PORTABLE_CONTROL.md). Connect a browser, React Native app, Worker, or Node.js process directly to Realtime with the source-built controller.
- [Native voice with Twilio](../../examples/codex/guides/realtime-twilio.md). Connect an authenticated Media Stream to an Agent Session.
- [Examples](../../examples/codex/README.md). Find runnable workflows and their setup requirements.
- [Testing](TESTING.md). Run scripted responses without model credentials.
- [Classic API](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/packages/agents/CLASSIC.md). Use the classic Agent and Runner APIs.
