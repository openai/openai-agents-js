# Check capabilities and recover work

Use capability reports to inspect what a Session admitted, readiness checks to inspect a possible checkpoint boundary, and external service records to reconcile uncertain effects. These records answer different questions.

| Task | Start here |
| --- | --- |
| Check a feature before using it | [Live capabilities](#live-capabilities-and-checkpoint-advice). |
| Inspect whether portable capture is currently possible | [Check capture readiness](#check-capture-readiness). |
| Confirm an uncertain external operation | [Reconcile external effects](#reconcile-external-effects). |
| Continue a manual tool's durable job after a host restart | [Resume external work](#resume-external-work). |
| Choose budget behavior while waiting or reopening | [Budgets while waiting and recovering](#budgets-while-waiting-and-recovering). |

For capture and restore, use [Session history and state](state.md#save-or-suspend-a-session). For stored conversations, choose [application-owned canonical files](session-store.md) or [native local profiles](local-state.md), each with its own recovery procedure.

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

## Check capture readiness

`await session.checkpointStatus({ kind: 'idle' })` inspects portable idle capture. `{ kind: 'manualWait' }` samples the current root's pending manual boundary once. Both return a frozen `{ status, reasons }`: `ready`, definite `notReady`, or `unknown` when native readiness cannot be verified. Reasons contain fixed SDK text. LocalStorage sessions return `notReady` for both kinds.

Checkpoint advice does not return or reserve a checkpoint. It does not reply to tools, wait for a manual boundary, seal a Turn, or accept a new instruction revision. Fresh idle inspection validates a temporary snapshot without publishing its prospective instructions. Manual inspection keeps the existing reply grant usable and rechecks the exact root, output contract, grants and queue after the sample. Callback reentrancy restrictions still apply.

Readiness follows the actual root output contract, including `submit(input, { outputType })` overrides and owned successors. A bare `z.string()` override can create an eligible plain root in a Session opened with structured output. A settled native-schema root can transfer with its matching active output contract when current manual declarations and the portable configuration permit it. A settled prompted root supports explicit manual suspension when the portable configuration permits it. A later `saveState()` or `suspend()` performs its own checks and may fail if the boundary changes.

## Reconcile external effects

A checkpoint is not an external-effect receipt. If an application's effect outcome is unknown, check it with the application-owned service before continuing. Keep the original application effect key when the restored Session gets a new ID. Reply with the result confirmed by the service through a fresh restored manual request. Do not automatically repeat an uncertain effect.

For persistent conversations, follow the backend-specific procedure: [custom-store reconciliation](session-store.md#reconcile-an-unresolved-tool-intent) or [native-profile recovery](local-state.md#persistence-failures-and-cleanup).

## Resume external work

Use `DeferredTools` when a manual tool starts work that must survive a host restart. Import it from `@openai/agents/experimental/deferred`. The application supplies a durable journal and a fixed provider. The SDK binds them to the current manual request.

Declare the tool with `deferredTool()`, using its supplied schema builder for parameters and results. Add that exact declaration to the Agent's tools and register it with the coordinator. Use `deferredDefault()` for supported scalar defaults. The deferred route accepts a restricted, lossless JSON schema; ordinary `manualTool()` remains available for application-defined validation and replies.

`jobs.prepare(session, request)` seals the pending root and writes its exact checkpoint and request bindings through the journal. It makes no provider call. Restore that checkpoint through the Agent, find the fresh request, and call `jobs.advance(restored, request)`. A continued outcome supplies the original `Turn<unknown>`; pending siblings may still need replies. Other outcomes leave scheduling and intervention to the host; `failed` and `cancelled` leave the manual call unanswered. Follow [job outcomes and explicit response/cancellation](../../../packages/agents-codex/EXTERNAL_JOBS.md#respond-cancel-or-stop-a-job) before awaiting model continuation.

For one scoped operation, `jobs.start(session, request, options, callback)` prepares, reopens and advances, then lends the reopened Session to the callback. It closes that Session when the callback finishes. Preparation and advancement share a deadline; the callback has its own lifetime. The operation captures the original opening configuration, including credentials and output defaults. Changed Session tools or instructions require explicit preparation and restore.

Set credentials before opening the original Session. If no API key was captured, `start` rejects before preparation and leaves the original request available for an ordinary reply.

The journal must enforce current application authority, immutable request bindings and conditional ownership before each operation. A lost creation acknowledgment requires provider reconciliation; the SDK never retries plain creation. `requireReconciliation: false` permits a provider whose uncertain creation remains unknown. Method presence alone does not establish duplicate prevention.

Keep provider keys, receipts and credentials in private host storage. The registered `project` function selects a small validated result for the model. Options use milliseconds. Caller abort waits for local work but does not cancel the external job. Remote cancellation requires an explicit authorized `cancel` operation. This route supports portable plain and prompted manual roots, not local storage, child grants, Environment sessions or native structured-output pending roots.

See [Run an external job across processes](../../../packages/agents-codex/EXTERNAL_JOBS.md) for the complete journal, provider and recovery example.

## Budgets while waiting and recovering

A request-only `budget: { maxRequests: N }` has been retaining prior admissions across a supported portable manual or managed function approval checkpoint. Restore has been requiring the application to supply the same ceiling from current trusted configuration. Token and estimated-cost limits have been remaining live-only for active turns. This section has been describing the matching source checkout; [source-build setup](building.md) has been providing prerequisites.

The approval rows have been referring to managed function approvals. Native prompts and Realtime interactions have been retaining their own capture restrictions.

| Operation | Supported call and result | Budget ownership |
| --- | --- | --- |
| Live manual reply | `session.respond(request.reply(value))` has been answering the original request. | Any live `RunBudget` has been retaining its consumed allowance. |
| Live managed approval | `session.respond(request.approve())` or `session.respond(request.reject(reason))` has been deciding the original request. | Approval has been running the callback before the next sampling admission checks the original allowance. |
| Active automatic work | `saveState()` has been requiring idle state; `suspend()` has been requiring a settled pending manual request. | Request-only limits have not been adding arbitrary running-work capture. Token/cost limits have been rejecting active portable capture. |
| Portable manual or managed approval suspension | `await session.suspend()` has been retaining the pending turn and accepted sibling results while retiring the original Session. | A request-only budget has been saving its original ceiling and prior admission count. Token/cost limits have been rejecting capture. |
| Request-budget manual restore | `agent.session({ state, resumeBudget: { maxRequests: N } })` has been reopening the existing turn with fresh reply authority. | Current `N` has been needing to match the saved ceiling exactly; prior admissions have been remaining consumed. |
| Old unbudgeted manual restore | `agent.session({ state })` or `agent.run(null, { state, onInteraction })` has been continuing the old turn. | Adding a budget has been remaining unsupported. |
| Settled portable reopen | `saveState()` and `agent.session({ state })` have been retaining conversation history. | A new input has been starting a new root with its caller's fresh budget. |
| Settled local/custom-store reopen | `agent.session({ storage, resume: savedId })` has been reopening the same stored conversation. | A new `submit(input, { budget })` has been starting fresh. Persistent storage has not been exporting portable state or restoring the active budget this way. |

For one-shot request-only continuation, `agent.run(null, { state, budget: { maxRequests: N }, onInteraction })` has been supplying the same current ceiling. A request-only run without a handler has been raising `InteractionRequired` with its supported manual checkpoint. New budgeted checkpoints have been using outer formats 17 or 18, so earlier SDK readers have been rejecting them instead of silently dropping enforcement. Old unbudgeted checkpoints have been retaining their earlier behavior.

Missing or changed current ceilings have been throwing `TypeError` with `Restored run budget requires the original request limit`. Active token/cost capture has been rejecting with `Cannot capture an active run with token or cost budget limits`; `checkpointStatus({ kind: 'manualWait' })` has been reporting that same reason without consuming a live reply. An old unbudgeted checkpoint with `budget` has been retaining `Cannot add a run budget when resuming a run`.

### Preserve prior admissions and accepted effects

The request limit has been counting root sampling admissions, including admitted preparations that send no physical request. Transport retries and child requests have not been charging that counter. A saved ceiling of two with one prior admission has been allowing one further admission. An exhausted saved ceiling has been remaining restorable; an approved callback or terminal tool has been remaining able to finish without another sample. The next sampling admission has been rejecting with `NativeError.code === 'run_budget_exceeded'`.

The application has been verifying checkpoint integrity and supplying the current ceiling independently of the saved JSON. Shape validation has not been authenticating saved history or counters. Reopening the same portable checkpoint twice has not been claiming exclusive ownership or a shared global allowance. The native continuation has been retaining accepted sibling receipts within each restored run; application idempotency keys and effect records have been governing uncertain or repeated external effects.

`turn.cancel()` has been stopping the captured root and joining cleanup; `session.interrupt()` has been acknowledging a stop request with its selected scope. Session closure has been joining owned cleanup. These calls have not been saving an arbitrary instruction pointer. Stored history has not been restarting the interrupted Turn automatically.

### Keep maxModelSteps separate

The separate `maxModelSteps` has been retaining its remaining preparations at supported manual checkpoints. A limit of one has been allowing the request that reaches a manual tool, then blocking the next preparation after restore with `max_model_steps_exceeded`. A limit of two has been permitting that next preparation. Replacing this limit on a resumed turn has been remaining unsupported. Provider retries, child work, and SDK output repairs have been retaining the [model-step contract](tools.md#limit-model-steps). Python has not been offering this option.

### Verify the combinations

From the repository root with the matching native build and test dependencies active, this command has been selecting the synthetic budget, model-step, and process-restart cases:

```sh
pnpm exec vitest run packages/agents-codex/test/native/run-budget-native.test.ts packages/agents-codex/test/native/model-preparation-cap.test.ts packages/agents-codex/test/native/function-approvals-native.test.ts --pool=forks
```

[The budget suite](../../../packages/agents-codex/test/native/run-budget-native.test.ts) has been checking live replies, exhausted and remaining allowances after manual/approval restore, trusted-ceiling rejection, one-shot continuation, and fresh settled store budgets. [The approval suite](../../../packages/agents-codex/test/native/function-approvals-native.test.ts) has been restoring budgeted approvals in a fresh process while retaining accepted siblings. [The model-step suite](../../../packages/agents-codex/test/native/model-preparation-cap.test.ts) has been checking its independent remaining-step contract. These synthetic fixtures have not been establishing provider billing or crash recovery from arbitrary automatic work.
