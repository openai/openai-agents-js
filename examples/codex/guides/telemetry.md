# Native telemetry

Send native traces, logs, or metrics to an OpenTelemetry collector. To see the signals locally with a scripted model and a loopback receiver, run the [observability example](../observability/README.md).

## Configure the process

1. Await `telemetry.configure()` before constructing an engine or opening a Session.
2. Run and close all Sessions.
3. Await `telemetry.shutdown()` to request a final flush and retire the telemetry owner.

The example below needs a model credential in `OPENAI_API_KEY` and an OTLP/HTTP receiver that accepts JSON logs on port 4318. Save it as `telemetry.mts` and run `npx tsx telemetry.mts` in your application.

```ts
import { Agent, telemetry } from '@openai/agents';

await telemetry.configure({
  logs: {
    kind: 'otlp-http',
    endpoint: 'http://127.0.0.1:4318/v1/logs',
    protocol: 'json',
  },
  environment: 'dev',
});
try {
  const agent = new Agent({ instructions: 'Answer clearly.' });
  await agent.run('Hello.');
} finally {
  await telemetry.shutdown();
}
```

Select `traces`, `logs`, and `metrics` independently. An omitted or null signal disables its exporter. Each exporter accepts an endpoint and string headers. HTTP supports `binary` (the default) and `json`. For gRPC, use `kind: 'otlp-grpc'`.

Set `environment` to label exporter resources. Use `spanAttributes` to add string attributes to exported spans. Native transport libraries can also read OpenTelemetry environment settings.

## Trace one workflow

With the current [source build](building.md), wrap a task in `telemetry.withTrace(options, callback)`. Use `telemetry.withSpan(options, callback)` inside it to time a step such as submitting a Turn. The [native telemetry example](../native-telemetry.ts) creates a named workflow and a child span, then compares exported spans with the application's receipts.

Use `name` to identify the workflow and `groupId` to group related traces. Workflows record metadata by default. Set `includeSensitiveData: true` only when the workflow should include sensitive content. Children inherit their ancestors' tracing restrictions, including across queued Turns and native child agents.

To flush completed trace records while a Session is open, await `telemetry.forceFlush({ timeoutMs: 5000 })`. Check the returned `status`, `droppedRecords`, and `failedDeliveries` before treating delivery as complete.

For an application-owned trace destination, use the source-built [native trace processor API](trace-processors.md). It supports custom-only callbacks and combined callback/OTLP routes. Adding a processor preserves existing routes; replacing processors also replaces the built-in trace exporter.

## Carry a W3C parent across services

With the current [source build](building.md), construct `TraceContext` from selected `traceparent` and optional `tracestate` headers, then pass it as `parentTrace` when opening a Session or starting a new operation. The [native trace context example](../native-trace-context.ts) exports `runWithTrace(headers)` for an application that supplies its own ingress instrumentation and model credentials. Configure native telemetry before calling it if you want native spans exported.

`TraceContext` validates and freezes an explicit header carrier. Constructing it does not create a span, configure an exporter, or read an arbitrary JavaScript OpenTelemetry provider's ambient state. A tool callback receives `context.traceContext` for its issuing native tool span; pass that carrier to a nested run or call `toHeaders()` when injecting an outbound request.

An operation's explicit `parentTrace` overrides the Session fallback. Omission or `null` inherits the Session parent. A queued operation captures its selected parent when queued. A restored Session needs a new parent from the application; checkpoints do not establish current tracing context.

The native carrier profile requires lowercase, nonzero trace and span IDs. Version `00` accepts flags `00` through `03`, including the sampled and random-trace-ID bits. `traceparent` is limited to 512 ASCII characters. `tracestate` permits at most 32 entries, keys and values up to 256 characters, and tenant system IDs up to 13 characters. The native profile can reject a carrier that another W3C implementation accepts. Select only the two supported headers and handle invalid ingress before opening resources; do not pass all HTTP headers or include credentials in `tracestate`.

### Resolve a parent conflict

SDK `withTrace` and `withSpan` scopes also select a native parent. If you supply `parentTrace` inside an active SDK scope, both selections must identify the same trace and parent span. A new SDK span has a different span identity from its external ingress parent, even when both share a trace ID. Combining those parents rejects admission with `Explicit trace context must match the SDK tracing parent`.

Choose the parent once for that boundary: use the explicit ingress carrier outside a conflicting SDK scope, or let the active SDK scope supply the operation parent. Do not replace a tool callback's current span with an older ingress parent when a nested run already inherits that callback's SDK scope. A rejected conflict does not retire an otherwise usable Session. Trace parent selection does not relax an ancestor's disabled or sensitive-data restrictions.

## Configure transport and credentials

Set an exporter's `tls.caCertificate` to the CA certificate file. For client authentication over HTTP or gRPC, supply both `tls.clientCertificate` and `tls.clientPrivateKey` on that exporter. Relative paths resolve at configure time. The exporter verifies the server certificate. Configure the Session's network permissions separately.

Malformed or incomplete identities fail during initialization. If native initialization already claimed the tracing subscriber, start a new process before retrying.

## Choose recorded payloads

The defaults omit prompt text, final response text, and tool-result output from their respective records.

- `logUserPrompt` enables native prompt records.
- `logAgentResponses` enables records for live final assistant responses in the `final_answer` phase, capped at 64 KiB.
- `toolResultMaxBytes` limits the UTF-8 prefix of tool output. Native may append a truncation notice. A record can include full tool arguments even when this limit is zero.

These settings control the named records. Other telemetry can still contain application data. Saved Session state omits exporter destinations, headers, and TLS paths.

## Handle shutdown and worker lifetimes

Configure telemetry before the first attempt to construct an engine. Even a failed construction prevents later configuration. Close Sessions, classic trace processors, and application-owned JavaScript providers through their own APIs.

After successful configuration, `shutdown()` requests a flush and retires the owner. Repeated shutdown is harmless. Calling it before successful configuration rejects. A flush timeout can leave native background work running. Use the collector's receipts to check delivery because shutdown reports only some exporter errors.

For a process that uses workers, close resources in this order.

1. Configure telemetry in the bootstrap isolate and keep that isolate loaded.
2. Load the same addon image in each worker. Close the workers' Sessions and let the workers exit gracefully.
3. Await `telemetry.shutdown()` in the bootstrap isolate.

The worker tests cover shared admission, inherited payload controls, and continued export after a worker exits. Worker-first loading, forced termination, shutdown from another isolate, and addon unloading or reloading remain unqualified.
