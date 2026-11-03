# Resume an MCP task

`MCPTasksProvider` connects one deferred tool to one approved remote MCP tool. The application owns the journal, authorization and scheduling. See [Public results for external jobs](EXTERNAL_JOBS.md) for the shared `DeferredTools` contract.

## Install and import

Use Node.js 24, the SDK's supported runtime. Install the optional package versions declared by this SDK build in your application:

```sh
pnpm add @modelcontextprotocol/client@2.4.0 @modelcontextprotocol/core@2.4.0
```

Import the two public symbols through the optional entrypoint:

```ts
import {
  MCPTasksProvider,
  MCPInputReply,
} from '@openai/agents/experimental/mcp-tasks';
```

CommonJS applications can use `require('@openai/agents/experimental/mcp-tasks')`. Both entrypoints report which packages to install when an optional dependency is missing. Use `@openai/agents/experimental/deferred` for `DeferredTools` and `deferredTool`.

The peer must support protocol `2026-07-28` and the `io.modelcontextprotocol/tasks` extension. The adapter does not fall back to an older protocol or retry creation. This is a separate external-job adapter; ordinary `HttpMCP`, `StdioMCP`, and `selectMcpTools` calls do not use this Tasks protocol.

## Keep authority in the application

Construct the provider with a fixed `endpoint`, `tool` and trusted `fetch`. The endpoint must use HTTPS, or HTTP on localhost, 127.0.0.1 or ::1. Model arguments cannot select another endpoint or tool.

`authorize(claim, operation, context)` must check the current principal, binding and journal generation. Return the current bearer token without its `Bearer ` prefix. Authorization runs at operation entry and before each HTTP request. Honor `context.signal`. Configure host egress before admitting a job; the adapter does not choose a proxy or alternate route. It refuses redirects. `timeoutMs` defaults to 10,000 milliseconds per adapter operation, including entered host callbacks and network work. Cooperative cleanup can outlast the deadline. The enclosing `DeferredTools` call has its own timeout.

Register the provider with `requireReconciliation: false` only for approved, low-impact work. The protocol cannot prove whether a lost creation request took effect. A lost creation reply leaves the job `unknown`, without a receipt. Preserve the journal's start reservation and original checkpoint. Do not start another job to recover that order.

Keep tokens, task receipts, form prompts, answers, order IDs and database paths in private application storage. Do not put them in model arguments, tool descriptions or public metadata. `admitPending(claim, taskId, requestsJson)` must synchronously return exactly `true` before the adapter retains a new task ID or form. `requestsJson` is `null` at creation, or the full form mapping encoded as canonical JSON. Check task IDs, keys, prompts, and schemas against trusted per-job data. A refused creation becomes `unknown` without a receipt; a refused form preserves its accepted receipt. Restore that policy after restart and verify or quarantine old journal rows.

Completed peer content is withheld by default. `admitResult` may return host-verified finite JSON under `structuredContent`. Use the registered `project` function to choose the final model-visible fields. `DeferredTools` validates, bounds and saves that public result before delivery.

## Observe or answer saved work

The application schedules future advances. Pending updates carry a private wall-clock `value.pollAt`, derived from the peer's polling interval. An early observation still checks current authorization but can return the saved update without HTTP. A due observation reads once; the adapter has no background polling loop.

Before creation, tool discovery reads at most 32 pages. A continuation cursor on page 32 refuses creation before `tools/call`.

Input replies default to disabled. Enable `allowInputReplies` only for a target that permanently binds request keys to immutable requests and rejects retired or satisfied keys. Construct `MCPInputReply` from the exact saved `challenge` and host-approved `responses`. It captures detached action/content values. Submit it through `jobs.advance` with `operation: 'respond'` and `response: reply`. A changed challenge returns current task truth without sending the obsolete answer. The saved `inputRequired` update carries `value.requests` and `value.challenge`. Supported forms contain flat strings, booleans, finite numbers, and string arrays, including enum choices. Nested forms and other validation constraints are refused.

For example, after validating the saved challenge and approving its `audience` request in host code:

```ts
const reply = new MCPInputReply({
  challenge: savedChallenge,
  responses: {
    audience: { action: 'accept', content: { audience: 'general' } },
  },
});
const outcome = await jobs.advance(restored, request, {
  operation: 'respond',
  response: reply,
});
```

Here `audience` is the exact admitted request key, and its content must match that request's saved schema. `restored` and `request` are the restored Session and freshly matched deferred request. This fragment also requires an enabled reply policy and the durable mutation callback below. To request cancellation, call `jobs.advance(restored, request, { operation: 'cancel' })`. Both mutations re-read remote task truth before dispatch, even when its next poll time has not arrived.

Both replies and cancellation require `reserveMutation(claim, reply, context)`. The `reply` is the captured `MCPInputReply`, or `null` for cancellation. After obtaining the final current credential, the adapter asks this callback to commit a durable reservation immediately before dispatch. The host must check the full binding, generation and approval, and reserve all selected keys atomically. Only exactly `true` permits dispatch.

A lost mutation acknowledgment preserves the receipt and leaves the reservation spent. Do not replay the mutation. A host journal can instead authorize a read-only observation of that receipt. A cancellation acknowledgment means `pending`, not confirmed remote termination. Caller abort joins local work; it does not cancel the remote task.

## Run the local example

The [MCP thumbnail example](examples/mcp-tasks.ts) uses the shared application-owned SQLite journal. It requires Node.js 24 or later, a local POSIX filesystem, and built checkout packages and native runtime. Follow [the external-job setup](EXTERNAL_JOBS.md#run-the-process-restart-example) for private directory requirements.

Start trusted local MCP and Responses-compatible model peers separately. Supply their ports; this command does not provision either service:

```sh
pnpm exec tsx packages/agents/examples/mcp-tasks.ts run ORDER --directory /private/state --mcp-port PORT --model-port PORT
```

Both connections use `127.0.0.1` and a synthetic `local-only` credential. No external API key is needed for those local peers. Reuse the same order and directory when advancing saved work. The application prints its current outcome and closes its local resources.

This example handles one thumbnail call per order. It admits UUID task IDs, rejects forms, and leaves replies disabled. It exposes only a bounded byte count reported by the trusted peer. It does not demonstrate mutation reservations, distributed persistence or a production authorization service. Its local journal and lock files must remain outside model-visible mounts.
