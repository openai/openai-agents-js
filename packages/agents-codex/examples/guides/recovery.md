# Check capabilities and recover work

Use capability reports to inspect what a Session admitted, readiness checks to inspect a possible checkpoint boundary, and external service records to reconcile uncertain effects. These records answer different questions.

| Task | Start here |
| --- | --- |
| Check a feature before using it | [Live capabilities](#live-capabilities-and-checkpoint-advice). |
| Inspect whether portable capture is currently possible | [Check capture readiness](#check-capture-readiness). |
| Confirm an uncertain external operation | [Reconcile external effects](#reconcile-external-effects). |
| Continue a manual tool's durable job after a host restart | [Resume external work](#resume-external-work). |

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

Readiness follows the actual root output contract, including `submitWithOutput()` overrides and owned successors. A bare `z.string()` override can create an eligible plain root in a Session opened with structured output. A settled native-schema root can transfer with its matching active output contract when current manual declarations and the portable configuration permit it. A settled prompted root supports explicit manual suspension when the portable configuration permits it. A later `saveState()` or `suspend()` performs its own checks and may fail if the boundary changes.

## Reconcile external effects

A checkpoint is not an external-effect receipt. If an application's effect outcome is unknown, check it with the application-owned service before continuing. Keep the original application effect key when the restored Session gets a new ID. Reply with the result confirmed by the service through a fresh restored manual request. Do not automatically repeat an uncertain effect.

For persistent conversations, follow the backend-specific procedure: [custom-store reconciliation](session-store.md#reconcile-an-unresolved-tool-intent) or [native-profile recovery](local-state.md#persistence-failures-and-cleanup).

## Resume external work

Use `DeferredTools` when a manual tool starts work that must survive a host restart. Import it from `@openai/agents/experimental/deferred`. The application supplies a durable journal and a fixed provider. The SDK binds them to the current manual request.

Declare the tool with `deferredTool()`, using its supplied schema builder for parameters and results. Add that exact declaration to the Agent's tools and register it with the coordinator. Use `deferredDefault()` for supported scalar defaults. The deferred route accepts a restricted, lossless JSON schema; ordinary `manualTool()` remains available for application-defined validation and replies.

`jobs.prepare(session, request)` seals the pending root and writes its exact checkpoint and request bindings through the journal. It makes no provider call. Restore that checkpoint through the Agent, find the fresh request, and call `jobs.advance(restored, request)`. A continued outcome supplies the original `Turn<unknown>`; pending siblings may still need replies. Other outcomes leave provider polling to the host.

For one scoped operation, `jobs.start(session, request, options, callback)` prepares, reopens and advances, then lends the reopened Session to the callback. It closes that Session when the callback finishes. Preparation and advancement share a deadline; the callback has its own lifetime. The operation captures the original opening configuration, including credentials and output defaults. Changed Session tools or instructions require explicit preparation and restore.

Set credentials before opening the original Session. If no API key was captured, `start` rejects before preparation and leaves the original request available for an ordinary reply.

The journal must enforce current application authority, immutable request bindings and conditional ownership before each operation. A lost creation acknowledgment requires provider reconciliation; the SDK never retries plain creation. `requireReconciliation: false` permits a provider whose uncertain creation remains unknown. Method presence alone does not establish duplicate prevention.

Keep provider keys, receipts and credentials in private host storage. The registered `project` function selects a small validated result for the model. Options use milliseconds. Caller abort waits for local work but does not cancel the external job. Remote cancellation requires an explicit authorized `cancel` operation. This route supports portable plain and prompted manual roots, not local storage, child grants, Environment sessions or native structured-output pending roots.

See [Run an external job across processes](../../EXTERNAL_JOBS.md) for the complete journal, provider and recovery example.
