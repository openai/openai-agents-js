# Native scripted tests

Use `@openai/agents/testing` in Node to run a native Agent against scripted Responses events. The helper starts one loopback HTTP endpoint and supplies an ordinary `NativeProvider`. The native engine still executes the Agent loop and declared functions.

Use Node.js 24 with matching [SDK packages and native runtime](../../examples/codex/guides/installation.md). The native engine still needs its addon and packaged helpers, even without model credentials. Install Zod 4 in your application and save the following example as `scripted-test.mts`.

```ts
import assert from 'node:assert/strict';
import { Agent, tool } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

await withScriptedResponses(
  [
    [toolCall('lookup', { key: 'a' }, { callId: 'lookup-1' })],
    [text('Found it.')],
  ],
  async (peer) => {
    const lookedUp: string[] = [];
    const agent = new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5.5',
      provider: peer.provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({ key: z.string() }),
          execute: ({ key }) => {
            lookedUp.push(key);
            return `found:${key}`;
          },
        }),
      ],
    });
    assert.equal((await agent.run('Find a.')).finalOutput, 'Found it.');
    assert.deepEqual(lookedUp, ['a']);
    assert.equal(peer.toolOutput('lookup-1'), 'found:a');
  },
);
```

Run `npx tsx scripted-test.mts` from your application directory. The script exits silently when all assertions pass.

## Assert application behavior

The script prescribes both the tool call and final answer. Assert the callback's application effect and submitted tool output, as above. These checks exercise scripted native and application behavior. Use separate live-model evaluations for tool choice and answer quality.

## Define script steps

Each complete JSON-object POST to `/v1/responses` consumes the next script step. An item array emits its items in order. An empty array is valid. `httpError(400, { error: { message: 'synthetic failure' } })` serves a terminal HTTP error through the native provider. Retryable statuses follow the native retry policy and may consume more steps.

For a namespaced function, pass `namespace` beside `callId`, for example `toolCall('lookup', { sku: 'PAPER' }, { callId: 'lookup-1', namespace: 'mcp__catalog' })`. The [stdio lesson](../../examples/codex/stdio-programmatic/README.md) runs this against a real selected MCP peer.

`customToolCall('exec', code, { callId: 'aggregate' })` prescribes a raw custom call for the Code Mode host. Use `peer.toolOutput(callId)` to read the submitted output for either form. The scripted server does not supply the MCP peer, executor, or JavaScript host itself.

## Supply usage and rate-limit metadata

Keep item arrays for ordinary text/tool tests. To test budget or quota handling, use a response envelope:

```ts
const response = {
  items: [text('Synthetic answer.')],
  usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
  headers: { 'x-ratelimit-remaining-requests': '5' },
};
```

Pass this object as a script step to `withScriptedResponses`. The peer sends the headers on that HTTP response and the usage on `response.completed`. The ordinary native parser produces usage and rate-limit observations. Omitted usage stays unknown; reported zero stays zero. The helper captures metadata before starting HTTP. Content type, content length, and transfer encoding remain SDK-owned.

A token or cost budget stops the next sampling admission. An already admitted final response can reach or exceed the limit and still succeed. To test rejection, script a tool response with usage and assert that the next model request is refused. Keep any tool effects before that boundary in your assertions.

## Inspect recorded requests

The helper captures scripts before its first await. `toolCall` also captures its JSON arguments. `peer.requests` returns fresh snapshots of request bodies. `peer.toolOutput(callId)` searches the latest submitted tool results. You can still read the recorded data after the callback ends.

The helper excludes headers, but any secrets deliberately placed in bodies remain visible. Use synthetic data.

## Join cleanup and check exhaustion

After provider and HTTP cleanup, the helper checks script exhaustion and returns the callback value. The check fails with counts of unused steps, unexpected requests, and internal handler failures.

When the callback throws, the helper preserves the exact original value and skips the automatic script-exhaustion check. A genuine cleanup error joins the original in an `AggregateError`. `peer.assertExhausted()` remains available for explicit checks after failure.

`Agent.run` closes its owned Session. If you open a Session explicitly, close it in a `finally` block before the callback returns.

If a provider has active or opening Sessions, the helper refuses to close the provider but still stops its HTTP endpoint. It does not cancel caller-owned Sessions. The `peer.provider` getter rejects after the callback ends. Successful teardown closes a provider borrowed earlier.

## Keep routing stable

Keep direct or bypassed loopback proxy routing stable for the whole scope, including later Sessions. This helper does not change proxy environment variables or isolate network access. Exhaustion can detect an unused local script after a proxy has already served a response or an external effect has occurred. The helper does not configure process telemetry.

## Native realtime scenarios

`ScriptedRealtimeAdapter` has been supplying incoming Realtime frames and recording outgoing frames while the native runtime has been handling session behavior. `runScenario` has been coordinating an asynchronous fixture with the application exercise.

Example file: `scripted-realtime.mts`, with the same Node.js and installed native-runtime prerequisites as above.

```ts
import assert from 'node:assert/strict';
import { Agent, NativeProvider } from '@openai/agents';
import { ScriptedRealtimeAdapter } from '@openai/agents/testing';

const adapter = new ScriptedRealtimeAdapter();
await using provider = new NativeProvider({
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'synthetic-key',
  supportsWebsockets: false,
});
await using session = await new Agent({
  instructions: 'Speak.',
  provider,
}).session();

const answer = await adapter.runScenario({
  scenario: async ({ expectSend, emit }) => {
    const update = await expectSend('session.update');
    emit({
      type: 'session.updated',
      session: { ...(update.session as object), id: 'fixture' },
    });
    await expectSend('conversation.item.create');
    await expectSend('response.create');
    emit(
      { type: 'response.created', response: { id: 'reply' } },
      {
        type: 'response.output_audio_transcript.done',
        response_id: 'reply',
        item_id: 'answer',
        transcript: 'Synthetic answer.',
      },
      { type: 'response.done', response: { id: 'reply' } },
    );
  },
  exercise: async () => {
    const voice = await session.realtime({ model: 'fixture', adapter });
    try {
      await voice.sendText('Synthetic question');
      for await (const event of voice.events()) {
        if (
          event.type === 'text' &&
          event.final &&
          event.role === 'assistant'
        ) {
          return event.text;
        }
      }
    } finally {
      await voice.close();
    }
  },
});
assert.equal(answer, 'Synthetic answer.');
adapter.assertComplete();
adapter.assertClosed();
```

Command: `npx tsx scripted-realtime.mts`. Expected result: a silent exit after the answer and closure assertions.

| Scenario operation | Contract |
| --- | --- |
| `expectSend(expected)` | Ordered matching by frame type, exact JSON object, or synchronous predicate; a promise for a copied frame. Already recorded frames first. |
| `emit(...frames)` | Incoming canonical provider frames, in argument order. |
| `failNextSend(error)` | One injected error on the next outgoing send; that frame still available to `expectSend`. |
| `disconnect(error?)` | Incoming-stream termination after queued frames, with an optional injected error. |

`runScenario` has been rejecting mismatches, unconsumed sends or failure injections, and unsatisfied expectations after exercise completion. Callback errors and an optional `signal`'s cancellation reason have been propagating unchanged. The helper has been returning the exercise's value after both callbacks and the completeness checks.

Each adapter has been allowing one connection and one scenario. Constructor `RealtimeStep[]` entries have been supporting fixed exchanges separately; mixed static steps and `runScenario` have been triggering rejection before either callback. All scenario operations have been rejecting use after scope completion.

The helper has been releasing its own waiters and abort listener. The exercise has been retaining responsibility for session cleanup and caller-created background work, including after cancellation. `assertComplete()` and `assertClosed()` have been providing explicit completeness and terminal-state checks. `sentEvents` has been retaining full synthetic frame snapshots; `connectCalls` has been retaining only model and header-presence metadata.

## Use classic test doubles separately

Use helpers for the API your application runs:

| API | Helper contract |
| --- | --- |
| Native `@openai/agents/testing` | HTTP Responses items using `call_id`; requires a native Agent and runtime. |
| Native `ScriptedRealtimeAdapter` | Canonical Realtime frames; native session and protocol execution. |
| Classic `@openai/agents/classic/testing`, when available | A normalized Model interface using `callId`. |

A classic model double does not replace the native HTTP fixture.

That classic testing entrypoint also exports `scriptedSandboxSession`. Retained Realtime tests use `ScriptedRealtimeTransport` from `@openai/agents/classic/realtime/testing`. Inspect recorded calls, use the applicable `assertComplete()` check, and close owned resources. Realtime also provides `assertClosed()`. Classic doubles do not use this native helper's automatic scope-exhaustion check.

## Add evaluations and telemetry

The [configurable evaluation runner](../../examples/codex/evaluation/README.md) adds repeated scripted or explicitly selected live trials, recorded configurations, safe failure artifacts, and baseline comparisons. Run it from a source checkout with its default JSON inputs. Scripted mode checks the evaluation runner. Live mode requires model credentials and measures model behavior.

The [small catalog evaluation](../../examples/codex/evaluate-catalog.ts) checks actual ordered tool calls as well as exact answers and completion. It writes a synthetic JSON artifact and can compare one compatible baseline. The [native telemetry walkthrough](../../examples/codex/native-telemetry.ts) uses a bounded local trace receiver in a fresh process. See the [two-case evaluation commands](../../examples/codex/evaluation/README.md#compare-two-fixed-catalog-cases) and [telemetry walkthrough](../../examples/codex/observability/README.md#record-four-local-outcomes).
