# Native scripted tests

Use `@openai/agents/testing` in Node to run a native Agent against scripted Responses events. The helper starts one loopback HTTP endpoint and supplies an ordinary `NativeProvider`. The native engine still executes the Agent loop and declared functions.

Install Zod 4 in your application and save this example as `scripted-test.mts`.

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

Native execution still requires the matching addon and packaged runtime helpers, even though this example needs no model credentials.

## Define script steps

Each complete JSON-object POST to `/v1/responses` consumes the next script step. An item array emits its items in order. An empty array is valid. `httpError(400, { error: { message: 'synthetic failure' } })` serves a terminal HTTP error through the native provider. Retryable statuses follow the native retry policy and may consume more steps.

For a namespaced function, pass `namespace` beside `callId`, for example `toolCall('lookup', { sku: 'PAPER' }, { callId: 'lookup-1', namespace: 'mcp__catalog' })`. The [stdio lesson](examples/stdio-programmatic/README.md) runs this against a real selected MCP peer.

`customToolCall('exec', code, { callId: 'aggregate' })` prescribes a raw custom call for the Code Mode host. Use `peer.toolOutput(callId)` to read the submitted output for either form. The scripted server does not supply the MCP peer, executor, or JavaScript host itself.

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

## Use classic test doubles separately

Native helpers describe HTTP Responses items (`call_id`) and require a native Agent. Classic model doubles use `@openai/agents/classic/testing` when available, with a separate normalized Model interface and `callId` values.

That classic testing entrypoint also exports `scriptedSandboxSession`. Retained Realtime tests use `ScriptedRealtimeTransport` from `@openai/agents/classic/realtime/testing`. Inspect recorded calls, use the applicable `assertComplete()` check, and close owned resources. Realtime also provides `assertClosed()`. Classic doubles do not use this native helper's automatic scope-exhaustion check.

## Add evaluations and telemetry

The [configurable evaluation runner](examples/evaluation/README.md) adds repeated scripted or explicitly selected live trials, recorded configurations, safe failure artifacts, and baseline comparisons. Run it from a source checkout with its default JSON inputs. Scripted mode checks the evaluation runner. Live mode requires model credentials and measures model behavior.

The [small catalog evaluation](examples/evaluate-catalog.ts) checks actual ordered tool calls as well as exact answers and completion. It writes a synthetic JSON artifact and can compare one compatible baseline. The [native telemetry walkthrough](examples/native-telemetry.ts) uses a bounded local trace receiver in a fresh process. See the [example commands and limits](examples/README.md#native-telemetry-and-a-small-evaluation).
