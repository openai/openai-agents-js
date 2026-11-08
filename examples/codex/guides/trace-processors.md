# Send native traces to application callbacks

In `0.22.0-alpha.2`, configure native `traceProcessors` to consume trace lifecycle records on the JavaScript event loop. Use an `onEvent` callback to send these records to an application-owned destination. This route is separate from classic trace processors and from [passive model request observations](request-metadata.md).

Run the [trace processor example](../trace-processors.ts) in a fresh process from the repository root with matching built packages and native runtime:

```sh
pnpm exec tsx examples/codex/trace-processors.ts
```

It uses three scripted answers and a bounded loopback OTLP receiver, with no model credential or external collector. The command checks initial delivery, adds a processor while retaining built-in export, then replaces the routes and verifies that only the replacement processor receives the third workflow. It prints the three trace IDs and callback event counts, closes the Sessions and scripted provider, shuts down telemetry, and closes the receiver.

## Choose initial and later routes

Call `telemetry.configure({ traceProcessors: [...] })` before constructing an engine or opening a Session. A nonempty initial list enables a custom-only trace pipeline even when `traces` is omitted. To use both callbacks and built-in OTLP export, also configure `traces` as shown in the example.

- `await telemetry.addTraceProcessor(processor)` adds a route while preserving existing processors and the configured built-in trace exporter.
- `await telemetry.setTraceProcessors(processors)` replaces all future trace routes, including the built-in trace exporter. Passing `[]` removes future routes. Already queued records still belong to their captured routes.

Register processors through the SDK instance that successfully configured telemetry. In a worker application, keep that configuring isolate alive; other workers can emit spans without owning registrations. The runtime permits at most 64 active and retiring registrations together. Flush completed records before replacing or adding more routes if retired registrations still consume that limit.

## Consume and flush records

The runtime calls `onEvent(event)` serially with immutable snapshots. Read `lifecycle` (`start` or `end`), `trace_id`, `span_id`, and `parent_span_id` for identity. This is a lifecycle-record API, not the OTLP payload format received by a collector. Do not mutate snapshots or assume undocumented extra attributes always exist.

A callback can return a Promise. Keep it bounded: a slow callback delays the shared delivery path, and the SDK cannot preempt synchronous application code. A callback exception counts as a failed delivery rather than failing the agent operation. Processor callbacks and their asynchronous descendants suppress SDK tracing to avoid tracing the export work recursively.

Await `telemetry.forceFlush({ timeoutMs: 5000 })` after completed work, then inspect `status`, `failedDeliveries`, and `droppedRecords`. A successful agent result does not establish trace delivery. Flush does not close an open Session. Close Sessions before `telemetry.shutdown()` and retain any application-owned destination until its entered callbacks finish. Use [telemetry lifecycle guidance](telemetry.md#handle-shutdown-and-worker-lifetimes) for process and worker limits.
