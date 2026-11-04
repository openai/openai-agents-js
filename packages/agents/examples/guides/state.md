# Session history and state

Read session history, capture a portable checkpoint, or reopen a local profile. The application reconciles external effects before it retries uncertain work.

## History and state

`items()`, `turns()`, and `subagents()` return asynchronous iterators over native history snapshots. The projection includes supported user and assistant content and reasoning summaries, and can omit unsupported records.

A `function_call_output` projection can have `status: 'completed'` and `error: null` even when its body describes a failed reply. Read the body and match its turn and call identity with `tool_started` and `tool_finished`.

Keep missing timestamps, usage, and records missing. Read the Turn outcome for execution status and the application's external receipt for the effect.

History projects a canonical accepted input's Responses record and native user item as one message, retaining the native ID and content. A snapshot taken before the native item is recorded can expose the Responses ID; a later snapshot replaces it with the native item. Saved checkpoints preserve native recording semantics; their raw history is not an API for authoring independent messages.

### Save or suspend a session

`saveState()` exports idle conversation state. `suspend()` seals a supported pending manual boundary and exports its continuation. Restore with `agent.session({ state })`, supplying current trusted declarations. Snapshots contain conversation data. They contain neither running JavaScript nor a workspace backup. Python checkpoint interchange is not supported.

Opening a checkpoint with a local executor or explicit `Environment.writableRoots` requires the matching saved executor policy digest. For a checkpoint without that digest, restore with a WSS Environment that omits `writableRoots` and matches the saved `network` setting. For an idle checkpoint with no network policy, you can also omit the Environment. To use a local executor or explicit `writableRoots` instead, open a new Session without this checkpoint. Store checkpoints where your application can verify their integrity. The digest checks for a matching executor policy.

### Restore instructions and tools

Validate the envelope with `parseSessionState(json)`. If you trust the storage, read and reuse the last accepted instructions with `await readSessionInstructions(state)`. Older v2 and manual v3 checkpoints can lack that record. The reader then throws, and you can restore with current trusted instructions.

Idle restore requires matching managed declarations, including materialized borrowed MCP tools. The SDK compares names, descriptions, parameter schemas, namespaces, and catalog order. Current callback implementations can differ. Selected checkpoints retain the full admitted catalog, including hidden tools, separately from narrowed defaults.

The destination selects native `HttpMCP` and `StdioMCP` declarations. Restore matching managed declarations first, then use supported idle updates within the opening ceiling.

### Output and checkpoint versions

For a pending manual checkpoint, instructions and pending tool declarations/result schemas must match. Legacy v3 requires plain-text final output. Idle v4 and pending v5 envelopes also capture the effective output contract; restore requires the same mode, JSON schema and repair budget. Omitted, `undefined`, and zero budgets have the same output identity. Pending v5 can resume plain or prompted output over HTTP or WebSocket. Pending native structured output retains the active turn's schema, including a per-turn override. Supply the matching output contract on the destination Agent before restoring.

Idle v6 and pending v7 envelopes also retain settled CodeMode stored JSON, cell counters and terminal observations. Stored JSON object keys are data, including `__proto__`; restoring them does not change an object's prototype. Capture refuses active cells. Snapshots do not serialize JavaScript stacks or arbitrary globals. They do not restore old reply grants. The destination supplies current trusted declarations and callback implementations.

Idle v8 and v10 retain managed defaults. Pending v9 and v11 can also retain the paused operation's static selection. Versions v10 and v11 add settled Code Mode state.

Explicit network policies use v12 and v13 for ordinary idle and manual state, or v14 and v15 with settled Code Mode. These versions retain the same optional selection data and require the current policy identity.

An omitted selection differs from an empty one. Saved defaults control later ordinary roots. Neither defaults nor selections add authority beyond the destination's opening tools. Use a reader that supports the envelope as written.

### Reconcile external effects

A checkpoint is not an external-effect receipt. If an application's effect outcome is unknown, check it with the application-owned service before continuing. Keep the original application effect key when the restored Session gets a new ID. Reply with the result confirmed by the service through a fresh restored manual request. Do not automatically repeat an uncertain effect.

### Model settings on restore

Portable restore uses the checkpoint's latest accepted model settings. Those settings include the model, reasoning effort, reasoning summary and service tier. Fork retains those accepted settings too. A different model or setting on the destination Agent does not replace the saved settings. Current provider credentials, callbacks, context and Environment still come from the application. To change accepted settings on an ordinary Session, restore first and call `session.update({ model, modelSettings })` while idle. Finish a pending manual turn before updating. Sessions opened with `NativeAgents` keep their model settings fixed.

### Usage counters

Checkpoint token-usage counters use numbers within JavaScript's safe integer range and canonical decimal strings outside it. This applies to response, turn, and thread usage, including retained compacted records and descendant histories. Preserve those strings in JSON storage. Restore and `readSessionInstructions()` reject older unsafe numeric counters because they may already have rounded; converting such a number to a string cannot recover the original value. Core's stored history and application tool data keep their existing formats.

### Manual suspension and repair receipts

Prompted output works with live manual replies and explicit `suspend()`. Supply `onInteraction` for a one-shot prompted run that uses manual tools; implicit pending transfer remains plain-only. A pending capture uses the active turn's output override, while an idle capture uses the Session default. After a successful seal, repeated `suspend()` calls return detached copies of the retained receipt, including after close or an application persistence failure. A rejected pre-commit suspension leaves existing requests live.

Output-aware envelopes retain passive repair receipts separately from native history. Save, fork, supplied-summary replacement, and later manual suspension preserve them without replaying requests or effects. They preserve exact counters and actual attempt identities across capture; a new root retargets only their parent Session identity. Restoring receipts grants no reply authority. Neither corrected text nor repair receipts enter later model context. If a possibly admitted attempt lacks a complete receipt, portable capture remains unavailable for that Session.

## Live capabilities and checkpoint advice

`session.capabilities` reports the configuration admitted to that Session. Reads do not call models, invoke policies, discover tools, acquire provider leases, or grant authority. The view stays live. Each returned report is a frozen snapshot with `status`, `reason`, and `scope`. Retain the view to observe later acknowledged updates. Reads of known features reject after the Session closes or seals.

```ts
const capabilities = session.capabilities;
const support = capabilities.get('functionPolicy');
console.log(support.status, support.reason, support.scope);
capabilities.require('nativeOutput');
capabilities.require('toolSelection', { allowLimited: true });
```

`require()` throws `CapabilityError`, a `NativeError`, for unsupported features and, by default, limited features. `allowLimited: true` accepts only the latter. An unknown feature name throws `TypeError`. `websocketsAllowed` reports the captured provider policy, not whether a connection uses WebSockets.

| Feature | Report scope |
| --- | --- |
| `nativeOutput` | Supported for new root output contracts. Children remain plain text. |
| `promptedOutput` | Local final-output validation with optional bounded formatting repair for prompted roots. Children remain plain text; LocalStorage requires zero retries. |
| `manualSuspend` | Limited when current manual tools and the portable configuration allow transfer. Current root output, queue, grants and callback completion still govern readiness. |
| `nativeOutputManualRestore` | Limited to portable manual boundaries with current matching manual declarations and the active output contract. Readiness checks still apply. |
| `toolSelection` | Root operation and `beforeStep` selection narrow one native executable plan across admitted families. Idle updates remain separate; children retain their separately configured authority. |
| `functionPolicy` | Supported while the acknowledged default tool selection contains a function callback. |
| `mcpBeforePolicy` | Supported for configured before/approval callbacks on acknowledged MCP tools, for root and admitted native children. Policy updates require closed native children and released callbacks; `{ action: 'stop' }` stops the exact owning Turn; an ordinary denial does not. |
| `mcpResultPolicy` | Supported for configured result transforms on acknowledged MCP tools. Effects remain. |
| `environmentBeforePolicy` | Supported for admitted executor tools, including configured approval and argument transforms. |
| `environmentCodeResultPolicy` | Limited to admitted builtin whole results, through direct and Code Mode routes. It cannot undo effects or replace final cell output. |
| `nativeAgents` | Supported when this destination admitted NativeAgents and its required Environment. Historical children grant no authority. |
| `remoteSkills` | Supported when this destination selected nonempty remote discovery roots. Selection does not prove a skill exists or grant filesystem or command access. |
| `checklist` | Supported when this opening granted the native Checklist declaration. Saved data and a same-named application callback grant no updates. |

Function-policy support follows the acknowledged default tool selection. An acknowledged manual-to-function replacement enables it; replacing the last default callback with a manual declaration or an empty selection disables it. The prior report stays in effect until acknowledgment. Explicit operation selection does not change this report. Mutating the Agent declaration after opening does not change the acknowledged defaults.

### Check capture readiness

`await session.checkpointStatus({ kind: 'idle' })` inspects portable idle capture. `{ kind: 'manualWait' }` samples the current root's pending manual boundary once. Both return a frozen `{ status, reasons }`: `ready`, definite `notReady`, or `unknown` when native readiness cannot be verified. Reasons contain fixed SDK text. LocalStorage sessions return `notReady` for both kinds.

Checkpoint advice does not return or reserve a checkpoint. It does not reply to tools, wait for a manual boundary, seal a Turn, or accept a new instruction revision. Fresh idle inspection validates a temporary snapshot without publishing its prospective instructions. Manual inspection keeps the existing reply grant usable and rechecks the exact root, output contract, grants and queue after the sample. Callback reentrancy restrictions still apply.

Readiness follows the actual root output contract, including `submitWithOutput()` overrides and owned successors. A bare `z.string()` override can create an eligible plain root in a Session opened with structured output. A settled native-schema root can transfer with its matching active output contract when current manual declarations and the portable configuration permit it. A settled prompted root supports explicit manual suspension when the portable configuration permits it. A later `saveState()` or `suspend()` performs its own checks and may fail if the boundary changes.

## Resume external work

Use `DeferredTools` when a manual tool starts work that must survive a host restart. Import it from `@openai/agents/experimental/deferred`. The application supplies a durable journal and a fixed provider. The SDK binds them to the current manual request.

Declare the tool with `deferredTool()`, using its supplied schema builder for parameters and results. Add that exact declaration to the Agent's tools and register it with the coordinator. Use `deferredDefault()` for supported scalar defaults. The deferred route accepts a restricted, lossless JSON schema; ordinary `manualTool()` remains available for application-defined validation and replies.

`jobs.prepare(session, request)` seals the pending root and writes its exact checkpoint and request bindings through the journal. It makes no provider call. Restore that checkpoint through the Agent, find the fresh request, and call `jobs.advance(restored, request)`. A continued outcome supplies the original `Turn<unknown>`; pending siblings may still need replies. Other outcomes leave provider polling to the host.

For one scoped operation, `jobs.start(session, request, options, callback)` prepares, reopens and advances, then lends the reopened Session to the callback. It closes that Session when the callback finishes. Preparation and advancement share a deadline; the callback has its own lifetime. The operation captures the original opening configuration, including credentials and output defaults. Changed Session tools or instructions require explicit preparation and restore.

Set credentials before opening the original Session. If no API key was captured, `start` rejects before preparation and leaves the original request available for an ordinary reply.

The journal must enforce current application authority, immutable request bindings and conditional ownership before each operation. A lost creation acknowledgment requires provider reconciliation; the SDK never retries plain creation. `requireReconciliation: false` permits a provider whose uncertain creation remains unknown. Method presence alone does not establish duplicate prevention.

Keep provider keys, receipts and credentials in private host storage. The registered `project` function selects a small validated result for the model. Options use milliseconds. Caller abort waits for local work but does not cancel the external job. Remote cancellation requires an explicit authorized `cancel` operation. This route supports portable plain and prompted manual roots, not local storage, child grants, Environment sessions or native structured-output pending roots.

See [Run an external job across processes](../../EXTERNAL_JOBS.md) for the complete journal, provider and recovery example.

## Local native profiles

`localStorage(path)` returns a frozen readonly `{ path }` descriptor. The factory resolves relative paths once, without opening files. Session opening also accepts a structural descriptor with an absolute path. Only trusted application configuration should choose that directory.

```ts
import { Agent, localStorage } from '@openai/agents';

const storage = localStorage('/application/conversations');
const agent = new Agent({ instructions: 'Answer clearly.' });
const session = await agent.session({ storage });
const id = session.id;
try {
  await (await session.submit('Remember this conversation.')).wait();
} finally {
  await session.close();
}
// A later process supplies its current Agent/provider/tools/context.
const reopened = await agent.session({ storage, resume: id });
await reopened.close();
```

See the [local-storage example](../local-storage.ts).

### Profile ownership

The SDK rejects a local working directory or writable root that overlaps the storage profile. For example, put the worker in `worker/workspace` and keep its session history in `worker/profile`.

A profile uses the native local store and one native writer per conversation. Concurrent writers refuse. A clean close that completes cleanup releases that writer. The profile survives cleanup of the provider's temporary directory. Opening uses current callbacks, credentials and accepted instructions. Saved tool names do not authorize new effects. The directory is conversation storage, not a backup of workspace files, credentials, JavaScript tasks or live reply grants.

### Supported capabilities

Local profiles support root managed functions, live manual tools, native checklists, declared native goals, and an explicit current WebSearch grant. A current Environment and NativeAgents declaration can also admit native children. Use [`selectMcpTools`](./mcp.md#materialize-a-borrowed-sdk-mcp-namespace) to expose explicitly selected tools from an application-owned MCP client as managed functions. Local profiles reject Core-owned `HttpMCP` and `StdioMCP` registrations. Apps, Plugins, and Code Mode are unavailable.

An idle Session supports ordinary `compact()` in place using its current native thread, writer, and goal service. Supplied-summary compaction, `saveState()`, and `suspend()` reject. A rejected suspend leaves a live manual reply grant usable.

Use the memory and checkpoint route for portable `state`. Local storage and resume options are incompatible with portable state and are unavailable on `Agent.run()` or `Runner.run()`.

### Reopen with descendant history

Reopen through the original root Session ID. A recorded child or grandchild ID cannot open as a root. Before model or callback work, the SDK checks the root and all recorded descendants, including closed branches. An open descendant with an unfinished turn or any descendant with an unknown effect blocks reopening, even when the current Agent declares no NativeAgents.

Read settled descendant history through `session.subagents()` or the `subagentId` options on `session.items()` and `session.turns()`. These reads start no historical runtime. New work uses the destination's current declarations, credentials, callbacks, and Environment.

### Persistence failures and cleanup

The native store flushes each managed result before the model can use it. If a root call has no saved result after process loss, opening stops before the model runs or the SDK dispatches a tool. `LocalRecoveryRequired.calls` gives the original thread, turn, and call IDs. Verify each effect in your external system. For each call, keep the reported IDs and provide the confirmed `outcome` (`'applied'` or `'not_applied'`) and a text `result` that the model can read. Reopen with `storage`, `resume`, and the `reconciledCalls` list. The SDK records the supplied result against the original call without invoking the tool again. If an outcome remains unknown, leave the call unresolved.

A terminal event or final output reports turn progress. The managed result flush records the tool's outcome. You can still lose data during a power failure.

Close can reject a persistence error even after physical cleanup finishes. Incomplete cleanup retains its owners and temporary files. Retry `session.close()`. If opening failed before returning a Session, close any other active Sessions, then call the captured `agent.provider.close()` or explicit provider's `close()` to finish retained cleanup. That call fences new openings and joins every started failed-opening cleanup attempt. It never makes the failed opening successful. Preserve the original opening error and any cleanup failures for diagnosis.

## Native local goals

Declare `nativeGoals()` in `Agent.tools` when opening a LocalStorage Session. Core then provides `create_goal`, `get_goal` and `update_goal`. `await session.goal()` reads current native state without starting model work. It returns null when no goal exists. Integer fields use numbers when safe and bigint otherwise; timestamps use epoch seconds.

```ts
import { Agent, localStorage, nativeGoals } from '@openai/agents';

const agent = new Agent({
  instructions: 'Manage only the requested goal.',
  tools: [nativeGoals()],
});
await using session = await agent.session({
  storage: localStorage('/application/goals'),
});
await (await session.submit('Create the requested goal.')).wait();
const goal = await session.goal();
```

To reopen in another process, declare nativeGoals again and use the same profile and Session ID. Saved data grants no tools. The `functions` namespace reserves the native goal names. Managed-roster updates retain the opening grant, and a tool in another namespace can share a name.

Goals do not enable checklists, child goals, autonomous turns, or artifact delivery. Ordinary `compact()` retains the goal and its accounting without adding authority or continuing work. Core owns active and paused goal status, budget, and identity. Local profile restrictions and export refusals still apply.
