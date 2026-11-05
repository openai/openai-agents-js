# Codex runtime for the Agents SDK

<a name="native-agents-sdk-for-typescript"></a>`@openai/agents` runs agents through an embedded Codex runtime. Give an Agent instructions and tools, then run it to get an answer. Use a Session when you need follow-up messages, streamed output, or a saved conversation.

Applications import `@openai/agents` and its supported subpaths. Those imports load `@openai/agents-codex`, which contains the runtime, native helpers, migration adapters, and examples in this directory.

## Install

[Install the native SDK](examples/guides/installation.md) to run the release starter or add the SDK to an existing application. Use the [source build](examples/guides/building.md) for current branch features such as the [A2A adapter](A2A.md) and [supervised-worker controls](examples/supervised-worker/README.md).

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

The script makes a live model request and prints the reply. `agent.run()` creates and closes its own Session, and `await using` closes the provider.

Try the [greeting](examples/basic.ts) and [typed-context](examples/typed-context.ts) examples.

## SDK guides

- [Native API guide](NATIVE.md). Find the reference for sessions, output, tools, and native interactions.
- <a name="sessions"></a>[Sessions](examples/guides/sessions.md). Open a conversation and run multiple turns. Use [session configuration](examples/guides/session-configuration.md) to choose a provider, model, and tools.
- [Session history and state](examples/guides/state.md). Save a checkpoint, resume pending work, or choose a persistent store.
- [Native telemetry](examples/guides/telemetry.md). Trace one workflow or send native signals to a collector.
- [Examples](examples/README.md). Find runnable workflows and their setup requirements.
- [Testing](TESTING.md). Run scripted responses without model credentials.
- [Classic API](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/packages/agents/CLASSIC.md). Use the classic Agent and Runner APIs.
