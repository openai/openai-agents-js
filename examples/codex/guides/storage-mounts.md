# Mount local storage for native commands

The current source build supports read-only local storage mounts on Linux. Pass `mounts` to `Environment.local`. Native commands receive a real read-only bind mount inside their process sandbox. The SDK does not copy files or create a host-wide mount. This feature requires the matching native addon and Linux sandbox helper from this checkout.

```ts
import { Environment, type LocalStorageMount } from '@openai/agents';

const mount: LocalStorageMount = {
  source: '/srv/customer-data',
  destination: '/srv/customer-data',
  strategy: 'local_bind',
  readOnly: true,
};
const environment = Environment.local({
  cwd: '/srv/agent-work',
  mounts: [mount],
  tools: ['exec_command', 'write_stdin', 'apply_patch'],
});
```

Pass this environment to `agent.session({ environment })`. See [the complete example](../local-storage-mount.ts). Both directories must already exist. Source and destination must be identical canonical absolute paths without symlinks. The workspace remains writable; place mounted storage outside it and outside all writable roots. Mounts cannot overlap each other or expose private SDK runtime or session storage. Native validation also checks filesystem identities and mount aliases.

## Supported configurations

| Environment | Storage and strategy | Access |
| --- | --- | --- |
| Local Linux | Local directory, same-path `local_bind` | Read-only; omitted `readOnly` means `true` |
| Local Linux | `readOnly: false` | Unsupported; use `writableRoots` for explicit write grants |
| Local Linux | Relocated destination, overlapping roots, or symlink source | Unsupported |
| macOS, Windows, or remote executor | Mount declarations | Unsupported |
| Any environment | Cloud providers, other strategies, credentials, or unknown mount fields | Unsupported |

The SDK validates the complete list before launching execution helpers or making model requests. It rejects unsupported fields without including their values in the error. You cannot replace `writableRoots` for a Session with active mounts, including through queued turns. Open a new Session to change its filesystem grants.

## Ownership and cancellation

Your application owns the source directories. The SDK never deletes or changes ownership or permissions of mounted storage. Existing native process cleanup releases each command's mount namespace. Await Session close before releasing application resources; cancellation does not undo completed effects in writable directories.

The application host and source ancestors must remain trusted. Keep sources stable while a Session uses them. Read-only access restricts native commands, including children and continued processes. It does not restrict application function callbacks, which run with the Node process's permissions. It also does not prevent another host process from changing the data. A mount is not a snapshot or a backup.

## Save, restore, and reconnect

Checkpoints contain conversation state and the effective executor-policy digest. They do not contain storage contents, credentials, a mount manager, or a live namespace. Restore with a current trusted Environment that declares the matching mounts and grants. The existing full-profile receipt includes read grants. Restore rejects mount changes that change the recorded effective policy.

A new Session recreates command-private mounts from current application configuration. Local execution has no remote connection to reconnect. Matching paths and policy do not prove unchanged data or backing storage across restarts. Your application must ensure that the current directories contain the intended data. Existing checkpoint revision and capability restrictions still apply.

## Verify enforcement

After preparing and building the native runtime as described in [building from source](building.md), run the focused tests with `OPENAI_API_KEY` unset:

```sh
env -u OPENAI_API_KEY OPENAI_AGENTS_NATIVE_TESTS=1 pnpm exec vitest run \
  packages/agents-codex/test/native/storage-mounts.test.ts \
  packages/agents-codex/test/native/storage-mounts-native.test.ts
```

Use Node.js 24 and a Linux host that permits the sandbox's required namespaces. On supported Linux CI, sandbox startup failure fails the enforcement tests. Outside CI, only the explicitly marked Codex outer sandbox (`OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX=1`) may skip an unavailable nested sandbox. Set `OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX=1` to require enforcement even there. A local isolation-test skip does not qualify mounting behavior.
