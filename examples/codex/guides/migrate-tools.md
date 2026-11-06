# Use classic tools in a migrated run

After [configuring a supported classic Agent and Model](migrate-models.md), choose how a tool should finish. A function can return data to the parent or finish its run. An Agent tool runs a specialist and returns to the parent. A terminal handoff transfers control to one other Agent.

The migration adapter supports a separate in-process approval flow for one ordinary function. Choose that flow when your application must decide whether the function runs.

## Finish with a tool result

The default `toolUseBehavior: 'run_llm_again'` continues with another Model call after tools. `resetToolChoice` uses the existing SDK rule: after an accepted function result, the default `true` clears the next tool-choice hint except `none`; `false` retains it. These settings apply to the selected Model. The admitted declaration still governs native function permissions.

`stop_on_first_tool`, `{ stopAtToolNames: [...] }`, and callable tool-use policies can finish with validated final output.

A callable receives the original `RunContext` and standard SDK `FunctionToolResult` records in issued-call order. These records include the original tool objects and checked JSON callback values. The adapter snapshots those values separately from accepted wire text.

The output depends on the policy and output type:

- Built-in stop policies use the SDK's `toSmartString` conversion.
- A callable final decision must provide a string.
- For a supported object `outputType`, the captured schema validates that string after cleanup. Output guards, `agent_end`, and `finalOutput` receive the checked object.

### Completion and cleanup

Tool finish waits for the complete batch's output validation and true native acknowledgments. It then force-stops the owned Turn and joins native, callback, producer, carrier, and provider cleanup before the common output guards and `agent_end`.

The result's `native.outcome` reports the actual `turn_aborted` event with reason `interrupted`. `modelResponses` contains only actual Model responses, and result items retain the accepted tool history. Caller abort, an unrelated native error, a guardrail tripwire, or a cleanup failure rejects the run.

## Use an Agent as a native tool

Add a tool returned by a classic Agent's `asTool()` method to a supported parent Agent. `SDKRunner` runs the original child Agent through a separate native invocation, then resumes the same parent with the extracted text. Both Agents must satisfy the migration contract. The adapter requires the registered Agent tool and its original callable. A copied marker does not make another tool eligible.

### Child configuration

The child receives the exact resolved `RunContext`, including the application context and SDK usage. The child retains its own Agent configuration. It inherits defaults only from the parent's run-level model, provider and model settings, following the existing nested run configuration rules.

For example, given application-supplied `childModel` and `parentModel` objects:

```ts
import { Agent } from '@openai/agents/classic';
import { SDKRunner } from '@openai/agents/migration';

const child = new Agent({
  name: 'Summarizer',
  instructions: 'Summarize the supplied text.',
  model: childModel,
});
const parent = new Agent({
  name: 'Editor',
  instructions: 'Use summarize, then explain the summary.',
  model: parentModel,
  tools: [child.asTool({ toolName: 'summarize' })],
});
const result = await SDKRunner.run(parent, 'Summarize this text: ...', {
  context: { documentId: 'draft' },
});
console.log(result.finalOutput);
```

### Output extraction and cleanup

Default extraction and `customOutputExtractor` run only after the child's output guardrails and cleanup succeed. The custom extractor receives the completed migration result, including the child's actual native session and turn IDs. Its `agentToolInvocation` contains the original SDK call name, ID and argument text. The result has no classic `RunState`. The nested SDK invocation is separate from the native child-actor API.

This route supports approval-free Agent tools with text output. Manual approval still supports only ordinary function tools.

The adapter checks each child's declarations before resolving its provider or calling its Model or tools. The adapter does not roll back earlier parent work. Live Agent-tool event handlers, resume state, general handoffs and unsupported nested run settings remain rejected through the tool's existing error policy. No rejected path falls back to the classic Runner.

Parent cancellation reaches the child and waits for its started callbacks and producers. Native cleanup can initially fail with `MigrationCleanupError`, retaining the original abort cause and `TurnAborted`. A child cleanup failure also rejects the parent with `MigrationCleanupError`, even when the ordinary tool error policy would return error text. Call `retryCleanup()` on that error to retry unfinished parent and child cleanup. This retry does not rerun either Model or any tools.

## Transfer to one terminal Agent

Use this route when a target Agent should take over instead of returning a tool result to its parent. Add that target to the source Agent's `handoffs` array. Declare exactly one handoff to a distinct target with no further handoffs. Both Agents must use text output and the same explicit classic `Model` object. Run the source through `SDKRunner.run()` with response invocation, the default `modelInvocation: 'response'`.

The target becomes active only after the native runtime accepts the transfer. Its instructions, settings, tools, output guardrails and end listener then apply. If the Model does not choose the handoff, the source remains active. A completed result's `lastAgent` identifies the actual final Agent.

Source tools, target tools and the handoff must have distinct names.

This route supports the declared per-handoff `inputFilter`, not general run-level handoff filtering. Filtering does not undo earlier effects.

It accepts supported completed caller history as Model context. It rejects Agent tools, held approvals and Session storage. `SDKRunner.stream()` and mixed output schemas remain unsupported for handoffs. The handoff transfers work within the native run. It does not create a native child or transfer classic RunState. Keep broader handoff graphs and unsupported combinations on the classic runtime.

## Hold one function for approval

Try the two decisions from the checkout root. Both runs use a scripted Model.

```sh
pnpm exec tsx examples/codex/migration-approvals.ts
pnpm exec tsx examples/codex/migration-approvals.ts reject
```

Pass `approvals: 'manual'` to `SDKRunner.run()` to opt in to one held function call. This option supports one enabled registered function with static `needsApproval: true` or `false`, and at most one function call in the run. Dynamic approval predicates, batches, repeated calls, child calls and portable paused state remain unsupported. Ordinary runs still reject approval-bearing tools. `SDKRunner.stream()` rejects this opt-in before execution.

### Paused carrier

Configured text or supported object output retains its existing validator and result type. The run returns its usual completed result or a live carrier with `status: 'paused'`. A paused carrier exposes `interruptions`, the original `lastAgent` and `runContext`, and the actual native session, submission, turn and call IDs. Each interruption is an SDK `RunToolApprovalItem` built from the actual Model call. It has no `finalOutput`, completed history or RunState.

The selected Model and native callback owner remain alive while the call is held. The carrier records the pause, but its status and retained item metadata do not prove that the native call remains live. Decisions recheck the live owner.

### Decide and join continuation

To apply a decision:

1. Call `paused.approve(item)` or `paused.reject(item)` with that exact live item. Choosing a decision alone does not execute the tool.
2. Call `await paused.continue()` to consume the choice once. Repeated `continue()` calls await the same completion promise rather than repeating effects.

Approval rechecks the current native call before the SDK invocation. The parser, tool guards and hooks retain their normal invocation path after consent. Rejection executes no SDK tool code and sends the supported refusal text through the existing native response and true acknowledgment path. Copies, foreign items, duplicate choices and expired decisions fail.

Pass an AbortSignal when the application may cancel. Cancellation revokes the pending decision and `paused.completed` joins the entered owners. An application callback that has already entered must finish before that join can settle. A late decision cannot restart it. Cleanup failure retains `MigrationCleanupError.retryCleanup()`, which retries cleanup only. Never start a new run to replay an action whose effects are uncertain.

### Approval scope

Start this route with fresh native input. Keep pending legacy work on its original runtime until it settles. Agent tools and handoffs cannot use this approval opt-in. See [the complete held-function example](../migration-approvals.ts), which demonstrates approval and rejection without model credentials.

Approval applies to an SDK function held by the native runtime in the same process. It is not a native `ApprovalRequest` or `NativeQuestion`, and it does not change the native approval policy for other tool families. The carrier is neither a portable checkpoint nor legacy RunState.
