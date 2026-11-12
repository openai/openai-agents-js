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

Each scenario's `stages` receipt has been keeping an ordered record of authorized routing, specialist tool work, validation, and in-memory delivery. Each stage has been carrying its outcome and elapsed nanoseconds. The stopped scenario has been recording rejected validation and suppressed delivery. The successful scenario has been keeping one public outcome in `delivered`.

The `supervisory` receipts have been mapping typed stops to the fixed span categories `cancelled` and `run_budget_exceeded`. The cancellation probe has been joining local tool cleanup before recording the stage. The zero-request budget probe has been stopping before any provider send or tool effect. Both probes have been checking ended-span receipts from the callback sink after route replacement. The native OTLP checks have been covering the two main workflow scenarios.

The `accounting` receipt has been keeping reported totals, observed completions, and the number of completions without usage. It has also been keeping a separately labeled fixture estimate. Worker tokens have been marked unavailable.

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

## Privacy ownership beyond exported spans

The sentinel check has been covering this fixture's exported records. The application has been managing these other data copies and policies separately:

| Data | Control and ownership |
| --- | --- |
| Trace scopes and children | An ancestor's disabled or metadata-only restriction has been constraining child scopes. Each service has been choosing its own [trace policy](telemetry.md#trace-one-workflow) and [recorded payloads](telemetry.md#choose-recorded-payloads). A zero `toolResultMaxBytes` has been limiting result text; native records have still been accepting full tool arguments. The external-parent constraint above has been applying to this fixture's worker. |
| Observations and raw provider frames | [Observation readers](sessions.md#observations-and-interruption) have been receiving application data independently of export policy. Opted-in raw frames have been retaining decoded provider payloads, as exercised by the [raw-frame tests](../../../packages/agents-codex/test/native/raw-provider-events-native.test.ts). The application has been controlling reader access, retention, and publication. |
| Application logs and journals | The application has been choosing what its own logs and durable receipts retain. The [external-job guidance](recovery.md#resume-external-work) has been assigning private receipt storage and validated model output to the host. Trace content switches have not been sanitizing those stores. |
| Headers and wire payloads | [W3C headers](telemetry.md#carry-a-w3c-parent-across-services) have been carrying ancestry only. Each receiving service has been selecting its own privacy policy. Service authentication and request or response payload handling have been remaining application-owned. |
| History and checkpoints | [Portable checkpoints](state.md#output-and-checkpoint-versions) have been retaining native history, including absolute paths. The application has been [checking integrity and saved policy](state.md#restore-instructions-and-tools) before restore and protecting stored content. Trace restrictions have not been removing conversation content. |
| Export destinations and credentials | The application has been configuring approved collectors and [private export credentials](trace-processors.md#export-credential-lifetime). Saved Session state has been omitting exporter destinations, headers, and TLS paths. Route replacement has been changing telemetry destinations separately from history, journals, and application logs. |

This local fixture has not been diagnosing missing exports in a production backend or measuring filtering and buffering overhead.

## Routes, loss, and delivery evidence

Both processes have been configuring native OTLP export, then adding a callback receipt processor with `telemetry.addTraceProcessor()`. That additive registration has been preserving the OTLP route. During `stopped`, an additional orchestrator processor has been throwing deliberately, creating known delivery loss while fulfilment and the other destinations have been continuing. The orchestrator flush assertion has been requiring `failedDeliveries > 0`; the worker receipt has been requiring zero loss.

After both scenarios, `telemetry.setTraceProcessors([receiptSink])` has been replacing all future routes, including native OTLP and the throwing processor. A new probe has been reaching the callback sink while remaining absent from the OTLP receiver. Replacement has been following completed flushes, keeping earlier queued-route ownership out of this probe.

The example has been checking flush status, dropped records, and failed deliveries separately from receiver batch arrival. A `partial` flush status with nonzero `failedDeliveries` has been recording the controlled destination loss. These counters have been remaining cumulative: the later replacement flush has still been reporting `partial`, with the same failure count and no new losses. Successful Agent output alone has not been establishing trace delivery. The [processor guide](trace-processors.md) has been describing route ownership and callback lifecycle in more detail.

## Diagnosing missing trace records

Comparing records for one trace ID has been separating four questions. The local processor has been showing creation and ancestry. `forceFlush()` has been showing known queue drops and failed deliveries. A receiver receipt has been showing transport arrival. A separate lookup in the destination has been establishing whether the trace is stored and visible.

The native OpenAI exporter has been requiring a known native root descriptor. The local exporter fixture has been recording an externally parented child in a separate processor while reporting failed delivery and no matching trace at the loopback ingest endpoint. The same exporter has been delivering a locally rooted trace. [Exporter fixture](../../../packages/agents-codex/test/native/fixtures/telemetry-child.ts)
