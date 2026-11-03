# Native Agents SDK for TypeScript

`@openai/agents` runs agents through an embedded Codex runtime. Give an Agent instructions and tools, then run it to get an answer. Use a Session when you need follow-up messages, streamed output, or a saved conversation.

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

The example requires the native addon and model credentials, such as `OPENAI_API_KEY`. `agent.run()` creates and closes its own Session; `await using` also closes this example's provider. Save it as a TypeScript file and run it with `tsx`. Use `agent.session()` for multiple turns and close it in `finally`.

Try the [greeting](examples/basic.ts) and [typed-context](examples/typed-context.ts) examples. See the [native guide](NATIVE.md) for API details and the [testing guide](TESTING.md) for scripted responses.

## Install

Use Node.js 24 and follow the [installation guide](NATIVE.md#install) to run the starter from a GitHub release. To add the SDK to an existing application, follow the [local dependency setup](NATIVE.md#add-the-sdk-to-an-existing-application). To work on the SDK itself, follow the [source build instructions](NATIVE.md#build-from-source).

For the classic API, see the [classic guide](CLASSIC.md).

## Sessions

Open a Session with `agent.session({ tools })` to replace that Session's opening tool declarations, as with Python's `agent.session(tools=...)`. Omit `tools` to inherit `agent.tools`; pass `[]` to open without those declarations. The SDK captures each opening before its first await, so concurrent Sessions can use the same tool names with different callbacks or MCP connections. It keeps the original Agent for application hooks and does not change `agent.tools`.

Opening overrides do not remove a separately supplied Environment or programmatic execution capabilities. MCP declarations still connect eagerly during opening. `agent.run()` does not accept `tools`; use a Session for opening overrides. Restore also uses the current opening declarations and bindings, subject to the existing checkpoint matching checks.

See [the tenant tools example](examples/opening-tools.ts) for two Sessions with separate callbacks.

Use `localStorage(path)` with an explicit Session to keep a supported root conversation in a trusted application directory. Retain `session.id` and reopen with `{ storage, resume: id }`, supplying current tools, context and provider. Always await Session close. Local profiles support managed function/manual tools and can admit native children through a current Environment and NativeAgents declaration. They cannot export portable state or use MCP, Apps/Plugins or Code Mode. Settled descendant history remains readable through the original root Session ID; reading it does not restart historical child runtimes. An open descendant with an unfinished turn, or an unknown tool effect, blocks reopening rather than replaying a callback.

See [the local-storage example](examples/local-storage.ts) and the [profile lifetime and cleanup contract](NATIVE.md#local-native-profiles).
