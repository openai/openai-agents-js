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

A direct native root's `budget` has been following live replies, managed function approvals, retained steering, and SDK output repair. Portable checkpoints have not been carrying this `RunBudget` across a restart. A settled conversation has been accepting a new input with a fresh budget. This section has been describing the matching source checkout; [source-build setup](building.md) has been providing the native prerequisites.

The approval rows have been referring to managed function approvals. Native approval prompts and Realtime interactions have been retaining their own capture restrictions.

| Operation | Without `budget` | With `budget` | Preserved state and next allowance |
| --- | --- | --- | --- |
| Waiting for a manual result in the original Session | `session.respond(request.reply(value))` has been answering the pending request. | The same live reply has been remaining available. | The original Turn and consumed allowance have been remaining live. |
| Waiting for managed function approval | `session.respond(request.approve())` or `session.respond(request.reject(reason))` has been supplying the decision. | The same live decision has been remaining available. | Approval has been running the current callback once; later sampling has been sharing the original budget. |
| Capturing active automatic work | `saveState()` has been requiring idle state; `suspend()` has been requiring a settled pending manual request. | Both calls have been rejecting active automatic work; readiness has been reporting the budget refusal. | Arbitrary running work has not been becoming portable state. |
| Suspending a supported manual or approval request | `await session.suspend()` has been sealing the existing turn. | Capture has been rejecting with `Cannot capture an active run with a budget`. | Successful suspension has been preserving accepted history and pending replies while retiring the original Session. |
| Restoring a supported pending portable checkpoint | `agent.run(null, { state, onInteraction })` has been resuming the existing turn. | Adding `budget` has been throwing `TypeError`: `Cannot add a run budget when resuming a run`. | Current matching declarations have been supplying fresh reply authority; no `RunBudget` has been coming from the checkpoint. |
| Saving and reopening settled portable state | `saveState()` has been exporting history for `agent.session({ state })`. | Idle capture has been remaining available after completion. | A new input has been starting a fresh root with its caller's new budget. |
| Reopening settled local or custom-store history | `agent.session({ storage, resume: savedId })` has been reopening the same conversation. | `submit(input, { budget })` has been starting fresh. | The backend has been preserving committed history and Session identity, without restoring a live Turn's budget. |
| Exporting portable state from a storage-backed Session | `saveState()` and `suspend()` have been rejecting persistent storage. | The same storage restriction has been applying. | The backend and Session ID have been supplying the reopen route. |

For a budgeted pending manual or managed approval request, `checkpointStatus({ kind: 'manualWait' })` has been reporting `notReady` with `Cannot capture an active run with a budget`. `suspend()` has been rejecting with that same message. The live reply has been remaining usable after refusal. Storage-backed `suspend()` has been throwing `TypeError` with `Persistent storage does not support suspend; retain Session.id and reopen with the same storage backend`.

During ordinary active automatic work, `saveState()` has been rejecting with `NativeError`: `saveState requires a settled open session`. Without a pending manual request, `suspend()` has been rejecting with `NativeError`: `suspend requires a pending manual-tool boundary`. These checks have been applying before a manual-budget capture attempt.

A one-shot budgeted run without an interaction handler has been reaching the manual request, then rejecting with `InteractionRequired` and the active-capture error as its cause. No portable continuation has been carrying the budget. Python has been rejecting a corresponding reachable-manual configuration before inference; explicit Sessions and interaction handlers have been supplying the supported live route in both languages.

### Keep model steps separate from RunBudget

The separate `maxModelSteps` has been storing its remaining root preparations in a supported manual checkpoint. A limit of one has been allowing the request that reaches the manual tool, then blocking the next preparation after restore with `NativeError.code === 'max_model_steps_exceeded'`. A limit of two has been permitting that next preparation. `agent.run(null, { state, maxModelSteps: 5 })` has been throwing `TypeError` with `Cannot replace the model step budget when resuming a run`.

Independent submissions have been starting fresh. Provider retries, child work, and SDK output repairs have been retaining the separate [model-step contract](tools.md#limit-model-steps). Combining `maxModelSteps` with `budget` has been keeping the active `RunBudget` capture restriction. Python has not been offering `maxModelSteps`.

### Distinguish waiting from stopping

A pending request has been keeping its Turn live. `turn.cancel()` has been stopping the captured root and joining its cleanup; `session.interrupt()` has been acknowledging a stop request with its selected scope. Session closure has been joining owned cleanup. These operations have not been saving an arbitrary instruction pointer. A later submission has been starting a new root, and stored history has not been restarting the interrupted Turn automatically.

With `budget: { maxRequests: 1 }`, approval has been remaining able to run the callback after the first model admission. The next admission has been rejecting with `run_budget_exceeded`, while the accepted effect has been remaining recorded. Token and cost limits have been checking before the next admission; an admitted completion has been remaining able to overshoot and finish. Application receipts have been supplying evidence for uncertain effects before any retry.

### Verify the combinations

From the repository root with the matching native build and test dependencies active, this command has been selecting the synthetic loopback budget and model-step cases:

```sh
pnpm exec vitest run packages/agents-codex/test/native/run-budget-native.test.ts packages/agents-codex/test/native/model-preparation-cap.test.ts
```

[The budget suite](../../../packages/agents-codex/test/native/run-budget-native.test.ts) has been exercising live manual replies, approval budgets of one and two admissions, rejected capture, idle portable restore, and settled local/custom-store reopen. [The model-step suite](../../../packages/agents-codex/test/native/model-preparation-cap.test.ts) has been asserting remaining steps and blocked replacement after manual suspension. [The approval suite](../../../packages/agents-codex/test/native/function-approvals-native.test.ts) has been covering unbudgeted fresh-process restore and accepted siblings. These fixtures have not been establishing live-provider billing or same-turn `RunBudget` recovery. The automatic-turn and interruption rows have been reflecting source contracts and neighboring lifecycle tests, rather than a full budget-by-storage interruption matrix.
