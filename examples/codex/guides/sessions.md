# Agents and sessions

Use `Agent.run()` when the SDK should own a task's Session. Open a Session yourself when your application needs follow-up turns or direct control over observation and cleanup.

## Open and run a session

`Agent` declares instructions, an optional model, tools, model settings, and an optional `outputType`. `name` is optional. Pass application `context`, a remote `environment`, or saved `state` when opening a session.

Choose the lifetime before submitting work:

| API | Who closes the Session | Result |
| --- | --- | --- |
| `agent.run(input)` or `Runner.run(agent, input)` | SDK, before returning | `Completed`; set `returnState: true` to capture successful state before close. |
| `agent.session(options)` | Application, in `finally` or an async disposal scope | A Session that can accept follow-up submissions. |

The following example keeps one conversation open for two turns.

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

`await session.submit()` returns a Turn handle. Await `turn.wait()` for its completed result. Choose what a submission should do while another turn is active:

- Ordinary `session.submit(input)` steers the active turn and returns it.
- `session.submit(input, { ifBusy: 'reject' })` rejects a busy submission.
- `session.enqueue()` queues independent work. See [queued turns](output.md#queue-independent-turns).

Use `turn.wait()` to follow the captured turn. `session.wait()` follows the Session's current continuation.

### Choose a cancellation lifetime

Use the signal or control that owns the work you want to stop:

| API | What cancellation does | When the call finishes |
| --- | --- | --- |
| `agent.session({ signal })` | Cancels opening, including startup publication. After opening returns, this signal no longer controls the Session. | After opening succeeds, or cancellation and opening cleanup settle. |
| `agent.run(input, { signal })` | Cancels the owned run, including work after opening. | After the run and owned cleanup settle. |
| `turn.wait({ until: 'interaction', signal })` | Cancels this observer alone. It leaves the Turn and its requests active. | When this wait returns an outcome or rejects. |
| `reader.return()` | Detaches one event or interaction reader. It leaves other readers and native work active. | When that reader closes. |
| `turn.cancel()` | Stops the captured root, or withdraws its queued entry. | After that root's owned cleanup settles. |
| `session.interrupt()` | Requests a stop with the selected scope and mode, and discards queued roots. | When the stop is accepted. |
| `session.close()` | Stops all work owned by the Session and releases its resources. | After owned work and cleanup settle. |

The current source build also provides `turn.waitForAttention({ signal })`; its signal cancels only that observer. See [supervisory outcomes](interactions.md#wait-for-a-supervisory-outcome).

For an owned task with a deadline, pass an `AbortSignal` to `agent.run()`. In an explicit Session, aborting a request waiter does not stop the task. If the application abandons that root, await `turn.cancel()` and close the Session in `finally`. If submission has not returned a Turn yet, close the Session and join the pending submission. The [supervised worker](../supervised-worker/README.md#set-deadlines) shows both deadline paths with the current source build.

Cancellation cannot undo completed effects or preempt synchronous JavaScript. Entered callbacks must settle their cleanup; a callback that ignores its signal can delay cancellation and close. See [tool callback cancellation](tools.md#function-tools) and [executor resource ownership](executors.md#lease-an-executor).

### Update a session

An idle Session can update one category at a time: instructions, model and settings, or tools. Tool updates can remove, restore, or replace opening declarations within their original names. A Session opened with `NativeAgents` keeps its instructions and model settings fixed from the start.

## Observations and interruption

Each `session.events({ after })` reader independently observes retained session events. Closing a reader does not stop work. Sequence numbers support resuming a reader. A `gap` event reports records lost from the bounded buffer. Pending manual requests are also visible to each reader.

Root native warnings appear only in Session observations. A `warning` contains `message`, `sessionId`, and `sequence`, with no Turn or submission identity. Keep the reader active during work: workspace skill discovery starts on the first submission. Warnings share the bounded buffer and are diagnostics, not proof that a Turn failed.

### Read events for one turn

Use `turn.events({ after })` to observe one issued Turn. A root reader follows its accepted steering continuations and output-repair attempts; a child reader follows only its captured child turn. Repair observations retain their own Session and submission IDs and identify the original submission through `parentSubmissionId`. These readers yield observations only. Use the interaction APIs to receive and answer requests.

The reader ends when its Turn finishes publishing observations, even when an older `turn_finished` record has left the buffer. Events retain each native step's identity, and a `turn_finished` event can precede a root's next owned step. Sequence numbers and gaps remain Session-wide. Read `await turn.wait()` for the final result or failure; text deltas arrive before final output validation. The [conversation example](../conversation.ts) shows this flow.

### Inspect execution details

With the current [source build](building.md), event readers can opt into execution payloads with `includeExecutionDetails: true`. The `0.22.0-alpha.1` bundles do not provide this option. By default, an `execution_item_completed` observation contains only the item's type, IDs, and status. A detailed reader can also receive command output, file changes, or MCP arguments and results, depending on the item type.

Read `turn.events({ includeExecutionDetails: true })` and select observations whose `type` is `execution_item_completed`. For command output, narrow `event.item.type` to `command_execution`, check that `output` exists on the item, and collect only non-null `event.item.output` strings. After the reader ends, await `turn.wait()` for the validated result or failure. Close the owning Session in `finally`, including when reading or validation fails. The [native receipt test](../../../packages/agents-codex/test/native/worker-receipts-native.test.ts) compares detailed command observations with retained command history.

Each reader chooses its own projection. Detailed items are detached copies, so changing one reader's data does not change another reader's result or the retained record. This option grants no execution or reply authority. Payloads can contain private arguments, output, or file contents; expose them only to trusted consumers.

Both projections use the same bounded event buffer. A slow or reconnecting reader can receive a `gap`, so concatenated deltas or collected execution items may be incomplete. Read the final result through `turn.wait()` and use [history snapshots](state.md#history-and-state) for retained records. The [HTTP report service](../http-report-service.md) shows how to discard a provisional draft and reset from a snapshot after a gap. Event payloads and a completed command status do not establish the whole Turn's success or an external effect.

### Steer a logical root or one native step

Use `turn.steer(input)` when new input should follow that captured root through its owned continuations. Ordinary busy `session.submit(input)` follows the active default-output root too. Neither method starts an independent root; use `enqueue()` for separate work.

With the current [source build](building.md), `turn.steerExact(input, expectedTurnId)` instead targets one native step. The `0.22.0-alpha.1` bundles do not provide this method. Capture the expected ID from the `turn_started` observation for the step that the application displayed. A root's `turn.turnId` remains its initial native ID even after a continuation starts, so that property cannot identify a later step.

Pass the captured observation's `turnId` as `expectedTurnId`. Handle `StaleTurnError` when that step has ended or been replaced; the SDK rejects the attempt instead of targeting the successor. The [root control tests](../../../packages/agents-codex/test/native/turn-controls.test.ts) exercise exact steering across native continuations.

A successful call returns a `SteeringReceipt` with `sessionId`, the exact step's `submissionId` and `turnId`, and a distinct `inputId`. It confirms input acceptance, not completion or an external effect. A `StaleTurnError` reports `effects: 'notStarted'` for that rejected steering attempt. Ask for a fresh application decision before targeting a later step. Other errors can report uncertain effects; [inspect the error](session-configuration.md#connection-retries-and-errors) before retrying.

Both steering methods control roots only, and output repair accepts no steering input. A settled root cannot steer a later independent root. See the [supervised worker's steering flow](../supervised-worker/README.md) for saving exact acceptance receipts alongside worker status.

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

## Configure a session

- <a name="validate-agent-defaults"></a>[Validate the default tools and output schema](session-configuration.md#validate-agent-defaults).
- <a name="provider-connection-and-credentials"></a>[Choose an endpoint and credentials](session-configuration.md#provider-connection-and-credentials).
- <a name="per-session-configuration"></a>[Override the model and settings for one Session](session-configuration.md#per-session-configuration).
- <a name="override-opening-tools"></a>[Choose the tools for one Session](session-configuration.md#override-opening-tools).
- <a name="connection-retries-and-errors"></a>[Interpret retries and failed requests](session-configuration.md#connection-retries-and-errors).
- <a name="context-compaction"></a>[Compact model context](session-configuration.md#context-compaction).

## Native telemetry

[Configure native telemetry](telemetry.md) to export traces, logs, or metrics.

- <a name="configure-transport-and-credentials"></a>[Set exporter transport and credentials](telemetry.md#configure-transport-and-credentials).
- <a name="choose-recorded-payloads"></a>[Choose which payloads to record](telemetry.md#choose-recorded-payloads).
- <a name="handle-shutdown-and-worker-lifetimes"></a>[Flush telemetry and close workers](telemetry.md#handle-shutdown-and-worker-lifetimes).
