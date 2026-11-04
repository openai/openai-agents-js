# A2A with native agents

`@openai/agents/a2a` connects native agents to remote A2A agents. It uses the official `@a2a-js/sdk@1.0.1` client and server interfaces for A2A protocol 1.0 over JSON-RPC. Install that optional package before importing this entry point. The base `@openai/agents` entry point does not import A2A.

The application chooses each remote address and authorizes each operation. The adapter does not discover arbitrary URLs from model arguments or remote metadata. `A2AEndpoint` contains a stable name, the exact anonymous card URL, and the exact RPC URL. The card must advertise that same RPC URL, protocol version `1.0`, and binding `JSONRPC`. Redirects, embedded URL credentials, other protocol versions, and tenant-selected interfaces are unsupported. HTTPS is required except for explicit loopback HTTP examples.

## Connect to a remote agent

```ts
import { connectA2A } from '@openai/agents/a2a';

const client = await connectA2A(
  {
    name: 'research',
    cardUrl: 'https://agents.example.org/research/card',
    rpcUrl: 'https://agents.example.org/research/rpc',
  },
  {
    authorization: async (operation) => credentials.bearerFor(operation),
    parentTrace: toolContext.traceContext,
    signal: toolContext.signal,
  },
);
```

Discovery sends no credentials. After the card passes admission, the adapter resolves the current bearer token for each RPC operation. The token never enters an endpoint, receipt, public Task, or error message. Use `fetch` to supply the host's approved egress implementation. `parentTrace` explicitly carries the caller's trace parent; the adapter does not inspect ambient trace state.

The returned client is the official A2A `Client`. Direct callers must treat an uncertain mutation acknowledgment as an unknown outcome; message IDs do not make creation idempotent. This profile supports `sendMessage`, `getTask`, and `cancelTask`. It uses polling rather than streaming, push notifications, extended cards, or remote callback execution. Native input supports text and inline PNG, JPEG, GIF, and WebP images. File URLs, arbitrary URIs, and other file types fail before native admission. Result validation remains the application's responsibility.

`A2ALimits` sets `bodyBytes`, `inputBytes`, `checkpointBytes`, and `timeoutMs`. Defaults are 2 MiB, 1 MiB, 8 MiB, and 30 seconds. The HTTP reader stops before buffering more than `bodyBytes`. These bounds are adapter defaults, not service quotas. The host should also bound incoming HTTP bodies before protocol parsing.

## Deferred remote work

`A2AJobProvider` implements the existing `JobProvider` contract. Register it with `DeferredTools`, a host `JobJournal`, and a current result projection. Set `requireReconciliation: false` only for work whose uncertain outcome the host can handle. Generic A2A cannot prove whether a lost create was accepted.

The provider requires separate callbacks for current authorization, credential resolution, durable mutation reservation, input encoding, and result validation. Authorization checks the current principal, immutable native invocation binding, and claim generation. After discovery and local validation, the provider resolves credentials, checks authorization again, spends one mutation reservation, and sends once. A timeout or lost create, input-reply, or cancel acknowledgment returns `unknown`. It never resends that mutation. A known receipt binds the endpoint and original native invocation. A fresh worker observes that same remote task with `getTask`; it does not create another task.

`inputRequired` exposes a remote challenge. `A2AInputReply` supplies its task ID, context ID, challenge, generation, and JSON `result`. The provider reads the current remote task before reserving a reply. Python and TypeScript share one wire profile: the status message contains one data part `{challenge, generation, tool, arguments}`; a reply contains exactly `{challenge, generation, result}`. Task and context IDs belong in the A2A message envelope. Structured completion artifacts contain `{result: output}`; string results remain text parts. `authRequired` remains a host credential flow and never becomes a generic approval answer. A host must not accept untrusted remote approval text as authority to perform local actions.

## Serve a native agent

`NativeA2AExecutor` implements the official `AgentExecutor`. Pass it and one `NativeA2AStore` to the official `DefaultRequestHandler`. The host authenticates requests, builds `ServerCallContext`, serves the card, and owns HTTP routing. The adapter supplies no authentication database or application server.

`agentFactory(binding, callContext)` returns current trusted Agent configuration, application context, and optional `parentTrace`. The binding contains the authenticated principal, tenant, task ID, and conversation context ID. Saved checkpoints and inbound metadata never supply configuration or credentials. Each task gets its own native Session, including tasks that share a conversation context. The factory can read the current authenticated `ServerCallContext`, validate its transport headers with `TraceContext`, and choose an admitted trace parent.

Ordinary function tools use native execution and cleanup. The resumable profile supports one settled root manual request. Native `Session.suspend()` owns checkpoint admission; live callbacks, multiple pending requests, and unsupported nested states cannot become resumable A2A input requests. Before consuming a reply, the adapter checks its challenge and generation and validates its answer against the current manual declaration. Invalid answers preserve the waiting checkpoint. A fresh native Session restores the checkpoint and issues a current reply grant. A repeated, foreign, or changed declaration cannot reuse that grant.

Explicit cancellation closes the active native Session and joins its cleanup. Closing an HTTP observer does not cancel the task. Cancellation cannot undo external effects that already completed. A settled native completion may win a concurrent cancellation.

## Host storage and recovery

`NativeA2AStore` extends the official `TaskStore`. The same object stores private native records and public A2A Tasks. `own(binding, callback)` grants exclusive host ownership across workers. Its claim checks ownership after asynchronous work and atomically compares and replaces the private record. Hosts implement leases and database transactions; the SDK does not implement a distributed job engine.

`generation` controls private record replacement. `publicationRevision` names a desired public snapshot. They serve different purposes. A commit retains the checkpoint or terminal outcome together with that exact desired snapshot before the executor publishes its full Task event. The official `ResultManager` calculates the snapshot, including history and artifact merging.

The official JS store has no CAS/version argument. The host's `save` must reject stale snapshots against its current private revision. It acknowledges a revision only after the exact desired snapshot is durable. `claim.published(revision)` joins that acknowledgment before execution advances to another revision. A lost save or acknowledgment leaves the desired snapshot available for recovery.

The official request handler also saves an authenticated history append before calling the executor for a follow-up. Permit that history-only save without acknowledging a publication. When no local event bus exists, official cancellation directly saves a canceled Task. The host must atomically retire a waiting private checkpoint on that save. For active work on another worker, reject the save until the owner has joined cancellation. Public reads, lists, subscriptions, cancellation, and follow-ups must all enforce the current principal.

After the prior execution owner and all its official event consumers have stopped, the host calls `executor.recover(binding, currentContext)`. Recovery saves the retained desired snapshot through the same official store. It never invokes the Agent factory or native execution. Crashed `running` and `claimed` records become `unknown` outcomes, represented as failed public Tasks with `agents.a2a.outcome: 'unknown'`. Recovery does not claim to reverse side effects.

The example store in `examples/a2a/store.ts` demonstrates this contract in one process. It loses all data on restart and is unsuitable for production recovery. The `two-agents.ts` example hosts two independent native agents, selects two tools from a 500-entry host catalog, and correlates each remote request with its original coordinator tool call. It uses deterministic local model responses and needs no API key. Run it after building the native binding:

```sh
pnpm exec tsx packages/agents/examples/a2a/two-agents.ts
```
