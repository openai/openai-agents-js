# Persist native conversations in a local profile

Use `localStorage(directory)` to keep a native conversation profile across processes, including supported native checklist and goal state. Reopening uses your current application credentials and tool bindings. For portable checkpoints, use [Session history and state](state.md#save-or-suspend-a-session).

<a id="store-canonical-conversation-state-in-application-owned-files"></a>

For application-owned canonical snapshot files, use [Store canonical conversation state in application-owned files](session-store.md#store-canonical-conversation-state-in-application-owned-files). That preview `SessionStore` route, including `fileSessionStore`, rejects native goals and has its own writer, commit, and recovery protocol. `nativeGoals()` requires the native `localStorage` route described here.

## Default storage and workspace

Without a storage option, the SDK has been keeping conversation history in process-local memory. Explicit `localStorage(directory)` has been retaining that history across process lifetimes.

Without an explicit workspace configuration, the SDK has been creating a temporary workspace under its private runtime home. An explicit [Environment](local-execution.md) has been selecting the workspace for application files; `localStorage(directory)` has been selecting a separate conversation profile. Workspace files and conversation history have been following separate retention and cleanup policies.

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

### Discover AGENTS.md when opening and reopening

With a [current source build](building.md), set `discoverAgentsMd: true` on each Session opening. Discovery is off by default. The SDK reads user guidance from the host Codex home first. In a Git workspace, it then reads project guidance from the nearest Git root to the working directory, within the Environment's read policy. At each location, `AGENTS.override.md` takes precedence over `AGENTS.md`. Enable discovery for directories and file targets you trust. The `projectGuidance` option controls [scoped rules](../project-guidance.ts) separately.

Pass an Agent with a configured native provider, an existing absolute workspace path, and a separate absolute profile path. The [local executor requirements](local-execution.md#prepare-the-host-and-workspace) apply. Put an `AGENTS.md` with the project's test command in the workspace. The example submits a Turn before and after reopening the same conversation.

```ts
import { Environment, localStorage, type Agent } from '@openai/agents';

export async function continueProjectReview(
  agent: Agent,
  workspace: string,
  profile: string,
) {
  const environment = Environment.local({ cwd: workspace });
  const storage = localStorage(profile);
  const session = await agent.session({
    environment,
    storage,
    discoverAgentsMd: true,
  });
  const id = session.id;
  try {
    const turn = await session.submit('Which command runs the project tests?');
    await turn.wait();
  } finally {
    await session.close();
  }

  await using reopened = await agent.session({
    environment,
    storage,
    resume: id,
    discoverAgentsMd: true,
  });
  const turn = await reopened.submit('Remind me which command runs the tests.');
  return (await turn.wait()).finalOutput;
}
```

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

Reopen through the original root Session ID. Before model or callback work, the SDK checks the root and all recorded descendants, including closed branches. The SDK has been interrupting abandoned descendant turns when retained history accounts for every tool effect and identifies any unfinished spawning turn. It has been refusing live writers, open descendants without their own recorded turn, unknown effects, and ambiguous or incomplete history. Automatic recovery has also been refusing `write_stdin` activity and commands without durable completion evidence. An abandoned child or grandchild call with no saved result can require a receipt, even when the current Agent declares no NativeAgents.

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

## Query stored history

Current source builds have been reading indexed history from the native store, including a reopened LocalStorage profile. Unsupported stores have been rejecting these reads without scanning application journals as a fallback.

| Public read | Result |
| --- | --- |
| `storedTurns({ limit, cursor, direction, includeSummary })` | Turn metadata and optional `summaryItems`; `nextCursor` and `backwardsCursor`. |
| `storedItems({ turnId, limit, cursor, direction })` | Stored item projections, with optional turn filtering. |
| `searchHistory(text, { limit, cursor })` | Literal, case-insensitive text matches and snippets. |

Page limits have been defaulting to 50 and accepting values from 1 through 1000. Turn and item queries have been defaulting to `asc` order and accepting `desc`. Opaque cursors have been tracking the conversation and query; `backwardsCursor` has been selecting a page in the opposite direction. Search offsets have been counting UTF-16 positions in the snippet, and `turnCursor` has been selecting the matching turn in `storedTurns`. Item `updatedAtOrdinal` values have been using decimal strings to retain integer precision. Each query has been returning independent data copies without executing tools or restoring callback authority.

Example helper with the application's current configured Agent and an existing absolute profile directory:

```ts
import { localStorage, type Agent } from '@openai/agents';

export async function inspectProfile(
  agent: Agent,
  profileDirectory: string,
  sessionId: string,
) {
  await using session = await agent.session({
    storage: localStorage(profileDirectory),
    resume: sessionId,
  });
  const page = await session.storedTurns({ limit: 25 });
  const matches = await session.searchHistory('invoice', { limit: 10 });
  const first = page.turns[0];
  const items = first
    ? await session.storedItems({ turnId: first.id, limit: 25 })
    : null;
  return { page, matches, items };
}
```

### Find and name stored conversations

With a [matching source build](building.md), `session.storedSessions()` has been listing committed application-session headers in the current LocalStorage profile, including durable forks. Each header has been exposing `id`, `name`, `forkedFromId`, `parentThreadId`, `createdAtMs`, and `updatedAtMs`. The native index has been excluding interactive CLI, IDE, and child-agent categories. Header queries have been running without opening the listed Sessions or reading their full histories.

The default query has been selecting active records; `{ archived: true }` has been selecting the archived collection. Reads have been supporting active and approval-paused Sessions. Pagination has been following creation order without snapshot isolation or a total count. Concurrent creation and deletion have been changing the collection, so short or empty pages have been retaining a possible `nextCursor`.

This fragment has been assuming an open LocalStorage `session`. It has been collecting all pages, including after an empty page:

```ts
let cursor: string | undefined;
const conversations = [];
do {
  const page = await session.storedSessions({ limit: 50, cursor });
  conversations.push(...page.sessions);
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);
```

`await session.setStoredName('Review notes')` has been saving a display label on the current open LocalStorage Session. `null` has been clearing it; the SDK has been trimming surrounding whitespace and rejecting blank names. Labels have been permitting duplicates while `session.id` has been remaining unchanged. A label has not been supplying a resume alias or permission to open the conversation.

### Revert or delete a stored conversation

On an idle native LocalStorage Session, `await session.revertStored({ beforeTurnId })` has been removing the named turn and later history. `await session.deleteStored()` has been deleting the conversation. Both operations have been closing the source Session and joining native writer cleanup before changing the store. After successful reversion, the same Session ID has been supporting reopening with the current Agent and profile. Successful deletion has been preventing later resume of that conversation.

The native store has been checking current ownership and references from branches before changing history. Failed mutations have sometimes been leaving the source Session closed, so the application has been retaining the original error and cleanup diagnostics. These operations have not been reversing external tool effects or workspace file changes.

## Fork stored history

Current source builds have been accepting `await session.forkStored()` to create a new durable conversation ID in the same native LocalStorage profile. `beforeTurnId` and `throughTurnId` have been selecting a prefix boundary as mutually exclusive options. Omitting both has been selecting the latest settled history.

```ts
import { localStorage, type Agent } from '@openai/agents';

export async function forkProfile(
  agent: Agent,
  profileDirectory: string,
  sourceId: string,
) {
  const storage = localStorage(profileDirectory);
  await using source = await agent.session({ storage, resume: sourceId });
  const branchId = await source.forkStored();
  await using branch = await agent.session({ storage, resume: branchId });
  return { branchId, turns: await branch.storedTurns({ limit: 25 }) };
}
```

The source Session has been remaining usable after branch publication. Branch openings have been using the current trusted Agent, credentials, tools, and Environment. The branch has been retaining root history without cloning descendants, workspace files, live JavaScript tasks, or native Code Mode state. Forking has been requiring settled native work and current store checks. References from the branch have been protecting source history from conflicting reversion or deletion. Portable [`fork()`](state.md#fork-a-conversation) has been using a separate route with its own checkpoint limits.

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

### Set a paused goal without model work

With a [matching source build](building.md), an idle LocalStorage Session with current `nativeGoals()` authority has been accepting `session.setPausedGoal(objective, { tokenBudget })`. This call has been creating or updating the root goal without starting a model request or an autonomous turn. The returned goal has been preserving native accounting and any `budgetLimited` status.

This fragment has been assuming the open LocalStorage `session` from the native-goal example above:

```ts
const paused = await session.setPausedGoal('Prepare the requested draft', {
  tokenBudget: 50_000,
});
console.log(paused.objective, paused.status);
```

Omitting `tokenBudget` has been preserving an existing budget or using Core's default for a new goal. Budgets above JavaScript's safe integer range have been requiring `bigint`; native validation has been requiring a positive supported budget. Goal-database failures have been leaving the previous goal in place without necessarily removing the recorded instruction from history. The application has been retaining that error before deciding whether to retry.
