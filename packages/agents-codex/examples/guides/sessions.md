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

### Update a session

An idle Session can update one category at a time: instructions, model and settings, or tools. Tool updates can remove, restore, or replace opening declarations within their original names. A Session opened with `NativeAgents` keeps its instructions and model settings fixed from the start.

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
