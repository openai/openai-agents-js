# Shared quota and application effects

These examples use Node.js 24 and the public native SDK testing API. They run a local scripted Responses peer and real native tools without a model API key. Use the matching built workspace packages and native products.

```sh
pnpm exec tsx packages/agents/examples/concurrency-effects/concurrent-tools.ts --mode scripted
pnpm exec tsx packages/agents/examples/concurrency-effects/safe-effects.ts --mode scripted
OPENAI_AGENTS_NATIVE_TESTS=1 pnpm exec vitest run --project @openai/agents packages/agents/test/native/concurrency-effects-example.test.ts
```

`concurrent-tools.ts` forces two callbacks from separate Sessions to overlap. Both share one application quota. The check, debit and ledger write run synchronously on one Node event loop. One callback reserves the unit and the other reports full. The quota counts consumed units; it does not refund them. This is not synchronization across threads, processes or machines.

The concurrent command prints the remaining quota, one winning caller, one denial, and both tool outputs. Either caller can win.

`safe-effects.ts` injects a fake writer before running tools. The application chooses the tenant and logical request ID in trusted context. The model selects only a demonstration mode. Repeated writes for the same tenant and request leave one ledger entry. Another tenant has a separate ledger. Importing either module starts no work.

The tests also exercise returned tool errors, exceptions after a write, observer cancellation and exact Turn cancellation. Stopping an observer leaves the tool running. `Turn.cancel()` joins the callback's cleanup before a new Turn uses that Session. The test releases its cleanup gate in `finally`. Sessions close before their scripted provider leaves scope.

A committed effect survives later tool failure or cancellation. The fake ledger lives only in this process. It provides no crash recovery or durable exactly-once guarantee. A production writer must own authorization, durable deduplication and transactions. A remote write failure can leave an unknown outcome; reconcile that outcome before retrying. Cancellation cannot undo an accepted write. Cleanup failures propagate through the owned Session and provider scopes.

`memory-lifecycle.ts` adds one explicit fact per tenant through an injected asynchronous store. It accepts 1 to 240 JavaScript string code units and rejects blank facts before storage. Fresh Sessions can recall, replace and delete the fact because the application retains the store. The fake adapter has process lifetime and no expiry or restart durability. Total tenant count is not bounded. A real application supplies its own retention and admission policy. Deleting a stored fact does not erase earlier model context, history, checkpoints or traces.

```sh
pnpm exec tsx packages/agents/examples/concurrency-effects/memory-lifecycle.ts --mode scripted
```
