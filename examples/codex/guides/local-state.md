# Persist native conversations in a local profile

Use `localStorage(directory)` to keep a native conversation profile across processes, including supported native checklist and goal state. Reopening uses your current application credentials and tool bindings. For portable checkpoints, use [Session history and state](state.md#save-or-suspend-a-session).

<a id="store-canonical-conversation-state-in-application-owned-files"></a>

For application-owned canonical snapshot files, use [Store canonical conversation state in application-owned files](session-store.md#store-canonical-conversation-state-in-application-owned-files). That preview `SessionStore` route, including `fileSessionStore`, rejects native goals and has its own writer, commit, and recovery protocol. `nativeGoals()` requires the native `localStorage` route described here.

## Local native profiles

`localStorage(path)` returns a frozen readonly `{ path }` descriptor. The factory resolves relative paths once, without opening files. Session opening also accepts a structural descriptor with an absolute path. Only trusted application configuration should choose that directory.

```ts
import { Agent, localStorage, NativeProvider } from '@openai/agents';

await using provider = new NativeProvider();
const storage = localStorage('/application/conversations');
const agent = new Agent({ instructions: 'Answer clearly.', provider });
const session = await agent.session({ storage });
const id = session.id;
try {
  await (await session.submit('Remember this conversation.')).wait();
} finally {
  await session.close();
}
// A later process supplies its current Agent/provider/tools/context.
await using reopened = await agent.session({ storage, resume: id });
```

The first Session closes before reopening the profile. At the end of the scope, the reopened Session closes before the provider. See [provider lifetime](session-configuration.md#provider-lifetime) and the [local-storage example](../local-storage.ts).

### Profile ownership

The SDK rejects a local working directory or writable root that overlaps the storage profile. For example, put the worker in `worker/workspace` and keep its session history in `worker/profile`.

A profile uses the native local store and one native writer per conversation. Concurrent writers refuse. A clean close that completes cleanup releases that writer. The profile survives cleanup of the provider's temporary directory. Opening uses current callbacks, credentials and accepted instructions. Saved tool names do not authorize new effects. The directory is conversation storage, not a backup of workspace files, credentials, JavaScript tasks or live reply grants.

### Compare native-profile durability

For built-in `localStorage(directory)`, the rollout file holds canonical execution history; supported checklist and goal stores retain their separately owned state. The recorder's enqueue acknowledgment accepts records into its queue. The built-in thread store's append waits for the subsequent flush barrier.

A successful append, standard persistence, or flush barrier drains prior accepted records and flushes the rollout file to the operating system, so another process can read them after process death. This boundary does not promise survival after host failure or power loss.

Once a canonical operation surfaces a failure, the SDK retains that failure through later flush, completion, and close operations, while still attempting writer cleanup. Repeated `Session.close()` calls continue to report an unresolved canonical failure after resource cleanup finishes. Search indexes and telemetry are rebuildable data; they never prove tool completion.

### Supported capabilities

Local profiles support root managed functions, live manual tools, native checklists, declared native goals, and an explicit current WebSearch grant. A current Environment and NativeAgents declaration can also admit native children. Use [`selectMcpTools`](./mcp.md#materialize-a-borrowed-sdk-mcp-namespace) to expose explicitly selected tools from an application-owned MCP client as managed functions. Local profiles reject Core-owned `HttpMCP` and `StdioMCP` registrations. Apps, Plugins, and Code Mode are unavailable.

An idle Session supports ordinary `compact()` in place using its current native thread, writer, and goal service. Supplied-summary compaction, `saveState()`, and `suspend()` reject. A rejected suspend leaves a live manual reply grant usable.

Use the memory and checkpoint route for portable `state`. Local storage and resume options are incompatible with portable state and are unavailable on `Agent.run()` or `Runner.run()`.

### Preserve the recorded executor policy

New Environments default to `writePolicy: 'strict'`. Reopening a local profile in strict mode requires recorded strict-mode evidence and the same applied executor policy. To keep remote execution when reopening legacy or unmarked remote history, supply an Environment with explicit `writePolicy: 'legacy'` and matching current authority. You can still omit the Environment for model-only work. A missing marker does not prove how older work was confined. Reopening never automatically upgrades that policy. See [workspace write grants](workspace-grants.md#save-and-restore-the-current-grant).

### Reopen with descendant history

Reopen through the original root Session ID. Before model or callback work, the SDK checks the root and all recorded descendants, including closed branches. A live writer or an unrelated unfinished turn on an open descendant branch blocks reopening. An abandoned child or grandchild call with no saved result can require a receipt, even when the current Agent declares no NativeAgents.

Read descendant history through `session.subagents()` or the `subagentId` options on `session.items()` and `session.turns()`. Historical descendants stay stopped. New work uses the current Agent's declarations, credentials, callbacks, and Environment.

### Persistence failures and cleanup

The native store flushes each managed result before the model can use it. If a root or descendant call has no saved result after process loss, opening stops before the model runs or the SDK dispatches a tool.

The `0.22.0-alpha.2` preview supports the following recovery procedure for root calls. The current preview source extends it to child and grandchild calls. The published `0.22.0-alpha.1` supports local storage and resume, but exports neither `LocalRecoveryRequired` nor `reconciledCalls`. That release refuses uncertain profiles and supplies no profile-repair API. Preserve the profile and independently reconcile the effects; do not edit native history to force reopening.

1. Read the original thread, turn, and call IDs from `LocalRecoveryRequired.calls`. Check each effect in your external system.
2. Keep the reported IDs and supply the confirmed `outcome` (`'applied'` or `'not_applied'`) and a text `result` the model can read. Leave a call unresolved while its outcome is unknown.
3. Reopen with `storage`, the original root Session ID in `resume`, and the `reconciledCalls` list. The SDK records each result against its original call without invoking the tool again. Keep the same receipts if you need to retry the opening.

A terminal event or final output reports turn progress. The managed result flush records the tool's outcome. You can still lose data during a power failure.

Close can reject a persistence error even after physical cleanup finishes. Incomplete cleanup retains its owners and temporary files. Retry `session.close()`. If opening failed before returning a Session, close any other active Sessions, then call the captured `agent.provider.close()` or explicit provider's `close()` to finish retained cleanup. That call fences new openings and joins every started failed-opening cleanup attempt. It never makes the failed opening successful. Preserve the original opening error and any cleanup failures for diagnosis.

For canonical failures that remain visible after cleanup, see [native-profile durability](#compare-native-profile-durability).

## Native local goals

Declare `nativeGoals()` in `Agent.tools` when opening a LocalStorage Session. Core then provides `create_goal`, `get_goal` and `update_goal`. `await session.goal()` reads current native state without starting model work. It returns null when no goal exists. Integer fields use numbers when safe and bigint otherwise; timestamps use epoch seconds.

```ts
import {
  Agent,
  localStorage,
  nativeGoals,
  NativeProvider,
} from '@openai/agents';

await using provider = new NativeProvider();
const agent = new Agent({
  instructions: 'Manage only the requested goal.',
  tools: [nativeGoals()],
  provider,
});
await using session = await agent.session({
  storage: localStorage('/application/goals'),
});
await (await session.submit('Create the requested goal.')).wait();
const goal = await session.goal();
```

To reopen in another process, declare nativeGoals again and use the same profile and Session ID. Saved data grants no tools. The `functions` namespace reserves the native goal names. Managed-roster updates retain the opening grant, and a tool in another namespace can share a name.

Goals do not enable checklists, child goals, autonomous turns, or artifact delivery. Ordinary `compact()` retains the goal and its accounting without adding authority or continuing work. Core owns active and paused goal status, budget, and identity. Local profile restrictions and export refusals still apply.
