# Codex runtime for the Agents SDK

`@openai/agents` runs agents through an embedded Codex runtime. Give an Agent instructions and tools, then run it to get an answer. Use a Session when you need follow-up messages, streamed output, or a saved conversation.

`@openai/agents-codex` owns the native TypeScript runtime, addon and helper assets, migration adapters, scripted testing helpers, and experimental native integrations. The public `@openai/agents` package delegates its native entries to this package. Applications use `@openai/agents` and its supported subpaths.

## Install

[Install the native SDK](examples/guides/installation.md) to run the release starter or add the SDK to an existing application. See [Build from source](examples/guides/building.md) if you work on the SDK itself.

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
- <a name="sessions"></a>[Sessions](examples/guides/sessions.md). Open a session, choose its tools, and run multiple turns.
- [Session history and state](examples/guides/state.md). Save a checkpoint or reopen a local profile.
- [Examples](examples/README.md). Find runnable workflows and their setup requirements.
- [Testing](TESTING.md). Run scripted responses without model credentials.
- [Classic API](../agents/CLASSIC.md). Use the classic Agent and Runner APIs.
