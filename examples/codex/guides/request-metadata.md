# Inspect passive model request metadata

With the current [source build](building.md), read `model_request_dispatching` and `model_response_linked` from `turn.events()` or `session.events()`. These passive observations describe root sampling calls and link them to retained response occurrences without exposing request headers or prompt payloads.

Run the [request metadata example](../request-metadata.ts) from the repository root with matching built packages and native runtime. It uses scripted responses and needs no model credential or telemetry collector:

```sh
pnpm exec tsx examples/codex/request-metadata.ts
```

The command prints two dispatch observations and two request-to-response joins. It checks each request's selected model, reasoning settings, service tier, and HTTP transport, then matches the link to `session.turns()` history. It keeps its reader active while the tool round trip runs. The assertions qualify this small scripted path, not live provider access or billing.

## Read a dispatch observation

`model_request_dispatching` records SDK-resolved scalar settings immediately before a native client invocation:

| Field | Meaning |
| --- | --- |
| `requestId` | SDK identity for this client invocation. Internal transport retries share it; a later invocation gets a new ID. It is not a provider request or response ID. |
| `model` | Resolved model string. |
| `reasoningEffort` | Resolved string or integer, or `null` when omitted. Large integers can be `bigint`. |
| `reasoningSummary` | Resolved summary string, or `null` when omitted. |
| `serviceTier` | Resolved service-tier string, or `null` when omitted. |
| `wire` | `responses` or `responses_lite`. |
| `transport` | Selected `http_sse` or `websocket` invocation path. |

The event also carries Session, submission, thread, native turn, and sequence identities. A correction attempt retains its own thread and submission identity and links to the original submission with `parentSubmissionId`.

`null` means the SDK omitted the field. It does not report an unknown server default as a concrete value. Dispatch can precede an encoding or socket-write failure, so it does not prove that the server received a request. Internal retries are not separate dispatch observations. These events do not count billable attempts or establish a provider's accepted settings.

## Join a request to retained response history

A `model_response_linked` event associates its `requestId` with `responseObservationId`. Find the dispatch with that request ID, then find a retained response whose native observation `id` equals `responseObservationId`. Read retained responses from each recorded turn's optional `responses` list in `session.turns()`.

Use the native occurrence ID for this join. A provider's `responseId` can repeat across occurrences. The [retained response guide](state.md#read-retained-response-usage) explains nullable status, usage, and legacy unlinked records. SDK acceptance and the Turn's final outcome remain separate from retained provider status.

Link delivery is best effort. Native retirement can drop a link even after a terminal observation entered history. A missing link does not establish that no response exists. Keep unmatched dispatches and history records visible instead of inventing an association.

## Handle bounded delivery

Readers share a bounded Session suffix. A `gap` reports lost observations; it cannot reconstruct missing links. Store the observations your application needs as they arrive, and use the sequence cursor to continue a reader only while that suffix remains available. Closing an observation reader stops that reader without cancelling the Turn.

Coverage includes root sampling and supported correction or manual follow-up work. Native children, warmup, compaction, and background or reviewer requests are outside this observation contract. Restoring a manual root emits fresh observations for resumed work; it does not replay previously observed request or link events. These observations are not a durable request ledger.

When writing JSON diagnostics, preserve `bigint` values as decimal strings, as the example does. The metadata itself omits prompts and headers, but application-collected data and identifiers still need an appropriate access and retention policy. For process-wide spans and delivery status, see [native telemetry](telemetry.md).
