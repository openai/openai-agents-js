# Agents and sessions

Use `Agent.run()` for one task or open a Session for follow-up turns. This guide covers providers, streaming, cancellation, and telemetry.

## Open and run a session

`Agent` declares instructions, an optional model, tools, model settings, and an optional `outputType`. `name` is optional. Pass application `context`, a remote `environment`, or saved `state` when opening a session.

`agent.run(input)` owns a session and closes it before returning a `Completed` result. `Runner.run(agent, input)` provides the same operation. Set `returnState: true` to capture a successful result's state before closing.

```ts
import { Agent } from '@openai/agents';

const agent = new Agent({ instructions: 'Answer clearly.' });
const session = await agent.session({
  model: 'gpt-5.2',
  modelSettings: { reasoningEffort: 'low' },
});
try {
  const first = await session.submit('Remember the number 42.');
  console.log((await first.wait()).finalOutput);
  const second = await session.submit('What number did I give you?');
  console.log((await second.wait()).finalOutput);
} finally {
  await session.close();
}
```

`submit()` returns a `Turn`. Submitting again while it is active steers the same turn and returns it. Use `session.submit(input, { ifBusy: 'reject' })` to reject a busy submission or `session.enqueue()` to queue independent work.

`turn.wait()` follows that turn. `session.wait()` follows the Session's current continuation.

### Update a session

An idle Session can update one category at a time: instructions, model and settings, or tools. Tool updates can remove, restore, or replace opening declarations within their original names. A Session opened with `NativeAgents` keeps its instructions and model settings fixed from the start.

### Provider connection and credentials

`NativeProvider` uses Codex's built-in Responses client. Its options select the endpoint, key and WebSocket policy. It does not wrap an OpenAI JavaScript client. A custom endpoint must support Responses. Chat Completions compatibility alone is insufficient for this native route. The provider does not start a JavaScript model loop.

`baseUrl` defaults to `https://api.openai.com/v1`. To use `OPENAI_BASE_URL`, pass `baseUrl: process.env.OPENAI_BASE_URL` explicitly. Custom endpoints default to HTTP. When you omit the key, the SDK reads `OPENAI_API_KEY` as the Session opens.

Close the provider's sessions before you call `provider.close()`. A closed provider cannot open new sessions.

These rules describe `NativeProvider`. The [classic API and experimental Model migration route](../../../agents/CLASSIC.md) retain their separate client and custom-Model contracts.

### Per-session configuration

Pass `provider`, `model` or `modelSettings` to `agent.session(...)` or `agent.run(...)` for one conversation. An opening provider or model overrides the Agent default. Defined model-setting keys override the corresponding Agent settings; omitted or `undefined` keys keep them. An empty settings object keeps all defaults. Set `serviceTier: null` to clear an inherited tier. Model settings select behavior and grant no tools or workspace access.

Each opening captures its effective configuration. Overrides do not change the Agent or another Session. The Session borrows a supplied provider, including one supplied through opening options. Closing a Session releases its own resources and leaves the provider available for other Sessions. The Agent keeps its default provider object across openings.

Portable `state`, including state from `session.fork()`, retains the saved model and accepted settings. Restore through the same Agent even if its model default differs or is absent. Leave `model` and `modelSettings` undefined on restore. Even `modelSettings: {}` rejects.

Pass a provider override for current credentials. After restore, use `session.update(...)` while idle to change settings where supported. `NativeAgents` sessions keep their model settings fixed. Checkpoints store neither provider credentials nor tool grants.

### Connection retries and errors

Connection recovery uses the provider's configured retry limits for requests and streams, with the existing backoff. The SDK disables unbounded connection retries. Startup fails if a managed requirement mandates them. These limits do not set a total operation timeout or cap server-requested delays.

When a native request fails, `NativeError.retryable` reports whether Core classifies the error as eligible for retry before applying attempt limits. A terminal error can still have `retryable: true` after the request exhausts its retry budget. This field does not mean that attempts remain or that replaying a whole run is safe. An error without native retry information reports `null`.

`NativeError.retryAfterMs` reports the server-advised delay remaining when native code reports the error. `null` means no observed advice; `0` includes expired advice. The value records the delay at that moment and does not count down. It does not change retry limits or authorize replaying tool effects. Use `turn.cancel()` to stop an active turn and join its cleanup, including while it waits to retry.

`NativeError.effects` describes the failed operation.

- `unknown` means the SDK cannot establish its effects. Transport failures and invalid or mismatched receipts report `unknown`, even for `TurnNotSubmitted`.
- `notStarted` means a validated native `not_submitted` receipt rejected the operation before admission.
- `recorded` is reserved for confirmed effects. The SDK does not currently produce this value.

Neither this field nor retry eligibility authorizes replay of earlier work.

For admitted WebSocket requests, the carrier checks the final JSON after schema restoration and continuation encoding. It rejects requests above 64 MiB of UTF-8 before sending them to the provider. Requests at the exact limit are allowed. Model context limits are separate. A send or disconnect failure has an unknown outcome and is not replayed. Oversized loopback messages rejected before admission can still report a generic connection failure.

### Context compaction

`await session.compact()` asks the model to summarize its context. For an idle, memory-backed root, `await session.compact({ summary: 'The user prefers vegetarian meals.' })` instead installs application-supplied model context without a model request or a new Turn. The SDK preserves canonical history, Session identity and current bindings. The summary remains context after saving and restoring state. Retained system/developer context is selected internally.

A supplied summary must contain text. If you abort via `signal`, the operation waits for cleanup. An abort leaves an already published summary in place. Close also waits for publication. Incomplete cleanup retires the Session. Retry close.

The SDK rejects supplied summaries for local profiles, goal-backed engines, active work, child or background work, pending effects, and used or previously compacted programmatic code. A declared code environment can accept its first supplied summary if the SDK can prove it is unused. Use ordinary `compact()` for model-driven compaction of supported code state.

### Validate agent defaults

`await agent.validate()` checks the Agent's default tool declarations and output schema without opening a Session, reading credentials, or connecting to services. It returns `undefined` on success and throws if a declaration is invalid. The packaged native addon must be available.

Context, environment, opening overrides, and native model requirements still need checks when a Session opens. Validation checks the defaults at the time of the call. Changes to those defaults need another check. It does not verify credentials or model availability.

### Override opening tools

Open a Session with `agent.session({ tools })` to replace its initial tool declarations, as with Python's `agent.session(tools=...)`. Omit `tools` to inherit `agent.tools`. Pass `[]` to open without those declarations. The SDK captures each Session's opening configuration before its first await. Concurrent Sessions can use the same tool names with different callbacks or MCP connections. Application hooks keep the original Agent, and the SDK does not change `agent.tools`.

Opening overrides do not remove a separately supplied Environment or programmatic execution capabilities. MCP declarations using the default activation connect during opening. To override tools, use a Session. `agent.run()` does not accept `tools`. Restore uses the current opening declarations and bindings after the existing checkpoint matching checks.

See [the tenant tools example](../opening-tools.ts) for two Sessions with separate callbacks.

## Observations and interruption

Each `session.events({ after })` reader independently observes retained session events. Closing a reader does not stop work. Sequence numbers support resuming a reader. A `gap` event reports records lost from the bounded buffer. Pending manual requests are also visible to each reader.

Root native warnings appear only in Session observations. A `warning` contains `message`, `sessionId`, and `sequence`, with no Turn or submission identity. Keep the reader active during work: workspace skill discovery starts on the first submission. Warnings share the bounded buffer and are diagnostics, not proof that a Turn failed.

### Read events for one turn

Use `turn.events({ after })` to observe one issued Turn. A root reader follows its accepted steering continuations and output-repair attempts; a child reader follows only its captured child turn. Repair observations retain their own Session and submission IDs and identify the original submission through `parentSubmissionId`. These readers yield observations only. Use the interaction APIs to receive and answer requests.

The reader ends when its Turn finishes publishing observations, even when an older `turn_finished` record has left the buffer. Events retain each native step's identity, and a `turn_finished` event can precede a root's next owned step. Sequence numbers and gaps remain Session-wide. Read `await turn.wait()` for the final result or failure; text deltas arrive before final output validation. The [conversation example](../conversation.ts) shows this flow.

### Interrupt a session

`session.interrupt()` requests a force stop of the root turn. Set `mode: 'graceful'` to let current work settle, or `scope: 'all'` to include descendants. The method returns when the stop is accepted. `session.close()` waits for owned cleanup. Always close retained sessions. If cleanup fails, address the reported unsettled work and retry closing.

### Cancel one root turn

Use `await turn.cancel()` to stop the captured root and wait for cleanup. Force is the default. `await turn.cancel({ mode: 'graceful' })` lets admitted work settle and can still wait for a manual reply.

Canceling a settled or superseded root is a no-op. Canceling a queued Turn withdraws only that entry. Canceling the active root preserves other queued roots, and independent native children can continue. The root-only `cancel()` and `steer()` methods are unavailable for child Turns.

Close the Session to stop and join all work it owns. Completed effects remain.

### Cancel one child turn

Capture the child with `session.subagents()` and call `await child.tryCancel(turn)` with a Turn from that instance. The method rejects a Turn from another Session, child, or instance.

- `true` confirms a terminal native event for that exact Turn and cleanup of its SDK-owned callbacks and native cells.
- `false` means interruption remains unconfirmed. This includes pending input or a Turn replaced by a successor.
- A cleanup failure rejects with `NativeError('Child cancellation cleanup failed')`. Private application and executor errors stay private.

The call leaves siblings and successors alone. Cleanup continues if the caller stops awaiting the Promise. A callback that ignores cancellation can delay cleanup.

For example, this fragment uses an existing `session` to select one captured live child. It waits for callback cleanup only after native cancellation is confirmed:

```ts
const captured = await Array.fromAsync(session.subagents());
const child = captured.find((entry) => entry.isLive && entry.turn !== null);
if (child?.turn) {
  const turn = child.turn;
  const confirmed = await child.tryCancel(turn);
  if (confirmed) {
    const [outcome] = await Promise.allSettled([turn.wait()]);
    console.log(outcome.status);
  }
}
```

A rejected wait can be the expected stopped outcome or a callback failure. Inspect it according to application policy before reporting success. If cancellation is unconfirmed, retain the captured Turn to observe it or close the owning Session to stop all owned work. See the [child example](../native-children.ts) for per-child preparation and snapshot waits.

## Native checklists

Put `checklist()` in the opening tools to enable Core's `update_plan`. The accepted value is an ordered whole list with native thread and turn identity:

```ts
import { Agent, checklist } from '@openai/agents';

const agent = new Agent({
  instructions: 'Inspect the task.',
  tools: [checklist()],
});
await using session = await agent.session();
await (await session.submit('Inspect and record your progress.')).wait();
const accepted = await session.checklist();
console.log(accepted);
```

The reader returns a frozen readonly `ChecklistState`. Before the first accepted update, it returns `null`. An accepted empty `plan` is a non-null state. Invalid calls do not replace the previous list. Storage, graph and close failures reject instead of reporting an absent list. Reads start no model turn and may observe committed state while another turn runs.

Use `session.checklist({ subagentId })` for a descendant owned by this Session's native graph. Admitted native children inherit the opening grant and retain separate lists. Reads can inspect settled or restored descendants without loading them or granting input authority. Foreign IDs reject.

Portable state retains accepted checklist data. A destination without `checklist()` may read that data but cannot update it. Declare the capability again to permit new updates. Restoring descendants still requires current NativeAgents and its Environment. Opening `tools: []` removes inherited declarations for that new Session; ordinary `session.update({ tools: [] })` changes only managed leaves and retains the fixed native grant. Passing a Checklist declaration to `update()` rejects.

Ordinary LocalStorage profiles retain the last accepted checklist across close and fresh-process reopen. Declare `checklist()` when opening to allow new updates; a Session without that declaration can read retained data but cannot update it. Local checklist readback is root-only and makes no model request. An accepted empty list replaces the previous list.

Native history and the checklist sidecar share the profile writer. Close retains both; native thread deletion removes the sidecar. Persistence failures remain visible to reads and close. The two files do not form a single power-loss transaction. Checklist reads add no cancellation or child-recovery guarantee.

## Native telemetry

Await `telemetry.configure()` before opening the first session. Omitted or null signals disable their exporters, including native metrics. Defaults disable prompt text, final response text, and tool-result output. Configure owns one native process lifetime; call it once, close all sessions, then await `telemetry.shutdown()`.

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

Select `traces`, `logs`, and `metrics` independently. Each exporter accepts an endpoint and string headers. HTTP supports `binary` (the default) and `json`; gRPC uses `kind: 'otlp-grpc'`. `environment` labels exporter resources. `spanAttributes` adds string attributes to exported spans. Native transport libraries can also read OpenTelemetry environment settings.

TLS options accept certificate file paths in `caCertificate`, `clientCertificate`, and `clientPrivateKey`. Relative paths resolve at configure time. HTTP and gRPC accept client certificates; supply the certificate and private key together. Server certificate verification remains enabled, and native network restrictions still apply. Client authentication for telemetry does not change a session's network permissions. Malformed or incomplete identities fail during native initialization. Start a new process if initialization failed after native claimed its tracing subscriber.

`logUserPrompt` and `logAgentResponses` opt in to named native records. Response logging covers live final assistant responses with the `final_answer` phase, capped at 64 KiB. `toolResultMaxBytes` bounds the UTF-8 output prefix; native may append a truncation notice. Tool-result records can still include full tool arguments even when that limit is zero. These controls do not sanitize all telemetry. Saved session state omits configure-time destinations, headers, and TLS paths.

Attempting to construct an engine prevents later configuration, even if construction fails. A failure after native claims its Rust subscriber requires a new process. Shutdown requests a flush and retires the owner. Repeated shutdown is harmless. Shutdown before successful configure rejects. This API does not close sessions, classic trace processors, or application-owned JavaScript providers. Core does not report every individual exporter error through shutdown. A flush timeout can leave native background work running.

For workers, configure in a bootstrap isolate and keep it loaded through awaited shutdown. Load the same addon image in workers, close their sessions, and let workers exit gracefully before bootstrap shuts down. Tests cover shared admission, inherited payload controls, and continued export after a worker exits. Worker-first loading, forced termination, shutdown from another isolate, and addon unloading or reloading remain unqualified.
