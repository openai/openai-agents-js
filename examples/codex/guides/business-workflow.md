# Trace a business workflow across services

The [runnable business workflow](../business-workflow.ts) has been tracing a synthetic order through an orchestrator Agent, its `fulfil` tool, and a fulfilment Agent in a separate Node.js process. Both services have been sending native spans to one local OpenTelemetry Protocol (OTLP) receiver. The example has been using scripted model responses and loopback HTTP without model credentials, customer data, or external export destinations.

## Local execution

This example has been targeting the matching [source build](building.md), with Node.js 24 and its native runtime. From the repository root, the following command has been running both synthetic scenarios in a fresh process:

```sh
pnpm exec tsx examples/codex/business-workflow.ts
```

The worker HTTP response has been carrying telemetry receipts only for this local fixture; production service responses have been requiring application-owned business fields instead. The JSON summary has been reporting each scenario's trace ID, business outcome, provider request count, and separate orchestrator and worker flush receipts. It has also been reporting the replacement probe and the receiver's batch count. A nonzero exit has been indicating a failed assertion or local setup failure. The local receiver and child service have been staying alive through delivery and shutdown.

## Request and trace ownership

The orchestrator has been opening `business.order` with `telemetry.withTrace()`. Its native tool callback has been receiving `context.traceContext`; the HTTP client has been injecting only `context.traceContext.toHeaders()`. The worker has been constructing `TraceContext` from `traceparent` and optional `tracestate`, then passing that carrier as the fulfilment Agent's `parentTrace`.

The example has been checking one shared trace ID and the worker's direct parent span ID against the native tool span. This has been exercising an HTTP service boundary rather than a same-process nested Agent call. The worker has been using `parentTrace` directly, avoiding a second ambient SDK scope with a different parent. The [context guidance](telemetry.md#carry-a-w3c-parent-across-services) has been explaining that parent-selection constraint.

The `success` scenario has been completing fulfilment. The `stopped` scenario has been receiving a synthetic provider HTTP 400, stopping worker fulfilment, and returning the allowlisted `provider_failure` outcome. The worker has been checking the fixture's exact `NativeError` message because this scripted response has not been exposing a `statusCode` value. The orchestrator has been finishing its scripted conversation in both cases; the business receipt has been recording the failed fulfilment separately from that conversation result.

## Metadata and privacy

Both services have been disabling prompt and response logging and setting `toolResultMaxBytes: 0`. The orchestrator has also been calling `telemetry.setSensitiveDataLoggingEnabled(false)` before Agent admission, with `includeSensitiveData: false` on its root. The worker has been using the content-logging switches with its externally parented Agent and no tools. A global false restriction has been opening an implicit SDK scope and conflicting with an external `parentTrace` in this source build. W3C headers have been carrying identity; each service has been configuring its own content policy independently.

Application metadata has been using this allowlist:

| Field | Recorded value |
| --- | --- |
| `business.service` | `orchestrator` or `fulfilment`, as configured span attributes |
| `business.stage` | Fixed stage labels in SDK metadata |
| `business.route` | `success` or `stopped` in SDK metadata |
| `business.usage.provider_requests` | Observed worker fixture request count in settlement metadata |
| `business.usage.tokens` | `unavailable` for this scripted provider |
| `business.outcome` | `completed` or `provider_failure` in settlement metadata |

SDK metadata has been using the `sdk.metadata.` attribute prefix in lifecycle records. The request count has been measuring fixture requests. The separate token field has been marking missing model usage. Native instrumentation has also been supplying its standard operational attributes.

A synthetic private-content sentinel has been passing through prompts, tool arguments, tool results, and model output. Assertions have been checking its absence in both processes' callback records and the received OTLP batches. This local check has been covering these synthetic paths; custom names and metadata have still been requiring application allowlists. No content policy has been sanitizing arbitrary application metadata on the application's behalf.

## Routes, loss, and delivery evidence

Both processes have been configuring native OTLP export, then adding a callback receipt processor with `telemetry.addTraceProcessor()`. That additive registration has been preserving the OTLP route. During `stopped`, an additional orchestrator processor has been throwing deliberately, creating known delivery loss while fulfilment and the other destinations have been continuing. The orchestrator flush assertion has been requiring `failedDeliveries > 0`; the worker receipt has been requiring zero loss.

After both scenarios, `telemetry.setTraceProcessors([receiptSink])` has been replacing all future routes, including native OTLP and the throwing processor. A new probe has been reaching the callback sink while remaining absent from the OTLP receiver. Replacement has been following completed flushes, keeping earlier queued-route ownership out of this probe.

The example has been checking flush status, dropped records, and failed deliveries separately from receiver batch arrival. A `partial` flush status with nonzero `failedDeliveries` has been recording the controlled destination loss. These counters have been remaining cumulative: the later replacement flush has still been reporting `partial`, with the same failure count and no new losses. Successful Agent output alone has not been establishing trace delivery. The [processor guide](trace-processors.md) has been describing route ownership and callback lifecycle in more detail.
