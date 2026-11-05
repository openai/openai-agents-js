# Inspect one synthetic run

Use this walkthrough to compare what the native runtime exported with what your application observed. From the repository root, use Node.js 24 and the [matching built packages and native runtime](../guides/building.md). The example uses scripted model responses and a loopback OpenTelemetry receiver. It needs no model API key or telemetry service.

Create a private output directory in a POSIX shell and run the failed-tool-result scenario. Keep this shell open for the remaining commands.

```sh
TRACE_DIRECTORY=$(mktemp -d)
pnpm exec tsx packages/agents-codex/examples/observability/trace-walkthrough.ts --scenario tool-error --output "$TRACE_DIRECTORY/tool-error.json"
```

The command prints a run ID, the application outcome, and a batch count. It configures telemetry before opening its first Session, closes the Session and scripted provider, flushes the exporter, and writes the received data. Start a fresh process for each scenario because native telemetry configuration belongs to the process.

The JSON gives you three ways to inspect the run.

| Field | What it records |
| --- | --- |
| `batches` | The JSON received on `/v1/traces` and `/v1/logs`. The receiver discards HTTP headers. |
| `receipt` | Application callbacks, Turn settlement, observed native error fields, and public history. |
| `runId` | The value sent as `example.run_id`, which identifies this scenario among startup records. |

A zero exit status means the example collected both signals and handled the selected scenario. Read the application receipt to determine whether the callback and final output succeeded.

## Compare four outcomes

Run the other three scenarios in the same shell.

```sh
pnpm exec tsx packages/agents-codex/examples/observability/trace-walkthrough.ts --scenario tool --output "$TRACE_DIRECTORY/tool.json"
pnpm exec tsx packages/agents-codex/examples/observability/trace-walkthrough.ts --scenario validation --output "$TRACE_DIRECTORY/validation.json"
pnpm exec tsx packages/agents-codex/examples/observability/trace-walkthrough.ts --scenario provider --output "$TRACE_DIRECTORY/provider.json"
```

| Scenario | What to look for in the receipt |
| --- | --- |
| `tool-error` | The callback records `A` and returns a failed `ToolOutput`. The application records `tool_returned_error`. The Turn completes with the scripted explanation. |
| `tool` | The model HTTP exchange succeeds. The callback records `A`, throws, and causes settlement to reject. |
| `validation` | The provider returns JSON whose count violates the output schema. Settlement rejects with `OutputValidationError`. |
| `provider` | The synthetic peer returns HTTP 400. Settlement rejects with `NativeError`. Read its observed fields and the peer's request count before deciding how to handle the failure. |

### Find the matching spans and logs

1. In a `traces` batch, read `data.resourceSpans[].scopeSpans[].spans[]`. Find a `run_turn` span with the matching `example.run_id`. Its `traceId` connects spans for that operation. Startup records can have other trace IDs.
2. In a `logs` batch, read `data.resourceLogs[].scopeLogs[].logRecords[]`. Find the `codex.api_request` event and compare its `conversation.id` with `receipt.sessionId`. Use `receipt.turnId` to identify the submitted Turn after settlement.

These fields describe the build used by the walkthrough. Some logs lack trace IDs and some spans lack Session IDs. Use the application receipt for callback and validation outcomes.

## Read supported history

[`history-reader.ts`](history-reader.ts) reads `session.turns()` and `session.items()` after settlement while the Session is still open. Each iterator takes its own projection snapshot. Reading an active Session can produce views of different moments. The artifact retains those projected records and adds `functionResults`.

Only a preceding function call with the same nonempty `(turnId, callId)` can name an output. The latest preceding call wins, and that association is consumed once. A duplicate or unmatched output keeps its output with a null name and null arguments. Calls displaced by a later occurrence remain in `items`. Records the reader cannot associate remain visible there. The reader cannot reconstruct unknown records omitted by the SDK projection.

Null timestamps and usage remain null. Unavailable usage does not mean zero tokens. Any bigint counters use decimal strings in this example's JSON artifact to preserve precision. Recorded output and error values are not business-effect receipts.

History and telemetry do not reconstruct approvals, all passive events, private reasoning, complete UI state or authoritative citation spans. Keep a separate application ledger for business effects.

## Collector and data limits

The receiver binds to `127.0.0.1` on an ephemeral port and accepts only the two example signal paths. It limits input to 16 requests and 4 MiB per request. Excess input is rejected before the receiver retains a partial batch.

Use synthetic data and keep the files private. Paths and tool arguments can appear even when prompt and response text logging is off. The receiver keeps data in memory and provides no authentication or persistent store.

The command requires direct loopback routing for its scripted peer and exporter. An empty signal receipt fails the command. Cleanup flushes the exporter, closes owned sockets, and joins pending body handlers. Delivery and reconnect behavior depend on your production exporter and collector.

Run the focused acceptance checks after building the matching native products.

```sh
pnpm test:native packages/agents-codex/test/native/observability-example.test.ts
pnpm exec tsc -p packages/agents-codex/tsconfig.test.json --noEmit
```

## Record four local outcomes

The smaller [native telemetry example](../native-telemetry.ts) runs four scripted outcomes in a fresh process with one loopback JSON trace receiver.

```sh
pnpm exec tsx packages/agents-codex/examples/native-telemetry.ts
```

Compare a successful run, a failed tool result that lets the Turn continue, a thrown callback, and invalid structured output. Each application receipt includes its Session ID, Turn ID, and settled history. The summary adds the span IDs and attributes that the receiver observed.

The command closes its Sessions and providers, shuts down native telemetry, and closes the receiver. Classic trace processors have their own lifecycle. Prompt, response, and tool-result logging are disabled for this walkthrough. Other fields, including tool arguments, can still carry application data. Use synthetic inputs.
