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

The example requires the native addon and model credentials, such as `OPENAI_API_KEY`. `agent.run()` creates and closes its own Session. `await using` closes the provider. Save the example as a TypeScript file and run it with `tsx`. For multiple turns, use `agent.session()` and close the Session in `finally`.

Try the [greeting](examples/basic.ts) and [typed-context](examples/typed-context.ts) examples. See the [native guide](NATIVE.md) for API details and the [testing guide](TESTING.md) for scripted responses.

## Install

Use Node.js 24 and follow the [installation guide](NATIVE.md#install) to run the starter from a GitHub release. To add the SDK to an existing application, follow the [local dependency setup](NATIVE.md#add-the-sdk-to-an-existing-application). To work on the SDK itself, follow the [source build instructions](NATIVE.md#build-from-source).

For the classic API, see the [classic guide](CLASSIC.md).

## Sessions

Open a Session with `agent.session({ tools })` to replace its initial tool declarations, as with Python's `agent.session(tools=...)`. Omit `tools` to inherit `agent.tools`. Pass `[]` to open without those declarations. The SDK captures each Session's opening configuration before its first await. Concurrent Sessions can use the same tool names with different callbacks or MCP connections. Application hooks keep the original Agent, and the SDK does not change `agent.tools`.

Opening overrides do not remove a separately supplied Environment or programmatic execution capabilities. MCP declarations still connect during opening. To override tools, use a Session. `agent.run()` does not accept `tools`. Restore uses the current opening declarations and bindings after the existing checkpoint matching checks.

See [the tenant tools example](examples/opening-tools.ts) for two Sessions with separate callbacks.

Use `localStorage(path)` with an explicit Session to keep a supported root conversation in a trusted application directory. Retain `session.id`. To reopen the conversation, pass `{ storage, resume: id }` with current tools, context, and provider. Always await Session close.

Local profiles support managed function and manual tools. With a current Environment and NativeAgents declaration, local profiles can also admit native children. Local profiles cannot export portable state or use MCP, Apps, Plugins, or Code Mode. You can read settled descendant history through the original root Session ID without restarting historical child runtimes. An open descendant with an unfinished turn, or an unknown tool effect, blocks reopening. The SDK does not replay the callback.

See [the local-storage example](examples/local-storage.ts) and the [profile lifetime and cleanup contract](NATIVE.md#local-native-profiles).
