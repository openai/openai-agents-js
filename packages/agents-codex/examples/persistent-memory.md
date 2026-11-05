# Keep an application fact across sessions

Use an application-owned SQLite store when an Agent should recall a fact after its native Session closes. The application authenticates the user and supplies the user ID through context. The model supplies the fact.

## Run the example

Use Node.js 24 and [build the SDK and native runtime](guides/building.md). The [scripted example](persistent-memory.ts) uses the built-in SQLite module and needs no model API key.

```sh
pnpm exec tsx packages/agents-codex/examples/persistent-memory.ts
```

The demo saves one fact, closes and reopens the store, recalls the fact in a fresh Session, and deletes the row. It removes the temporary database after cleanup. Supply your own private database path to retain facts in an application.

## Scope facts to the authenticated user

Prepared SQL parameters scope each operation to the authenticated user ID. The caller owns the store and the borrowed provider. Keep the store open until tool callbacks and Session cleanup finish.

A database error rejects the run. A save or delete can commit before a later failure or cancellation. Check the stored state before deciding whether to repeat an operation.

## Persistence and deletion limits

The row holds application data independently of conversation history, checkpoints, and native local storage. Deleting it removes the stored fact. Earlier model context, saved histories, files, and telemetry can still contain it. Your application owns authentication, access, encryption, retention, expiry, and backups.

For a read-only service, the [application memory example](application-memory.ts) injects an asynchronous lookup through context.
