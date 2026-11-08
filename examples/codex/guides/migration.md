# Migrate from v0 to native v1

You can stay on v0; upgrading is optional. When you upgrade, prefer a direct native port of one complete workflow. Use classic temporarily when a concrete dependency blocks that port.

This guide describes the native v1 API in `0.22.0-alpha.2`. Follow the [installation guide](installation.md) for a matching build, or [build the current source](building.md). The v0 example targets stable `@openai/agents@0.21.0`.

## Install a matching build

Use Node.js 24 and check the [installation requirements](installation.md#requirements). Build the SDK and examples from the same committed checkout using [Build from source](building.md#build-from-source). External applications need that checkout's [five-package bundle](building.md#build-a-local-bundle-for-an-application), build record, and lockfile. The older four-package starter cannot run this current-source example.

## Port one read-only lookup

Compare the complete [v0 application](../migration/v0/app.mts) with its [native port](../migration/native.ts). Both declare one Agent, one order lookup tool, typed customer context, and a typed answer. The tool reads only the current customer's order and returns `orderId`, `status`, and `tracking`. Application context reaches the model only through selected tool results.

[Run the offline checks](../migration/README.md) without a model key before trying live calls. They exercise these files with scripted model responses. The following excerpts show the execution change; each reuses its corresponding application file:

```ts
// v0: Runner owns execution.
import { Runner } from '@openai/agents';
import { v0Lookup } from './app.mts';
const result = await new Runner().run(v0Lookup(model), 'Where is ORDER-42?', {
  context,
});
```

```ts
// Native v1: run the native Agent directly.
import { NativeProvider } from '@openai/agents';
import { nativeLookup } from './native';
await using provider = new NativeProvider();
const result = await nativeLookup(provider).run('Where is ORDER-42?', {
  context,
});
console.log(result.finalOutput);
```

These excerpts need the typed context shown in the [test](../migration/v0/test.mts); the v0 call also needs a Model. The test uses a ScriptedModel. Live calls need provider credentials such as `OPENAI_API_KEY`.

Port declarations and execution together:

| v0 | Native v1 |
| --- | --- |
| `RunContext<SupportContext>` in callbacks | `ToolContext<SupportContext>` with direct `context` access |
| `z.object(...)` tool parameters and output | `z.strictObject(...)` schemas in this example |
| Agent `outputType: answerSchema` | `outputType: { mode: 'native', schema: answerSchema }` |
| `Runner.run(agent, input, { context })` | `agent.run(input, { context })` |
| Classic Model configuration | `NativeProvider` configured for a Responses endpoint |

Native and classic Agent objects are separate types. Changing the root import alone changes the runtime without porting the declarations. The experimental `SDKRunner` bridge and `/migration` entry points have been removed.

`agent.run()` closes its Session before returning. The supplied provider has a separate lifetime; dispose it after its Sessions close. For multiple turns, open one [Session](sessions.md) and await each Turn.

### Optional: use classic first

If you need a staged migration, change the v0 imports together:

```ts
import { Agent, Runner, tool, type RunContext } from '@openai/agents/classic';
```

Keep the v0 declarations and Runner calls. The [classic port](../migration/classic.ts) differs from the v0 application only in its SDK import and builder name. When the blocker is resolved, apply the same native port above.

Classic is available and is not deprecated now. The lifecycle plan is to deprecate it in a future v1 minor release and remove it in v2; no date is set. The [classic guide](../../../packages/agents/CLASSIC.md) lists retained APIs, including `@openai/agents/classic/realtime`.

## Check application compatibility

Record current behavior before editing. Validate the contracts your workflow uses:

- Port custom Models to Responses providers, or keep the workflow on its current runtime. Check model settings and limits instead of assuming classic parity.
- Resolve dynamic instructions in the application. Port [tools](tools.md), callback context, errors, approvals, and guardrails at the required application boundaries.
- Choose who owns specialist work, next-turn routing, and history. Native children are not drop-in classic handoffs; see the [specialist example](../input-retrieval-specialist/README.md#run-the-standalone-specialist).
- Check [structured output](output.md), streaming completion, cancellation, deadlines, cleanup, and [telemetry](telemetry.md) against representative inputs.
- Declare hosted tools and MCP connections explicitly. Independent adapters remain useful: [selected classic MCP clients](mcp.md#materialize-a-borrowed-sdk-mcp-namespace) can provide native tools without running a classic Agent. [Sandbox connections](storage-mounts.md) have their own ownership contract.

The existing [effects examples](../concurrency-effects/README.md) cover permissions, repeated writes, and cancellation. Reuse these patterns where needed rather than adding them to the initial lookup port.

## Keep state with its runtime

Finish active v0 conversations, pending approvals, and serialized RunState on v0, or on a validated classic deployment during a staged migration. Preserve the original Agent and tool declarations. Native `SessionState` cannot restore classic RunState or convert a classic Session store.

Start new conversations on native. If they need prior business facts, let the application review and select current fields as fresh input. A summary does not resume tool calls, transfer reply authority, or prove an external effect completed. After classic continuation, select its current result rather than stale v0 output. The [qualification check](../migration/README.md) exercises both direct and staged cutovers using actual released-v0 state.

Use native [state and storage](state.md) for native conversations. Restore checkpoints with current trusted declarations, permissions, and context; checkpoints exclude credentials, callback implementations, and workspace files. Reconcile uncertain effects before retrying. A rollback routes new work to the tested prior deployment and leaves native checkpoints with a compatible native worker.

## Validate before cutover

Run the application's existing checks and focused migration tests. Verify typed answers, tool arguments and results, permissions, provider failures, streaming completion, cancellation cleanup, and recovery where applicable. Compare outcomes before routing production traffic.

A frontier coding agent can confidently perform the migration when it has the matching SDK source, the application, and concrete tests. Give it these instructions and acceptance criteria:

```text
Port this v0 workflow directly to native v1. Read the matching SDK source and
migration guide. Record required behavior and baseline checks, then port Agent,
tools, context, output, provider configuration, and execution together.
Keep v0/classic state on its runtime. Start native conversations with only
application-reviewed current facts. Use classic temporarily only for a stated
blocker. Do not add runtime selectors or automatic state conversion.
Run focused checks without live model calls or external effects. Report changed
files, verified behavior, commands, and remaining compatibility gaps.
```
