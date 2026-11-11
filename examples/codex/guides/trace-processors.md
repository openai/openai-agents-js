# Send native traces to application callbacks

In `0.22.0-alpha.2`, configure native `traceProcessors` to consume trace lifecycle records on the JavaScript event loop. Use an `onEvent` callback to send these records to an application-owned destination. This route is separate from classic trace processors and from [passive model request observations](request-metadata.md).

Run the [trace processor example](../trace-processors.ts) in a fresh process from the repository root with matching built packages and native runtime:

```sh
pnpm exec tsx examples/codex/trace-processors.ts
```

It uses three scripted answers and a bounded loopback OTLP receiver, with no model credential or external collector. The command checks initial delivery, adds a processor while retaining built-in export, then replaces the routes and verifies that only the replacement processor receives the third workflow. It prints the three trace IDs and callback event counts, closes the Sessions and scripted provider, shuts down telemetry, and closes the receiver.

## Export to OpenAI or inspect locally

The matching [source build](building.md) has been exposing `telemetry.OpenAITraceExporter` and `telemetry.ConsoleTraceProcessor`. The exporter has been requiring explicit export credentials separately from model credentials. This fragment has been assuming an application-owned `agent` and configuring telemetry before any engine or Session:

```ts
import { telemetry } from '@openai/agents';

const apiKey = process.env.OPENAI_TRACE_API_KEY;
if (!apiKey) throw new Error('OPENAI_TRACE_API_KEY is required');
await telemetry.configure({
  traceProcessors: [
    new telemetry.OpenAITraceExporter({ apiKey }),
    new telemetry.ConsoleTraceProcessor(),
  ],
});
try {
  await telemetry.withTrace({ name: 'Support answer' }, async () => {
    await agent.run('Summarize the support request.');
  });
  const receipt = await telemetry.forceFlush({ timeoutMs: 5000 });
  if (
    receipt.status !== 'success' ||
    receipt.failedDeliveries !== 0 ||
    receipt.droppedRecords !== 0
  ) {
    throw new Error('Trace delivery did not complete');
  }
} finally {
  await telemetry.shutdown();
}
```

`withTrace` has been supplying a local workflow root for OpenAI export. `ConsoleTraceProcessor` has been writing lifecycle snapshots as JSON lines under the native capture policy; the application has been owning log access and retention. The exporter's default endpoint has been targeting OpenAI trace ingestion, and its options have been accepting explicit organization and project values.

OpenAI export has been requiring a known native root descriptor. An externally supplied ingress `parentTrace` has been propagating span context without supplying that root descriptor. Such workflows have been completing while OpenAI delivery has been failing in the flush receipt. OTLP or an application processor accepting externally parented spans has been providing the route for those workflows; the [external-parent guidance](telemetry.md#carry-a-w3c-parent-across-services) has been describing context propagation. A successful agent result has not been establishing successful export.

## Batching and retry controls

Current source builds: `traceDelivery` on the one process-wide `telemetry.configure()` call. A complete local example with the same [source-build prerequisites](building.md), without model or export credentials:

```ts
import { telemetry } from '@openai/agents';

await telemetry.configure({
  traceProcessors: [new telemetry.ConsoleTraceProcessor()],
  traceDelivery: {
    maxQueueSize: 4096,
    maxBatchSize: 256,
    scheduleDelayMs: 100,
    exportTriggerRatio: 0.7,
  },
});
try {
  await telemetry.withTrace({ name: 'Synthetic batch' }, async () => {});
  const receipt = await telemetry.forceFlush({ timeoutMs: 5000 });
  console.log(receipt.status, receipt.droppedRecords, receipt.failedDeliveries);
} finally {
  await telemetry.shutdown({ timeoutMs: 5000 });
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `maxQueueSize` | `2048` | Pending events, including drained events awaiting acknowledgement. |
| `maxQueueBytes` | `4194304` | Serialized event bytes still in the native queue. |
| `maxBatchSize` | `128` | Maximum events in one drain and its `onEvents` callback. |
| `scheduleDelayMs` | `0` | Delay from the first queued event; zero for immediate delivery. |
| `exportTriggerRatio` | `0.7` | Immediate delivery at this fraction of `maxQueueSize`, rounded down to at least one event. |

Queue counts, bytes, and batch sizes: integers from 1 through 4294967295. Scheduling delay: integer milliseconds from 0 through 4294967295. Trigger ratio: a finite number from 0 through 1.

The native queue has been draining after the delay or trigger, and during a pending flush. Queue overflow has been contributing to `droppedRecords` in the flush receipt. Callbacks have been remaining serialized on the host event loop; flush and shutdown have been retaining their separate total budgets.

For `new telemetry.OpenAITraceExporter(...)`, retry controls on the existing constructor:

| Option | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | `750` | Total delivery budget, including HTTP attempts and retry delays; 1 through 60000 milliseconds. |
| `maxRetries` | `0` | Non-negative safe-integer retry count after the first attempt. |
| `retryDelayMs` | `0` | Initial exponential backoff, with up to 10% jitter. |
| `maxRetryDelayMs` | `30000` | Delay cap, including server `Retry-After` and `retry-after-ms` guidance. |

Both delay options: integer milliseconds from 0 through 60000, with the maximum at least the initial delay. Retries have been covering network failures and HTTP 408, 409, 429, and 5xx responses, with `x-should-retry: false` suppressing retries. Export credentials and the local workflow root from the [OpenAI export example](#export-to-openai-or-inspect-locally) have been remaining required.

## Export credential lifetime

Current source builds: explicit `TraceExportCredentials` for one workflow, independent of model credentials and the exporter's fallback API key. Private headers, excluded from span records and portable Session state.

With built-in OTLP and JavaScript processors active, the SDK has been reserving each newly admitted span credential for built-in OTLP. The host `OpenAITraceExporter` has been using its configured fallback credentials for that span and descendants inheriting the credential, including after built-in OTLP removal through `setTraceProcessors()`. After replacement with host processors, a new explicit `exportCredential` admission has been authorizing host export.

With host-only tracing, the SDK has been binding each explicit `exportCredential` to the active processor registrations when the span starts. Exporters added or re-registered later have been using their configured fallback credentials for events that inherit the earlier scope. Queued events have been retaining their original registrations and credentials.

Fresh process with `OPENAI_API_KEY` for the model, plus explicit trace-only `OPENAI_TRACE_API_KEY` and `WORKFLOW_TRACE_API_KEY`:

```ts
import { Agent, NativeProvider, telemetry } from '@openai/agents';

const fallbackApiKey = process.env.OPENAI_TRACE_API_KEY;
const workflowApiKey = process.env.WORKFLOW_TRACE_API_KEY;
if (!fallbackApiKey || !workflowApiKey)
  throw new Error('Both trace API keys are required');
const exporter = new telemetry.OpenAITraceExporter({ apiKey: fallbackApiKey });
await telemetry.configure({ traceProcessors: [exporter] });
const credential = new telemetry.TraceExportCredentials({
  headers: { Authorization: `Bearer ${workflowApiKey}` },
});
try {
  await using provider = new NativeProvider();
  const agent = new Agent({ instructions: 'Answer clearly.', provider });
  await telemetry.withTrace(
    { name: 'Support answer', exportCredential: credential },
    () => agent.run('Summarize the support request.'),
  );
  credential.close();
  const receipt = await telemetry.forceFlush({ timeoutMs: 5000 });
  if (
    receipt.status !== 'success' ||
    receipt.failedDeliveries !== 0 ||
    receipt.droppedRecords !== 0
  )
    throw new Error('Trace delivery did not complete');
} finally {
  credential.close();
  await telemetry.shutdown();
}
```

`close()`: release of caller ownership; admitted spans and queued exports retain their captured credentials. New registration with a closed credential: rejection. `exporter.setApiKey(nextKey)`: new fallback credentials for subsequent delivery batches, without changing already captured batches or explicit workflow credential routes.

Delegating processors: original immutable event objects for `onEvent` or `onEvents`. JSON copies without private credential authority, even with a retained public `credential_required` marker. Flush receipts and application destination receipts for delivery verification; successful agent output alone without export confirmation.

## Read inherited root metadata

The matching source build has been exposing `TraceSpan.traceMetadata`: the original root metadata as a detached JSON snapshot, including on child spans and retained spans after end. Fresh snapshots per read, with local copy edits separate from native root state:

```ts
import { telemetry } from '@openai/agents';

await telemetry.configure({
  traceProcessors: [new telemetry.ConsoleTraceProcessor()],
});
try {
  const root = await telemetry.withTrace(
    { name: 'Checkout', metadata: { tenant: 'example' } },
    async (root) => {
      await telemetry.withSpan({ name: 'Charge' }, async (child) => {
        console.log(child.traceMetadata); // { tenant: 'example' }
      });
      return root;
    },
  );
  const snapshot = { ...root.traceMetadata };
  snapshot.tenant = 'local copy';
  console.log(root.traceMetadata); // { tenant: 'example' }, after end
} finally {
  await telemetry.shutdown();
}
```

Native root ownership and original JSON types; no credential readback or saved live context. Detached spans: their own root metadata. Restored work under a new workflow: that workflow's metadata. Python equivalents: `SpanContext.trace_metadata` and `TraceScope.trace_metadata`, with a runnable [Python example](https://github.com/openai/openai-agents-python/blob/feat/codex-harness/examples/codex/observability/trace_context.py).

## Supply trace context storage

With the current [source build](building.md), use `telemetry.setTraceContextStorage(storage)` to supply your application's asynchronous context storage. The adapter supplies `getStore()` and `run(span, callback)`. It must accept an `undefined` span so the SDK can clear ambient context. The example uses Node.js `AsyncLocalStorage` without model or export credentials.

The [trace context storage example](../../classic/docs/native/trace-context-storage.mts) preserves the current span across an asynchronous callback. It requires Node.js 24 and [matching built packages and native runtime](building.md). Run it from the repository root in a fresh process:

```sh
pnpm exec tsx examples/classic/docs/native/trace-context-storage.mts
```

The command prints `true` twice, resets custom storage, and shuts down telemetry.

Call `setTraceContextStorage()` without an argument to restore built-in storage for new scopes. Existing scopes and admitted operations keep their adapter across asynchronous callbacks, queued work, and native child callbacks. Manual reply validation uses the adapter captured by the request, even when the reply caller uses another scope.

This adapter stores JavaScript span scope. Use [`TraceContext`](telemetry.md#carry-a-w3c-parent-across-services) to pass context across services and [telemetry configuration](telemetry.md) to select exporters.

## Choose initial and later routes

Call `telemetry.configure({ traceProcessors: [...] })` before constructing an engine or opening a Session. A nonempty initial list enables a custom-only trace pipeline even when `traces` is omitted. To use both callbacks and built-in OTLP export, also configure `traces` as shown in the example.

- `await telemetry.addTraceProcessor(processor)` adds a route while preserving existing processors and the configured built-in trace exporter.
- `await telemetry.setTraceProcessors(processors)` replaces all future trace routes, including the built-in trace exporter. Passing `[]` removes future routes. Already queued records still belong to their captured routes.

Register processors through the SDK instance that successfully configured telemetry. In a worker application, keep that configuring isolate alive; other workers can emit spans without owning registrations. The runtime permits at most 64 active and retiring registrations together. Flush completed records before replacing or adding more routes if retired registrations still consume that limit.

## Consume and flush records

The runtime has been calling `onEvent(event)` serially with immutable snapshots. Matching source builds have also been accepting batch-only processors with `onEvents(events)`. For a processor with both methods, delivery has been preferring `onEvents` and passing a frozen array of immutable snapshots. Each lifecycle record has been exposing `lifecycle` (`start` or `end`), `trace_id`, `span_id`, and `parent_span_id` for identity. This is a lifecycle-record API, not the OTLP payload format received by a collector. Do not mutate snapshots or assume undocumented extra attributes always exist.

A callback can return a Promise. Keep it bounded: a slow callback delays the shared delivery path, and the SDK cannot preempt synchronous application code. A callback exception counts as a failed delivery rather than failing the agent operation. Processor callbacks and their asynchronous descendants suppress SDK tracing to avoid tracing the export work recursively.

Await `telemetry.forceFlush({ timeoutMs: 5000 })` after completed work, then inspect `status`, `failedDeliveries`, and `droppedRecords`. A successful agent result does not establish trace delivery. Flush does not close an open Session. Close Sessions before `telemetry.shutdown()` and retain any application-owned destination until its entered callbacks finish. Use [telemetry lifecycle guidance](telemetry.md#handle-shutdown-and-worker-lifetimes) for process and worker limits.
