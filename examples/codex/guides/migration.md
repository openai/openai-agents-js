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

## 1. Record the workflow's behavior

Before editing, run the application's existing checks and save representative inputs and expected outcomes. Inventory:

- Agents, dynamic instructions, application context, and custom Model or ModelProvider implementations.
- Function schemas, hosted tools, MCP servers, tool approvals, guardrails, handoffs, and Agent tools.
- Streaming consumers, cancellation, deadlines, retries, errors, tracing, and resource cleanup.
- Session stores, serialized RunState, pending approvals, and external effects whose outcomes must survive a restart.

For each item, choose a native equivalent or record the application change it needs. Preserve business behavior, permissions, and validation requirements. Matching method names alone does not establish equivalent behavior.

Check Node.js 24, platform support, the native addon, and helper assets using the [installation requirements](installation.md#requirements). Install Zod 4 for native function schemas. Keep credentials in the server environment. Verify that the selected provider supports Responses and that the selected model supports the tools and output mode you need.

## 2. Port one complete workflow

In v0, a Runner owns execution:

```ts
import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';

const greeting = tool({
  name: 'greeting',
  description: 'Greet someone by name.',
  parameters: z.object({ name: z.string() }),
  execute: ({ name }) => `Hello, ${name}!`,
});
const agent = new Agent({
  name: 'Assistant',
  instructions: 'Use greeting, then repeat its result.',
  tools: [greeting],
});
const result = await new Runner().run(agent, 'Greet Ada.');
console.log(result.finalOutput);
```

For native v1, declare native tools and run the native Agent directly. Run these examples in an ES module with top-level await, or put the calls inside an async function. The native example needs a matching build and `OPENAI_API_KEY` for a live run:

```ts
import { Agent, NativeProvider, tool } from '@openai/agents';
import { z } from 'zod';

await using provider = new NativeProvider();
const greeting = tool({
  name: 'greeting',
  description: 'Greet someone by name.',
  parameters: z.strictObject({ name: z.string() }),
  execute: ({ name }) => `Hello, ${name}!`,
});
const agent = new Agent({
  name: 'Assistant',
  instructions: 'Use greeting, then repeat its result.',
  tools: [greeting],
  provider,
});
const result = await agent.run('Greet Ada.');
console.log(result.finalOutput);
```

`agent.run()` closes its Session before returning. The explicitly supplied provider is shared configuration and has its own lifetime; this example disposes it after the run. For a conversation, open a Session, await each submission, and keep its Turn:

```ts
await using session = await agent.session();
const first = await session.submit('Greet Ada.');
console.log((await first.wait()).finalOutput);
const second = await session.submit('Now greet Grace.');
console.log((await second.wait()).finalOutput);
```

This fragment reuses the native Agent and provider above. Keep it inside the provider's lifetime. Close all its Sessions before disposing the provider. Reusing an Agent alone does not preserve conversation history. See [Agents and sessions](sessions.md).

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

## 3. Choose where existing conversations finish

Keep active v0 or v1 classic runs, pending approvals, and serialized RunState on their original runtime until they settle. Keep the original Agent and tool graph needed to resume them. Native `SessionState` cannot restore a classic RunState, and changing imports does not convert a classic Session store.

For the simplest cutover, finish existing conversations on their current v0 deployment and start new conversations on native. If you chose a staged migration, finish those conversations on the validated v1 classic deployment. If a new native conversation needs prior business context, supply an application-reviewed summary as fresh input. Decide which facts may cross into the new conversation, and preserve any audit record separately. A summary does not resume old tool calls, transfer reply authority, or prove an external action completed.

Choose native [state and storage](state.md) for new work. Test checkpoint restore with current tool implementations and permissions. Checkpoints exclude current credentials, callback implementations, and workspace files. Reconcile uncertain external effects with the owning service before deciding whether to retry them. Native and existing v0 or v1 classic state require separate stores and explicit routing during cutover.

## 4. Validate and cut over

A frontier coding agent can confidently carry out this migration using the instructions here, the application's source, and concrete validation. Give the agent a complete workflow and acceptance criteria. Review the resulting changes and evidence before routing production work to the new runtime.

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

## Use classic for a staged migration

When a concrete dependency blocks the direct port, move that workflow's imports together:

```ts
import { Agent, Runner, tool } from '@openai/agents/classic';
```

Use `@openai/agents/classic/realtime` for retained Realtime APIs, with the corresponding classic testing, sandbox, and utility subpaths where needed. Continue using the classic Runner and its original contracts. Verify saved state with the installed build and keep classic objects out of native execution. The [classic guide](../../../packages/agents/CLASSIC.md) lists the retained imports and branch-specific additions.

Record why classic is needed and what will unblock the native port. Each independent workflow can move when its native implementation and validation are complete; importing classic does not switch other workflows away from native.
