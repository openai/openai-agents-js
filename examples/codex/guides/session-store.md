# Store canonical conversation state in application-owned files

[`fileSessionStore(directory)`](../custom-storage.ts) saves the native runtime's full canonical snapshot, including conversation history and native state, through the public `storage` option. The custom-store API is a preview. For native checklist, goal, or child-agent support, use [native local profiles](local-state.md#supported-capabilities). For portable checkpoints, use [Session state](state.md#save-or-suspend-a-session).

## Build and run the example

The [custom-storage example](../custom-storage.ts) requires a current source checkout and its matching SDK/native build. Follow [Build the native SDK from source](building.md#build-from-source). Applications can also use custom storage with the [alpha.2 prebuilt packages](installation.md).

Run these commands from the repository root with model credentials. Retain both the directory and the returned conversation ID. The CLI accepts an optional `OPENAI_BASE_URL` for a Responses endpoint:

```sh
pnpm exec tsx examples/codex/custom-storage.ts /absolute/private/conversations
pnpm exec tsx examples/codex/custom-storage.ts /absolute/private/conversations SESSION_ID
```

Each process closes its Session before the next process resumes it.

## Check supported tools and snapshots

Custom storage supports root conversations with application-managed function tools. It rejects environments, native search, checklists, goals, child agents, manual tools, MCP, Code Mode, forks, and portable SessionState before effects. Supply current application tool bindings when reopening; saved data never supplies credentials or callback implementations.

Snapshots contain canonical native creation metadata, ordered rollout changes, tool calls, and recorded tool results. Native memory holds only a disposable projection of these records. Indexes and telemetry do not establish tool completion.

## Own one writer

The file adapter supports one writer per conversation. A separate directory lock holds a random ownership token. If your application calls the adapter directly, serialize operations within each acquired lease. The SDK serializes its own operations.

Provision a private directory: snapshots can contain prompts and tool results. The adapter rejects IDs with path separators and leaves corrupt records in place with an error. It does not make external tool effects atomic or deduplicate those effects.

## Commit durable snapshots

This is a Node reference adapter for trusted local filesystems with atomic rename and file and directory `fsync`. It targets process crashes after a completed commit. It does not support network filesystems or promise recovery from disk failure.

For each commit, the adapter compares the expected revision, syncs a temporary file, renames it over the prior record, and syncs the directory before returning. Retrying the latest logical write with the same write ID, expected revision, and exact snapshot succeeds without adding a revision.

A tool call must reach canonical storage before dispatch. Its real result must reach canonical storage before the SDK releases the response to native execution. An append, commit, or flush failure blocks further work and remains visible through completion and close. Closing still attempts to release the writer. The SDK never switches a failed custom store to memory or local storage.

If a commit loses its acknowledgment, the SDK:

1. Reads under the same token and checks that the saved snapshot exactly matches the submitted write.
2. Confirms that same write through an idempotent commit retry.

Both checks must succeed before execution continues. Otherwise, close the Session and inspect the backend before continuing. Started sibling effects remain external facts; the SDK cannot roll them back.

## Recover a stale lock

A crashed process leaves its `<sessionId>.lock` directory. The adapter never removes stale locks automatically. Before explicit recovery:

1. Stop and confirm that the former writer process is dead.
2. Remove only that conversation's lock directory. Preserve its `.json` record and any evidence needed to diagnose the crash.
3. Resume with a fresh adapter.

Never remove a live writer's lock: doing so breaks the single-writer guarantee. An interrupted commit may leave a `.tmp` file; readers ignore these files.

## Finish writer cleanup

The same adapter instance accepts an exact release retry after removing the lock, including a lost acknowledgment or a failed final directory sync. The retry syncs the directory without touching a successor writer's lock.

If release removes the owner file but cannot remove its lock directory, it retains ownership of that exact directory so a retry can finish cleanup. It rejects a replacement directory and preserves unexpected files.

A process crash during partial cleanup requires the operator recovery above. Do not remove an empty lock directory merely because its owner file is missing; another process may still be acquiring it.

## Implement a SessionStore

Supply an object that implements `SessionStore` directly as `Agent.session({ storage })`:

| Method | Required behavior |
| --- | --- |
| `acquire(sessionId)` | Return an exclusive writer token. |
| `read(sessionId, token)` | The SDK calls this only after acquisition, including during resume. Return `null` for a missing conversation or the opaque snapshot string last accepted by the backend. |
| `commit(sessionId, token, writeId, expectedRevision, snapshot)` | Atomically check ownership and the expected revision, then make the complete snapshot durable before resolving. |
| `flush(sessionId, token)` (optional) | Supply a further durability barrier. Omitting it asserts that every completed commit already meets the backend's durability promise. |
| `release(sessionId, token)` | Release only that owner and preserve its saved data. |

The initial revision is zero; each successful write advances it by one. The backend must accept an exact retry of its latest write identity without advancing the revision again.

The SDK serializes operations within an acquired lease. Adapter methods must not reenter the Session they serve.

## Record recovery identities before dispatch

Before a managed callback dispatches an external operation, durably save its native identities beside the application's business key. The callback context supplies `threadId`, `turnId`, and `callId`; reconciliation names that same `threadId` value `sessionId`. If reopening finds unresolved root calls, it raises `LocalRecoveryRequired` with `calls`, `turns`, and `items` captured while the writer lease is held. Each call includes its original native IDs, name, namespace, and recorded arguments. The native snapshot remains opaque SDK data; applications do not need to parse it to recover those IDs.

The [recovery-intent helper](../custom-storage-recovery.ts) creates one private file, syncs it, and syncs its parent directory before returning. In the managed tool's callback, build an intent record with the callback's `threadId` as `sessionId`, its unchanged `turnId` and `callId`, and the application's authenticated operation key as `businessKey`. Await `recordRecoveryIntent(intentPath, intent)` before dispatching the external operation. The [crash worker](../../../packages/agents-codex/test/native/fixtures/custom-storage-worker.ts) follows this sequence before recording its synthetic effect.

Choose a new intent path for each operation and keep operations sequential under one application owner. A journal failure prevents this callback from dispatching the effect. The external service must enforce the business key's idempotency contract; the file does not deduplicate effects by itself. For argument-bearing tools, also retain the immutable payload or its digest so an operator can verify which operation the call requested.

This helper targets trusted local POSIX filesystems with file and directory `fsync`. It does not provide distributed ownership, network-filesystem support, or a power-loss guarantee for the external service. A partially written intent file is an error, not permission to repeat an operation.

The process can stop after native intent becomes durable but before the callback writes its application intent. Reopening still refuses that call and reports its identity through `LocalRecoveryRequired.calls`. Check your application records for the actual effect before supplying a result. A missing application journal alone does not establish an outcome. If failed-opening cleanup also fails, the `AggregateError.cause` retains the original recovery error and its records. Close other active Sessions, then retry cleanup through the captured `agent.provider.close()` before reconciling. A cleanup retry can still report the retained storage diagnostic after physically releasing the writer.

## Reconcile an unresolved tool intent

An unresolved tool intent blocks automatic resume, including repeated resume attempts. First reconcile the original action against authoritative external records. Then:

1. Close the Session and confirm that the former process is dead. Inspect `LocalRecoveryRequired.calls` from a refused reopen, or use the original identities retained in your application journal.
2. Call `reconcileSessionStore(store, { sessionId, turnId, callId, result })` with the original native identities and the verified result.
3. Reopen that same conversation with the current application's tools and credentials.

In the replacement process, await `readRecoveryIntent(intentPath)` to read the saved application identities and `businessKey`. Ask the authoritative external service about that same business key. Only after verifying the outcome, pass the original `sessionId`, `turnId`, and `callId` with the confirmed model-safe `result` to `reconcileSessionStore()`. Then reopen the conversation with current application bindings.

Leave unknown outcomes unresolved. This procedure never calls the tool again. The SDK supplies unresolved-call identities without exposing the snapshot format. The [native crash test](../../../packages/agents-codex/test/native/custom-storage-durability-native.test.ts) kills a worker after a synthetic effect, then reads the documented intent file to recover and checks that the effect ran once.

`result` accepts a string or `ToolOutput`, including failed or structured results, and uses the same validation and conversion as ordinary tool callbacks. As with ordinary receipts, canonical history preserves the output content; Core omits runtime-only success metadata when serializing either path.

Reconciliation acquires the writer, verifies that the original call remains unresolved, and records its result without executing the tool. It rejects a second result for the same call. Do not invent a result or remove the pending intent to bypass this check.

If reconciliation throws a `NativeError`, retain its optional `cleanup` owner. After the backend recovers, `await error.cleanup.close()` retries release of that exact writer. Concurrent calls join the same release attempt; call it again after a transient failure. Successful cleanup never repeats reconciliation or confirms that its receipt was committed. Preserve the original error and inspect the backend before deciding whether another reconciliation is needed.

```ts
try {
  await reconcileSessionStore(store, confirmedResult);
} catch (error) {
  if (error instanceof NativeError && error.cleanup) {
    // Restore backend access before retrying cleanup.
    try {
      await error.cleanup.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Reconciliation and writer cleanup failed.',
        { cause: error },
      );
    }
  }
  throw error;
}
```

If cleanup fails again, `AggregateError.errors` preserves both failures. Its `cause` retains the original `NativeError` and its `cleanup` owner for a later retry.

Import `NativeError` from `@openai/agents` with the storage helpers. Cleanup requires no Session or provider and never acquires a replacement writer.

## Qualify versions and production storage

Snapshot format version 1 is native SDK data, not a cross-language checkpoint. Keep backups and qualify a new SDK/runtime revision before upgrading stored conversations. The SDK rejects unknown format versions.

This reference adapter rewrites the full accumulated snapshot at each commit; it suits a bounded example, not an unmeasured production workload. Qualify your production backend's atomic writes, fencing, acknowledgment loss, crash recovery, and storage capacity separately.
