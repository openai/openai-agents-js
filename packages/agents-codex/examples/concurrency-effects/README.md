# Shared quota and application effects

Use these examples to check what happens when tools overlap, repeat a write, or stop while work is in progress. Run commands from the repository root with Node.js 24 and [matching built packages and native runtime](../guides/building.md). The examples use a local scripted Responses peer and real native tools.

## Share one quota between Sessions

```sh
pnpm exec tsx packages/agents-codex/examples/concurrency-effects/concurrent-tools.ts
```

Two callbacks from separate Sessions compete for one unit. The application checks the quota, debits it, and records the winner synchronously on one Node event loop. The command prints the remaining quota, one winner, one denial, and both tool outputs. Either caller can win.

The quota counts consumed units. The example keeps each debit. Applications that share a quota across processes or machines need a store that can reserve a unit atomically.

## Deduplicate writes and handle cancellation

```sh
pnpm exec tsx packages/agents-codex/examples/concurrency-effects/safe-effects.ts
```

The application selects a tenant and logical request ID in trusted context and supplies a fake writer. The model selects the demonstration mode. Repeated writes for the same tenant and request produce one ledger entry. Another tenant has its own ledger. The fake ledger lasts for one process.

Run the focused test to exercise returned tool errors, exceptions after a write, observer cancellation, and exact Turn cancellation.

```sh
pnpm test:native packages/agents-codex/test/native/concurrency-effects-example.test.ts
```

Stopping an observer leaves the tool running. `Turn.cancel()` joins callback cleanup before the Session admits another Turn. The test releases its cleanup gate in `finally`. Sessions close before the scripted provider leaves scope, and cleanup failures propagate to the owner.

A committed effect survives a later error or cancellation. A production writer owns authorization, durable deduplication, and transactions. If a remote write fails with an unknown outcome, reconcile the result before retrying.

## Recall and delete one tenant fact

```sh
pnpm exec tsx packages/agents-codex/examples/concurrency-effects/memory-lifecycle.ts
```

The application supplies an asynchronous store that holds one fact per tenant. A fact must contain nonblank text and fit within 240 JavaScript string code units. A fresh Session can recall, replace, or delete the fact while the application keeps the store.

This in-memory adapter lasts for the process. Your application owns tenant admission, retention, expiry, and persistence across restarts. Deleting the stored fact leaves earlier model context, history, checkpoints, and traces under their own retention rules.

## Recover one synthetic external order

The [external order example](../external-order-recovery.ts) carries an application journal across process restarts. Use Node.js 24, the built native runtime, and a private directory outside model-visible workspaces. The command uses a scripted model and a synthetic provider.

```sh
ORDER_DIRECTORY=$(mktemp -d)
pnpm exec tsx packages/agents-codex/examples/external-order-recovery.ts "$ORDER_DIRECTORY"
pnpm exec tsx packages/agents-codex/examples/external-order-recovery.ts "$ORDER_DIRECTORY"
```

The first invocation creates one synthetic order. The next reads its terminal receipt or recovers the pending work. The application selects the directory and authorizes the order. The model cannot choose another tenant, endpoint, path, or order.

1. The journal saves the pending manual checkpoint, business identity, and payload digest. It records `creating` before dispatch.
2. The provider records the effect, a private receipt, and a small public result. Recovery uses an authoritative lookup or create-or-find operation with the same business key. An inconclusive lookup records `unknown` and stops automatic dispatch.
3. Once the result is durable, `answerJob` restores current declarations and answers the newly issued live request. Only the public result reaches the model. `settleJob` records completion after the answer settles.

A crash between the answer and terminal record can repeat model continuation. The stored business result prevents a second effect in this example. Real providers need their own idempotency and authoritative lookup. The example uses one sequential owner, a synced temporary file, and atomic rename to preserve the previous record during a process crash. Distributed locking, power-loss durability, and network-filesystem guarantees require a different store. Remove the temporary directory after inspecting the receipt.
