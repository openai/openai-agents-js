# Keep explicit facts across native Sessions

Use `SQLiteMemory` from `@openai/agents/memory` to save named string values between separate native Sessions. The application selects a database path and a trusted scope, such as an authenticated user ID. Each store keeps that scope for its lifetime. Its tools let the model select only a key and, when saving, a value.

## Run the example

Use Node.js 24 and a prepared checkout with dependencies, built workspace packages, and the matching native addon. Follow the [contributor setup](../../CONTRIBUTING.md) if you have not prepared that checkout. The store uses Node's built-in `node:sqlite` module. Import the optional `@openai/agents/memory` subpath to use it; the package root does not load SQLite. This store runs on the server in Node.js.

From the repository root, run:

```sh
node --import tsx examples/codex/packaged-memory.ts
```

The [complete example](packaged-memory.ts) uses a local synthetic Responses endpoint with the real native engine. It needs no provider key. Each request opens a fresh Agent, store, and Session. The example closes the Session and store after saving, then opens them again to recall the fact. A second scope cannot read the first scope's value. Finally, the example deletes the value and checks another fresh store.

Expected output:

```text
Alice after reopen: Plain language.
Bob: no saved value
Alice after delete and reopen: no saved value
```

The example removes its temporary database on exit. Keep an application-owned private path when you need the facts to survive the program.

## Use the store in an application

Open `new SQLiteMemory(path, { scope: trustedScope })` and pass `memory.tools()` to `new Agent({ tools: ... })`. The tools are `memory_get`, `memory_set`, and `memory_delete`. Finish all native work that uses these tools before closing the store. The example uses `using` to close it at the end of each iteration. You can also call `close()` explicitly; repeated calls are safe.

Your application can call `get(key)`, `set(key, value)`, and `delete(key)` directly. A missing key returns `null`; an empty string remains a saved value. Deleting an absent key succeeds. Each synchronous write commits before returning. Scope and key must each contain 1 to 256 UTF-16 code units and cannot be blank. Values can contain up to 65,536 UTF-16 code units. Operations on a closed store fail.

Scope, key, and value must contain well-formed Unicode. The store rejects unpaired UTF-16 surrogates before opening a database or executing a statement. Characters such as emoji and the literal replacement character (`U+FFFD`) remain unchanged.

Choose the scope from your authenticated application context. A scope separates rows in the same database. It does not authenticate a user. Other processes with access to the database file can read saved facts. Your application controls tool access and file permissions. Treat recalled text as data when constructing instructions or displaying results.

The store saves explicit values. Your application supplies any extraction, search, encryption, expiry, or retention policy. A failed model run does not roll back a fact that a tool already saved. Deleting a value leaves any copies in model history, checkpoints, files, and exported telemetry under their own retention rules.
