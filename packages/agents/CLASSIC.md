# Select the classic API explicitly

Use `@openai/agents/classic` when a staged migration must retain the TypeScript SDK 0.21.0 Agent and Runner. Prefer migrating directly from v0 to native v1 with the [migration guide](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/examples/codex/guides/migration.md). Classic is available and is not deprecated now. The package root, `@openai/agents`, opens a native Agent backed by Codex. Each runtime owns its sessions and pending work.

## Run a classic Agent

Set `OPENAI_API_KEY` for the default OpenAI provider. Run the example in an ES module, or put its calls inside an async function.

```ts
import { Agent, Runner } from '@openai/agents/classic';

const agent = new Agent({ name: 'assistant' });
const runner = new Runner();
const result = await runner.run(agent, 'Hello');
console.log(result.finalOutput);
```

For an offline run, try the [scripted classic example](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/examples/codex/classic.ts). Its custom Model needs no OpenAI credentials or native helpers.

## Retained classic APIs

| What you need | Import path |
| --- | --- |
| Agent, Runner, tools, handoffs, guardrails, tracing, RunState, and session stores | `@openai/agents/classic` |
| Realtime agents, sessions, and audio transports | `@openai/agents/classic/realtime` |
| Scripted Models, transports, and sandbox sessions | `@openai/agents/classic/testing` or `@openai/agents/classic/realtime/testing` |
| Sandbox APIs and local clients | `@openai/agents/classic/sandbox` or `@openai/agents/classic/sandbox/local` |
| Classic utilities | `@openai/agents/classic/utils` |

The [classic SDK guides](https://openai.github.io/openai-agents-js/) describe these features. When a guide imports from the package root or `@openai/agents/realtime`, use the corresponding classic path in the table. The [testing guide](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/packages/agents-codex/TESTING.md) shows how to use the scripted helpers. SDK-backed classic MCP clients require the optional `@modelcontextprotocol/client` dependency, version `2.4.0` in the matching core package.

The classic and native runtimes use separate session state. Converting an active classic `RunState` into native `SessionState` is unsupported. Neither entrypoint switches runtimes automatically.

A `tool()` declaration requires a supported parameter schema in its TypeScript options and at runtime. For a tool without arguments, use an empty object schema such as `z.strictObject({})`.

### Choose a model for a classic run

Classic `Runner` model and model settings supply defaults. An explicit Agent model and explicitly configured Agent settings take precedence. This package adds `modelOverride` to classic 0.21.0.

To choose the model explicitly for every Agent in a Classic run, including handoff targets, use `new Runner({ modelOverride: yourModel })`.

The value can be a model name or an existing `Model` implementation. The Runner resolves names through its `modelProvider` and uses Model objects directly. The override replaces Agent models and the Runner's `model` default without changing registered Agents or model-setting precedence. Omit `modelOverride` to retain the existing model defaults.

An `Agent.asTool()` call starts a separate nested Runner. That Runner does not inherit the parent's `modelOverride`. Opt in for that child with `child.asTool({ toolDescription: 'Ask the child', runConfig: { modelOverride: childModel } })`. An explicit child Model keeps its existing protection against inherited parent transport settings.

### Prepare model declarations

To edit model-facing instructions, history, or tool declarations, use the application-owned wrapper in the [prepared Model declarations example](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/examples/codex/prepared-model-declarations/README.md). It clones request data before editing it. Set the wrapper as the Agent's `model`, or pass `new Runner({ modelOverride: wrappedModel })` to select it across a classic run's handoffs.

The Runner still uses the original registered tools, schemas, and approval policy for execution. Editing a sampled declaration cannot enable a disabled tool or expand its executable arguments.

### Read classic results

Classic `toTextStream()` emits text from all responses, including intermediate agents. It can emit text before guardrails finish. Await successful completion and read `finalOutput` when you need the final result after guardrails pass.

`result.input` exposes the stored array for array input. Make a detached copy before editing it.

## Move a workflow to native

Follow the [v0-to-native migration guide](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/examples/codex/guides/migration.md) to port declarations, tools, providers, execution, and state ownership together. Native and classic Agents run through their own APIs. Keep pending classic approvals on classic until they settle; starting a native conversation does not resume a classic RunState.

## Use a selected Modal sandbox

The [selected Modal example](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/examples/codex/selected-modal-sandbox.ts) attaches a pre-created handle to a classic `SandboxAgent`. Import `shell()` from `@openai/agents/classic/sandbox` and set `capabilities: [shell()]`. The example runs one blocking `python -V` probe with `login: false`, suppresses command output, and returns the exit code.

Choose who owns the handle.

| Owner | Pass to the agent | Cleanup |
| --- | --- | --- |
| Your application | `borrowSelectedModalProbe(selected)` in `sandbox.session` | Your application disposes the selected resource. |
| The SDK | `ownSelectedModalProbe(selected, disposeSelected)` in `sandbox.client` | The SDK waits for the admitted probe and calls your disposal action once. |

Supply an authenticated handle for a live Modal sandbox. The selection tests use a controlled handle. Provisioning, proxy configuration, PTYs, file tools, snapshots, and resume are outside this probe's supported operations.

## Hosted web search through Responses HTTP

Use the classic `Agent`, `Runner`, `OpenAIProvider`, and `webSearchTool` exports for hosted search. Select Responses HTTP explicitly with `new OpenAIProvider({ apiKey, baseURL, useResponses: true, useResponsesWebSocket: false })` and pass it as the Runner's `modelProvider`. Omit `baseURL` for the default OpenAI endpoint. A custom endpoint must support this Responses route and its tools.

### Configure search controls

Declare controls with `webSearchTool({ filters: { allowedDomains: ['example.com', 'example.org'] }, userLocation: { type: 'approximate', city: 'San Francisco', country: 'US', region: 'California', timezone: 'America/Los_Angeles' } })`. The typed location supports timezone. The SDK forwards these as `filters.allowed_domains` and `user_location`.

Set the outer `modelSettings.toolChoice` to a supported choice such as `'web_search'` or `'auto'`. Omit it to retain the provider default. Explicit Agent settings take precedence over Runner defaults.

### Read citations and continue the conversation

Read answer text from `result.finalOutput`. Each `result.rawResponses` entry exposes the wire response in `providerData`. Assistant output content contains URL citations in `annotations`, including `url`, `title`, `start_index`, and `end_index`. Normalized message content retains the same annotations in `content[i].providerData.annotations`.

Hosted calls appear as `hosted_tool_call` items with `name: 'web_search_call'`, status, and action/source metadata in `providerData`. Missing passages remain unavailable. An assistant answer is not a retrieved source passage.

Pass `result.history` with a follow-up message to the next classic run to replay the returned messages and hosted calls.

### Preserve usage measurements

Normalized `usage` counters and `result.runContext.usage` default missing measurements to zero. Check the actual `providerData.usage` to distinguish unknown usage from a measured zero, or enable `modelSettings.preserveRawUsage` to retain a JSON-compatible `rawUsage` snapshot when the provider supplies a usage object.

`JSON.stringify(result.rawResponses)` preserves these carriers, including `rawUsage`. `RunState` serialization keeps `providerData` but omits the separate `rawUsage` field. When exporting results, serialize the field that holds the data instead of relying on the result wrapper's getters.

<a name="scope-of-fixture-coverage"></a>

The SDK forwards the selected filters and location to the provider. Retrieval, index freshness, and source selection depend on that provider. The SDK preserves the citations and usage in the response.

<a name="current-tracing-and-realtime-limitations"></a>

## Tracing and Realtime

### Choose metadata and timing by language

Python Classic task, turn, and agent spans have an optional `span.span_data.metadata` dictionary. Export merges the inherited `agent_harness_id` routing key with that dictionary; the inherited routing key takes precedence. Task and turn usage exports remain separate from that metadata.

TypeScript Classic keeps shared context on `Trace.metadata`, exposed to spans through `Span.traceMetadata`. Use custom span data for operation-specific fields:

```ts
import { withCustomSpan, withTrace } from '@openai/agents/classic';

await withTrace(
  'checkout',
  async () => {
    await withCustomSpan(
      async (span) => {
        span.spanData.data.phase = 'complete';
      },
      { data: { name: 'validate cart', data: { phase: 'started' } } },
    );
  },
  { metadata: { request_id: 'example-request' } },
);
```

Put only data you intend to export in these fields. Read shared trace context through `Span.traceMetadata`; use custom span data for span-local values. This interface does not provide Python's independent task, turn, or agent metadata merge and precedence rule. TypeScript task and turn spans use custom envelopes with an `sdk_span_type` discriminator and their own usage data.

Python Classic `VoicePipeline` sets `SpeechSpanData.first_content_at` when its TTS model first yields a chunk. The timestamp marks that pipeline event, not speaker playback. It remains available when sensitive audio and text tracing are disabled. TypeScript Classic Realtime exposes `audio_start` and `audio` events. Observe those events and record application timing in a custom span when needed. Those event timings and a span's start time do not reproduce the Python TTS first-chunk timestamp. Keep the event and clock explicit when comparing measurements across languages.

### Export response spans

Use `withResponseSpan()` to run a callback and manage its span, or `createResponseSpan()` to start and end the span yourself. Both accept response data, identifiers, and `disabled`. The callback still runs when tracing is disabled. Use `createGenerationSpan()` or `withGenerationSpan()` for detailed generation data. Set `BatchTraceProcessor.maxBatchSize` to a positive integer to bound every export, including forced flush and shutdown.

### Configure a Realtime connection

Set the default model in the `RealtimeSession` constructor or select one connection's model with `connect({ model })`. Agent updates and handoffs keep that connection's model. A later connection uses its own override, the constructor default, or the transport's normal selection, in that order.

For trace grouping or metadata, enable tracing and set `workflowName` with `groupId` or `traceMetadata`. When turn detection leaves response creation to your application, commit the input audio and then call the OpenAI transport's `requestResponse()`.
