# Choose workspace write grants

With the current [source build](building.md), set `Environment.writableRoots` to allow command tools to write outside `Environment.cwd`. The workspace itself is always writable. These roots select directories, while `Environment.tools` selects operations and `capabilityDirectories` selects [skill discovery](project-guidance.md#prepare-a-skill-catalog).

## Replace the extra roots for a new Turn

Choose existing absolute directories in application code. This excerpt assumes a provisioned remote executor; the same grant options work with [Environment.local](local-execution.md).

```ts
const environment = new Environment({
  url: executorUrl,
  cwd: workspace,
  headers: executorHeaders,
  tools: ['exec_command'],
  writableRoots: [firstOutput],
});
await using session = await agent.session({ environment });
await (await session.submit('Write the first output.')).wait();
await (
  await session.submit('Write the next output.', {
    writableRoots: [secondOutput],
  })
).wait();
```

The second list replaces the extra roots; it does not add to them. After acceptance, later submissions that omit `writableRoots` retain the current list. Pass `[]` to remove extra roots while keeping the workspace writable. `enqueue` and `submitWithOutput` accept the same operation option. A failed validation does not authorize the proposed roots.

Use the runnable [local example](../local-execution.ts) to check the replacement against actual writes and `RecordedTurn.receipt.executors[].writableRoots`.

## Meet the grant constraints

The local executor always validates a strict write profile. An explicit `writableRoots` list, including `[]`, also selects strict validation on a WSS Environment. That profile requires a supported Linux or macOS executor and existing directories below the filesystem root. New grants must name canonical directories; use their resolved paths rather than introducing a symlink alias. The SDK pins the workspace identity and refuses a changed target.

Replace roots after earlier executor work and native descendants finish. A returned process handle can remain live after the root answer, so awaiting the root alone may leave the change blocked with `Cannot change writable roots while earlier executor work or descendants are retained`. Finish the retained work or close its Session before choosing new grants.

A WSS executor that reports macOS retains its opening write profile. A changed list rejects with `Cannot change writable roots on a macOS executor after opening the Session`; open a new Session with the required roots. An equivalent list with different ordering does not change the profile. This restriction is specific to WSS macOS, rather than the local macOS route.

The SDK refuses grants that overlap its installed local helpers, private native runtime state, or local conversation storage. Keep those resources outside the workspace and output roots. These checks govern command tools; they do not change the permissions of a separately trusted stdio MCP process.

## Save and restore the current grant

After a successful replacement, restore with a fresh Environment that declares the current roots and network policy. The checkpoint checks a digest of the applied executor policy; it does not restore resources or grant directories by itself. The original opening roots may no longer match. See [executor policy on restore](state.md#restore-instructions-and-tools) for checkpoint compatibility.
