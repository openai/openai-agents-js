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

## Configure transport and credentials

Set `caCertificate` to the CA certificate file. For client authentication over HTTP or gRPC, supply both `clientCertificate` and `clientPrivateKey`. Relative paths resolve at configure time. The exporter verifies the server certificate. Configure the Session's network permissions separately.

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
