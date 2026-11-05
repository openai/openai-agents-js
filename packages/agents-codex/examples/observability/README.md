# Inspect one synthetic run

Run this lesson from the matching source checkout with built workspace packages and the native runtime. The package archive includes this directory through the recursive examples rule. Use Node.js 24 or later. You need no external provider credentials, telemetry backend, or extra collector package.

```sh
pnpm exec tsx packages/agents-codex/examples/observability/trace-walkthrough.ts --scenario tool-error --output /private/task/tool-error.json
```

Create the private output directory first. The command starts a loopback HTTP receiver, configures native OTLP JSON traces and logs, and runs one local synthetic scenario. It closes the Session and scripted provider before flushing telemetry. It then closes the receiver and writes the artifact. Run each scenario in a new process. Native telemetry configuration belongs to the process and must precede its first Session attempt.

The console prints a synthetic run ID, application outcome and received batch count. Inspect the output file's three separate views:

- `batches` contains the JSON actually received on `/v1/traces` and `/v1/logs`. The receiver retains no HTTP headers.
- `receipt` records explicit application callback activity, Turn settlement, observed native error fields and public history.
- `runId` is supplied as `example.run_id` when configuring telemetry. It helps locate this synthetic run among startup records.

A successful command means the lesson collected both signals and handled its selected scenario. It does not mean the callback or final output succeeded. Unexpected fixture, exporter-receipt, file or cleanup failures fail the command.

## Compare four outcomes

```sh
pnpm exec tsx packages/agents-codex/examples/observability/trace-walkthrough.ts --scenario tool --output /private/task/tool.json
pnpm exec tsx packages/agents-codex/examples/observability/trace-walkthrough.ts --scenario validation --output /private/task/validation.json
pnpm exec tsx packages/agents-codex/examples/observability/trace-walkthrough.ts --scenario provider --output /private/task/provider.json
```

| Scenario | Application receipt | Distinction to inspect |
| --- | --- | --- |
| `tool-error` | Callback records `A`, returns a failed `ToolOutput`; application outcome is `tool_returned_error` while the Turn completes with the scripted explanation. | A completed Turn or recorded function result does not establish tool success. |
| `tool` | Callback records `A` and throws the synthetic callback error; settlement rejects. | The successful model HTTP exchange does not establish callback success. |
| `validation` | Prompted count JSON violates the output schema; settlement rejects with `OutputValidationError`. | Provider success does not establish application output validity. |
| `provider` | The synthetic peer rejects HTTP with 400; settlement rejects with `NativeError`. | Inspect its recorded nullable fields without inventing a category or assuming missing metadata permits retries. The peer request count is separate application evidence. |

To inspect the JSON, find `batches` entries with `signal: "traces"`. Their `data.resourceSpans[].scopeSpans[].spans[]` arrays contain spans. Look for a `run_turn` span whose attributes include the artifact's `example.run_id`. Its `traceId` links spans in that native operation. Startup records can belong to other trace IDs.

For `signal: "logs"`, inspect `data.resourceLogs[].scopeLogs[].logRecords[]`. Look for the `event.name` attribute `codex.api_request` and compare its `conversation.id` with `receipt.sessionId`. Use the receipt's `turnId` to identify the submitted Turn after settlement.

The native test inspects received `run_turn` spans, `example.run_id`, and `codex.api_request` log records for this build. These are tested observations, not a stable exporter schema. A native span status is not the application's callback or output-validation classifier. Do not assume every log has a trace ID, every span has a Session ID, or that Python-only error metadata exists in JS.

## Read supported history

[`history-reader.ts`](history-reader.ts) reads `session.turns()` and `session.items()` after settlement while the Session is still open. Each iterator takes its own projection snapshot. Reading an active Session can produce views of different moments. The artifact retains those projected records and adds `functionResults`.

Only a preceding function call with the same nonempty `(turnId, callId)` can name an output. The latest preceding call wins, and that association is consumed once. A duplicate or unmatched output keeps its output with a null name and null arguments. Calls displaced by a later occurrence remain in `items`. Records the reader cannot associate remain visible there. The reader cannot reconstruct unknown records omitted by the SDK projection.

Null timestamps and usage remain null. Unavailable usage does not mean zero tokens. Any bigint counters use decimal strings in this example's JSON artifact to preserve precision. Recorded output and error values are not business-effect receipts.

History and telemetry do not reconstruct approvals, all passive events, private reasoning, complete UI state or authoritative citation spans. Keep a separate application ledger for business effects.

## Collector and data limits

The standard-library receiver binds only `127.0.0.1` on an ephemeral port. It admits at most 16 requests and 4 MiB per request, then rejects excess input without keeping a partial batch. It accepts only the two demonstration signal paths. It has no authentication, persistent store, viewer or production hardening. Keep the output local. Native payloads may contain paths, tool arguments, and other details even when prompt and response text switches are off. Use synthetic data only.

Keep direct loopback routing stable for the scripted peer and exporter. Empty signal receipts fail the command. A successful application result alone does not prove delivery. Export flush runs before receiver close. Close also destroys owned sockets and joins body handlers so an incomplete request cannot keep the command alive. This example does not promise reliable telemetry delivery or reconnect/retry behavior.

Focused acceptance, after the matching build and native products are available:

```sh
OPENAI_AGENTS_NATIVE_TESTS=1 pnpm exec vitest run --project @openai/agents-codex packages/agents-codex/test/native/observability-example.test.ts
pnpm exec tsc -p packages/agents-codex/tsconfig.test.json --noEmit
```
