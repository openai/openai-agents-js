# Choose workspace write grants

With the current [source build](building.md), new local and remote Environments default to `writePolicy: 'strict'`. Command tools can write in `Environment.cwd`; set `Environment.writableRoots` to opt into additional directories. Omitting roots or passing `[]` keeps the workspace writable. Neither value creates a read-only workspace. These roots select directories, while `Environment.tools` selects operations and `capabilityDirectories` selects [skill discovery](project-guidance.md#prepare-a-skill-catalog).

## Replace the extra roots for a new Turn

Choose existing absolute directories in application code. Set the Environment's `writableRoots` to the first list before opening the Session. After the first Turn and its executor work finish, pass the replacement list in the next `session.submit` call's options. The same grant options work with a provisioned remote executor and [Environment.local](local-execution.md).

The second list replaces the extra roots; it does not add to them. After acceptance, later submissions that omit `writableRoots` retain the current list. Pass `[]` to remove extra roots while keeping the workspace writable. `enqueue` accepts the same operation option. A failed validation does not authorize the proposed roots.

Use the runnable [local example](../local-execution.ts) to check the replacement against actual writes and `RecordedTurn.receipt.executors[].writableRoots`.

## Meet the grant constraints

The strict write profile requires a supported Linux or macOS executor and existing directories below the filesystem root. An unsupported executor fails admission rather than falling back to broader write access. New grants must name canonical directories; use their resolved paths rather than introducing a symlink alias. The SDK pins the workspace identity and refuses a changed target.

Replace roots after earlier executor work and native descendants finish. A returned process handle can remain live after the root answer, so awaiting the root alone may leave the change blocked with `Cannot change writable roots while earlier executor work or descendants are retained`. Finish the retained work or close its Session before choosing new grants.

A WSS executor that reports macOS retains its opening write profile. A changed list rejects with `Cannot change writable roots on a macOS executor after opening the Session`; open a new Session with the required roots. An equivalent list with different ordering does not change the profile. This restriction is specific to WSS macOS, rather than the local macOS route.

The SDK refuses grants that overlap its installed local helpers, private native runtime state, or local conversation storage. Keep those resources outside the workspace and output roots. These checks govern command tools; they do not change the permissions of a separately trusted stdio MCP process.

### Retain the legacy remote policy

Set `writePolicy: 'legacy'` explicitly on a remote Environment only when you need the previous implicit WSS policy. This mode cannot be combined with `writableRoots`, including `[]`, and is unavailable for local execution. Use strict mode with explicit roots for additional workspace grants.

## Save and restore the current grant

After a successful replacement, restore with a fresh Environment that declares the current roots and network policy. The checkpoint checks a digest of the applied executor policy; it does not restore resources or grant directories by itself. The original opening roots may no longer match. New defaults do not upgrade a saved legacy policy: declare `writePolicy: 'legacy'` when restoring that policy. The SDK rejects detectable declaration or mode mismatches before acquiring an executor. Comparing the complete applied policy can require executor inspection, but must succeed before resumed execution. See [executor policy on restore](state.md#restore-instructions-and-tools) for checkpoint compatibility.
