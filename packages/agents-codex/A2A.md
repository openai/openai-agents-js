# A2A with native agents

`@openai/agents/a2a` connects native agents to remote A2A agents over A2A protocol 1.0 and JSON-RPC. It uses the official `@a2a-js/sdk@1.0.1` client and server interfaces.

## Run the two-agent example

Use a current source checkout for this integration. The `0.22.0-alpha.1` package does not export `@openai/agents/a2a`. Follow [Build the native SDK from source](examples/guides/building.md) with Node.js 24 and the pinned pnpm version, and build the native binding and TypeScript packages from the same checkout.

Keep optional dependencies enabled during installation so the checkout installs `@a2a-js/sdk@1.0.1`. If your application omits optional dependencies, install that package before importing `@openai/agents/a2a`. The base `@openai/agents` entry point does not import A2A.

From the repository root, run:

```sh
pnpm exec tsx packages/agents-codex/examples/a2a/two-agents.ts
```

Expected output:

```text
Both remote agents replied.
```

The [example](examples/a2a/two-agents.ts) starts two independent native agents on loopback HTTP listeners. A native coordinator selects two function tools from a 500-entry host catalog and calls the remote agents. Each request uses its original coordinator tool call ID as its A2A message ID. The three agents use deterministic local model responses, so you need no API key. The example closes the listeners after the run.

The fixed loopback bearer token and the [in-memory example store](examples/a2a/store.ts) are demonstration choices. The store loses all data on restart and is unsuitable for production recovery. A deployed service must provide its own authentication and implement the [storage and recovery contract](#host-storage-and-recovery).

## Choose an integration

Use the component that matches the operation your application needs. The loopback example combines the client and server integrations.

| Application task | Component | What your application supplies |
| --- | --- | --- |
| Call a remote agent directly or from a function tool | `connectA2A` | The admitted endpoint, current credentials, and handling for uncertain mutation outcomes. |
| Expose a native agent to remote callers | `NativeA2AExecutor` with the official `DefaultRequestHandler` | HTTP authentication and routing, a current Agent factory, and a `NativeA2AStore`. |
| Run remote work through native deferred tools | `A2AJobProvider` | `DeferredTools`, a `JobJournal`, mutation reservations, and input and result callbacks. |

## Connect to a remote agent

The application chooses each remote address and authorizes each operation. The adapter does not discover arbitrary URLs from model arguments or remote metadata. `A2AEndpoint` contains a stable name, the exact anonymous card URL, and the exact RPC URL. The card must advertise that same RPC URL, protocol version `1.0`, and binding `JSONRPC`. Redirects, embedded URL credentials, other protocol versions, and tenant-selected interfaces are unsupported. HTTPS is required except for explicit loopback HTTP examples.

This is an application-context excerpt for a function tool's `execute` callback. Your application supplies `credentials`, whose `bearerFor(operation)` resolves the current token. The SDK supplies `toolContext` to the callback. Replace both example URLs with the exact endpoint your host has admitted.

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

The returned client is the official A2A `Client`. Direct callers must treat an uncertain mutation acknowledgment as an unknown outcome; message IDs do not make creation idempotent.

This profile supports `sendMessage`, `getTask`, and `cancelTask`. It uses polling rather than streaming, push notifications, extended cards, or remote callback execution.

Native input supports text and inline PNG, JPEG, GIF, and WebP images. File URLs, arbitrary URIs, and other file types fail before native admission. Result validation remains the application's responsibility.

`A2ALimits` sets `bodyBytes`, `inputBytes`, `checkpointBytes`, and `timeoutMs`. Defaults are 2 MiB, 1 MiB, 8 MiB, and 30 seconds.

The adapter requests identity HTTP encoding and cancels responses that declare another encoding before reading their bodies. A custom `fetch` must preserve response encoding headers and body cancellation.

`bodyBytes` limits the chunks the adapter retains. The transport controls its own internal buffers. These bounds are adapter defaults, not service quotas. The host should also bound incoming HTTP bodies before protocol parsing.

## Serve a native agent

`NativeA2AExecutor` implements the official `AgentExecutor`. Pass it and one `NativeA2AStore` to the official `DefaultRequestHandler`. The host authenticates requests, builds `ServerCallContext`, serves the card, and owns HTTP routing. The adapter supplies no authentication database or application server.

`agentFactory(binding, callContext)` returns current trusted Agent configuration, application context, and optional `parentTrace`. The binding contains the authenticated principal, tenant, task ID, and conversation context ID. Saved checkpoints and inbound metadata never supply configuration or credentials. Each task gets its own native Session, including tasks that share a conversation context. The factory can read the current authenticated `ServerCallContext`, validate its transport headers with `TraceContext`, and choose an admitted trace parent.

Ordinary function tools use native execution and cleanup. The resumable profile supports one settled root manual request. Native `Session.suspend()` owns checkpoint admission; live callbacks, multiple pending requests, and unsupported nested states cannot become resumable A2A input requests.

Before consuming a reply, the adapter checks its challenge and generation and validates its answer against the current manual declaration. Invalid answers preserve the waiting checkpoint.

A fresh native Session restores the checkpoint and issues a current reply grant. A repeated, foreign, or changed declaration cannot reuse that grant.

Explicit cancellation closes the active native Session and joins its cleanup. If cleanup cannot confirm termination, the adapter retains an unknown outcome and rejects cancellation acknowledgment. Host-side cancellation during factory setup retires an admitted fresh task without opening a Session; HTTP cancellation requires an already published Task. Closing an HTTP observer does not cancel the task. Cancellation cannot undo external effects that already completed. A settled native completion may win a concurrent cancellation.

## Deferred remote work

`A2AJobProvider` implements the existing `JobProvider` contract. Register it with [`DeferredTools`](EXTERNAL_JOBS.md), a host `JobJournal`, and a current result projection. Set `requireReconciliation: false` only for work whose uncertain outcome the host can handle. Generic A2A cannot prove whether a lost create was accepted.

The provider requires separate callbacks for current authorization, credential resolution, durable mutation reservation, input encoding, and result validation. Authorization checks the current principal, immutable native invocation binding, and claim generation.

After discovery and local validation, the provider resolves credentials, checks authorization again, spends one mutation reservation, and sends once. A timeout or lost create, input-reply, or cancel acknowledgment returns `unknown`. It never resends that mutation.

A known receipt binds the endpoint and original native invocation. A fresh worker observes that same remote task with `getTask`; it does not create another task.

`inputRequired` exposes a remote challenge. `A2AInputReply` supplies its task ID, context ID, challenge, generation, and JSON `result`. The provider reads the current remote task before reserving a reply.

Python and TypeScript use the same message format. The status message contains one data part with `{challenge, generation, tool, arguments}`. A reply contains exactly `{challenge, generation, result}`. Put task and context IDs in the A2A message envelope.

The executor publishes string results as text parts. For structured results, it saves and sends `{result: output}` using the JSON representation that passed the byte limit.

`authRequired` remains a host credential flow and never becomes a generic approval answer. A host must not accept untrusted remote approval text as authority to perform local actions.

## Host storage and recovery

`NativeA2AStore` extends the official `TaskStore`. The same object stores private native records and public A2A Tasks. `own(binding, callback)` grants exclusive host ownership across workers. Its claim checks ownership after asynchronous work and atomically compares and replaces the private record. Hosts implement leases and database transactions; the SDK does not implement a distributed job engine.

### Commit before publishing

`generation` controls private record replacement. `publicationRevision` names a desired public snapshot. They serve different purposes. A commit retains the checkpoint or terminal outcome together with that exact desired snapshot before the executor publishes its full Task event. The official `ResultManager` calculates the snapshot, including history and artifact merging.

The official JS store has no CAS/version argument. The host's `save` must reject stale snapshots against its current private revision. It acknowledges a revision only after the exact desired snapshot is durable. `claim.published(revision)` joins that acknowledgment before execution advances to another revision. A lost save or acknowledgment leaves the desired snapshot available for recovery.

### Handle follow-ups and cancellation

The official request handler also saves an authenticated history append before calling the executor for a follow-up. Permit that history-only save without acknowledging a publication.

When no local event bus exists, official cancellation directly saves a canceled Task. The host must atomically retire a waiting private checkpoint on that save. For active work on another worker, reject the save until the owner has joined cancellation.

Public reads, lists, subscriptions, cancellation, and follow-ups must all enforce the current principal.

### Recover without re-executing

After the prior execution owner and all its official event consumers have stopped, the host calls `executor.recover(binding, currentContext)`. Recovery saves the retained desired snapshot through the same official store. It never invokes the Agent factory or native execution. Crashed `running` and `claimed` records become `unknown` outcomes, represented as failed public Tasks with `agents.a2a.outcome: 'unknown'`. Recovery does not claim to reverse side effects.
