# Migrate from v0 to native v1

You can stay on v0; upgrading is optional. When you upgrade, migrate directly to the native v1 API in one change if you can validate the whole workflow. Use v1 classic only when you need a staged migration, such as keeping an existing custom Model or completing conversations on the classic runtime.

This guide describes the current source checkout. Native v1 is under development; the downloadable `0.22.0-alpha.1` starter contains an earlier API. Follow the [installation guide](installation.md) for a matching build, or [build the current source](building.md). The v0 examples use the stable `@openai/agents@0.21.0` API.

## Choose the destination

| API | Imports | Execution and state |
| --- | --- | --- |
| v0 | `@openai/agents` in v0.21.0 | TypeScript Agent and Runner, classic Session stores, and RunState. |
| v1 native | `@openai/agents` in this checkout | Native Agent, live Session, and Turn backed by embedded Codex. |
| v1 classic | `@openai/agents/classic` in this checkout | Retained TypeScript Agent and Runner with their classic contracts. |

Changing a v0 root import to a v1 root import changes the runtime. Port declarations and execution together. Native Agent objects and classic Agent objects are separate types; each must run through its own runtime. The experimental `SDKRunner` bridge and `/migration` entry points have been removed.

Classic is available and is not deprecated now. The lifecycle plan is to deprecate classic in a future v1 minor release and remove it in v2. No date is set. Prefer a direct native migration so you avoid an intermediate import migration and a second runtime migration.

## 1. Install a matching build

Use Node.js 24 and follow the [installation requirements](installation.md#requirements). Build the SDK and examples from the same committed checkout using [Build from source](building.md#build-from-source). For an external application, use that checkout's [five-package bundle](building.md#build-a-local-bundle-for-an-application). Keep its source commit, build record, and lockfile together. The older four-package preview starter belongs with its included example.

## 2. Port one read-only lookup

The [small example](../migration/README.md) looks up an order for the current customer and returns a typed answer. It has one Agent and one read-only tool. Compare the complete [released-v0 implementation](../migration/v0/app.mts) with the complete [native implementation](../migration/native.ts). The example's offline checks exercise the real released v0 SDK and the current native runtime with scripted model responses.

The snippets below make live model requests when you run them; they need `OPENAI_API_KEY`. Use the [offline checks](../migration/README.md#check-the-lookup-offline) to try the example without a model key.

Both implementations receive this application context and return the same fields:

```ts
interface SupportContext {
  customerId: string;
  orders: readonly {
    customerId: string;
    orderId: string;
    status: string;
    tracking: string;
  }[];
}

const context: SupportContext = {
  customerId: 'CUSTOMER-7',
  orders: [
    {
      customerId: 'CUSTOMER-7',
      orderId: 'ORDER-42',
      status: 'shipped',
      tracking: 'TRACK-42',
    },
  ],
};
```

Application context stays outside model-visible input. The tool checks customer ownership and returns only the order fields that the model needs.

### Before: released v0

The following declarations use `@openai/agents@0.21.0`. Combine them with the context above in a separate ES module. The [v0 application](../migration/v0/app.mts) packages this code as a function so tests can supply a scripted Model. Keep v0 imports outside the native workspace.

```ts
import { Agent, Runner, tool, type RunContext } from '@openai/agents';
import { z } from 'zod';

const answerSchema = z.object({
  orderId: z.string(),
  status: z.string(),
  tracking: z.string(),
});
const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Read an order owned by the current customer.',
  parameters: z.object({ orderId: z.string() }),
  execute: ({ orderId }, run?: RunContext<SupportContext>) => {
    const order = run!.context.orders.find(
      (order) =>
        order.orderId === orderId &&
        order.customerId === run!.context.customerId,
    );
    if (!order) throw new Error('Order is unavailable to this customer');
    return {
      orderId: order.orderId,
      status: order.status,
      tracking: order.tracking,
    };
  },
});
const agent = new Agent<SupportContext, typeof answerSchema>({
  name: 'Order support',
  instructions:
    'Look up ORDER-42 and return its orderId, status, and tracking.',
  tools: [lookupOrder],
  outputType: answerSchema,
});
const result = await new Runner().run(agent, 'Where is ORDER-42?', { context });
console.log(result.finalOutput);
```

### After: native v1

Port declarations and execution together. Native tools receive `ToolContext`; native structured output uses a strict schema and an output mode. Run the Agent directly, with the same context above:

```ts
import { Agent, NativeProvider, tool, type ToolContext } from '@openai/agents';
import { z } from 'zod';

await using provider = new NativeProvider();
const answerSchema = z.strictObject({
  orderId: z.string(),
  status: z.string(),
  tracking: z.string(),
});
const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Read an order owned by the current customer.',
  parameters: z.strictObject({ orderId: z.string() }),
  execute: ({ orderId }, { context }: ToolContext<SupportContext>) => {
    const order = context.orders.find(
      (order) =>
        order.orderId === orderId && order.customerId === context.customerId,
    );
    if (!order) throw new Error('Order is unavailable to this customer');
    return {
      orderId: order.orderId,
      status: order.status,
      tracking: order.tracking,
    };
  },
});
const agent = new Agent<SupportContext, z.infer<typeof answerSchema>>({
  name: 'Order support',
  provider,
  model: 'gpt-4.1-mini',
  instructions:
    'Look up ORDER-42 and return its orderId, status, and tracking.',
  tools: [lookupOrder],
  outputType: { mode: 'native', schema: answerSchema },
});
const result = await agent.run('Where is ORDER-42?', { context });
console.log(result.finalOutput);
```

Use an ES module with top-level await, or place the calls in an async function. A live run needs `OPENAI_API_KEY`. The expected answer contains `ORDER-42`, `shipped`, and `TRACK-42`; model output can vary. The [offline checks](../migration/README.md#check-the-lookup-offline) validate the typed answer and customer-scoped tool result without a model key.

`agent.run()` closes its Session before returning. The supplied provider has a separate lifetime; `await using` disposes it after the run. For multiple user turns, use one live Session and wait for each Turn. See [Agents and sessions](sessions.md).

### Optional: change imports before porting

If a concrete dependency blocks the direct port, first change the v0 imports to classic:

```ts
import { Agent, Runner, tool, type RunContext } from '@openai/agents/classic';
```

Keep the v0 declarations and Runner calls. The [small classic example](../migration/classic.ts) exercises this intermediate step. When the dependency is ready, apply the same native port above. Classic is not required for the direct migration.

## 3. Check the application contracts

For the small lookup, verify the answer fields, lookup arguments, customer ownership, and cleanup. Add checks for the application's other contracts before porting a larger workflow. Keep a workflow on v0 or classic while a required custom Model, Realtime integration, active conversation, or durable state depends on that runtime.

### Port the contracts that affect behavior

| v0 contract | Native migration action |
| --- | --- |
| Custom `Model` or `ModelProvider` | Configure `NativeProvider` for a Responses endpoint. Classic Model objects are not native providers. Port the provider integration explicitly, or keep that workflow on classic until you can. |
| Runner model settings | Select the native Agent or opening model and supported `modelSettings`. Native settings differ from classic settings; inspect [configuration](session-configuration.md). |
| Instruction callbacks | Resolve application-dependent instructions before constructing or opening the native Agent. Native `instructions` is a string. Use [request preparation](request-preparation.md) only when its supported profile fits the required per-request edit. |
| Application context | Pass `context` to `run()` or `session()`, and port callbacks to native `ToolContext`. Context reaches the model only through instructions, input, or tool results. |
| Function tools | Recreate tools with native `tool()` and supported Zod schemas, including an empty object schema for no arguments. Port callback context, errors, result handling, and cancellation. |
| Guardrails and tool approvals | Reimplement the required input, output, and execution checks at the matching application boundary. Native function policies, manual tools, and native interactions have separate contracts; they do not replay classic guardrails or approvals. |
| `Agent.asTool()` and handoffs | Choose an application-owned specialist tool or native children according to who should own the work and history. A native child is not a drop-in classic handoff. |
| Hosted tools and MCP | Declare native tools and connections explicitly. Check each tool's model, transport, authentication, and storage requirements. |
| `outputType` | Choose native structured output or prompted JSON and test schema normalization, validation, and any repair attempts. |
| `maxTurns` and retry settings | Choose native model-step limits, budgets, cancellation, and provider settings deliberately. A native step limit does not reproduce a classic turn count or retry policy. |
| Streamed classic run items | Port the UI to native observations and read final success from `turn.wait()`. Bounded observation streams can report gaps. |
| Classic traces | Configure native telemetry and port consumers to its fields and lifecycle. |

Use the guides for [tools](tools.md), [output](output.md), [interactions](interactions.md), [MCP](mcp.md), [native children](executors.md#native-child-agents), and [telemetry](telemetry.md). The [specialist example](../input-retrieval-specialist/README.md#run-the-standalone-specialist) shows a separately configured Agent called through an application tool.

Independent integrations remain available. For example, native `selectMcpTools` can expose a selected classic MCP client through native tools; it does not run a classic Agent or convert its state. See [selected MCP clients](mcp.md#materialize-a-borrowed-sdk-mcp-namespace). The [sandbox environment](storage-mounts.md) also has its own connection and ownership contract. Realtime workflows can continue through the [classic Realtime imports](../../../packages/agents/CLASSIC.md#retained-classic-apis) while you assess their destination separately.

### Keep existing conversations on their runtime

Keep active v0 or v1 classic runs, pending approvals, and serialized RunState on their original runtime until they settle. Keep the original Agent and tool graph needed to resume them. Native `SessionState` cannot restore a classic RunState, and changing imports does not convert a classic Session store.

For the simplest cutover, finish existing conversations on their current v0 deployment and start new conversations on native. If you chose a staged migration, finish those conversations on the validated v1 classic deployment. If a new native conversation needs prior business context, supply an application-reviewed summary as fresh input. Decide which facts may cross into the new conversation, and preserve any audit record separately. A summary does not resume old tool calls, transfer reply authority, or prove an external action completed.

Choose native [state and storage](state.md) for new work. Test checkpoint restore with current tool implementations and permissions. Checkpoints exclude current credentials, callback implementations, and workspace files. Reconcile uncertain external effects with the owning service before deciding whether to retry them. Native and existing v0 or v1 classic state require separate stores and explicit routing during cutover.

## 4. Validate and cut over

Give a coding agent one complete workflow, the application's source, and acceptance criteria. Review its changes and validation evidence before routing production work to the new runtime.

Use this prompt in your application checkout:

```text
Migrate this application's v0 OpenAI Agents SDK workflow directly to the
native v1 API. Read the installed SDK's migration guide and source first.
Inventory imports, Agent/Runner usage, custom providers, tools, guardrails,
approvals, delegation, streaming, tracing, persisted state, and external effects.
Record the required business behavior and existing validation before editing.

Port declarations and execution together to native Agent, Session, and Turn.
Keep native imports at @openai/agents. Do not introduce SDKRunner, /migration,
auto engine selection, or automatic classic-to-native state conversion.
Use @openai/agents/classic only for a concrete workflow that must remain during
a staged migration; explain that blocker and keep its state separate.
Preserve authorization checks, schema validation, effect reconciliation,
cancellation, deadlines, cleanup, and error handling. Identify contracts that
need application redesign rather than assuming native and classic parity.

Run the application's type checks and focused tests. Add checks for successful
output, tool arguments and effects, refusal and approval, provider failures,
stream completion, cancellation cleanup, and save/restore where applicable.
Use fakes for external effects in offline tests. Do not call live providers or
perform external writes without authorization. Report changed files, verified
behavior, commands and results, and any validation gaps or unresolved blockers.
```

Before cutover, verify the following with representative application cases:

- Imports and types resolve against the intended v1 build. Every workflow uses the selected runtime's Agent, tools, and state.
- Expected answers and structured values pass application checks. Tool arguments, allowed effects, rejected operations, and approval decisions meet the original requirements.
- Streaming handles incomplete observations and still waits for the final result. Provider errors, deadlines, and cancellation stop the intended work and join cleanup.
- Restart and recovery keep the required history and do not repeat an uncertain business effect. Pending v0 or v1 classic work stays on its original runtime.
- Application metrics and traces let you compare failures and outcomes before and after cutover.

Start native traffic only after these checks pass. If you roll back, route new work to the tested prior v0 or v1 classic deployment, as appropriate. Leave native conversations with a worker that understands their native state. A code rollback does not convert native checkpoints into classic RunState.

## Optional advanced example

The [stateful order-support example](../migration/advanced/README.md) adds permitted and denied notifications, application-owned routing, two-turn history, actual released-v0 state continued on classic, reviewed-fact cutover, and native checkpoint restore. These scenarios are independent of the read-only walkthrough. Its checks preserve the runtime and state boundaries described above.

For retained Realtime APIs, use `@openai/agents/classic/realtime`. The [classic guide](../../../packages/agents/CLASSIC.md) lists the corresponding testing, sandbox, and utility imports. Record what blocks the native port and keep each workflow's objects and state with its runtime.
