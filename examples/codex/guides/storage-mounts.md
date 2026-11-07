# Storage mounts for native commands

Native commands can use provider storage through `sandboxEnvironment` or read-only local Linux mounts through `Environment.local`. Provider storage uses an authenticated executor in the prepared sandbox. Local mounts require the matching native addon and Linux sandbox helper from this checkout.

## Provider-backed storage

Import `sandboxEnvironment` and `renderStorageLayout` from `@openai/agents/sandbox`. The existing typed `Manifest` declares storage, and a `SandboxClient` creates and prepares the provider session. Native execution uses your application's authenticated gateway connector to that exact session. No Classic runner or second model loop is involved. See the [runnable provider example](../provider-storage-mount.ts).

```ts
import {
  Manifest,
  s3Mount,
  sandboxEnvironment,
  renderStorageLayout,
} from '@openai/agents/sandbox';
import {
  ModalSandboxClient,
  ModalCloudBucketMountStrategy,
} from '@openai/agents-extensions/sandbox/modal';

const manifest = new Manifest({
  entries: {
    data: s3Mount({
      bucket: 'reference-data',
      mountStrategy: new ModalCloudBucketMountStrategy(),
      description: 'Reference documents for this task.',
    }),
  },
});
const environment = sandboxEnvironment({
  client: new ModalSandboxClient({ appName: 'my-existing-app' }),
  manifest,
  // Application-supplied: launch or find a matching native executor INSIDE
  // sandbox, authenticate its gateway, and return Environment.lease(...).
  connect,
});
const instructions = `Use these files:\n${renderStorageLayout(manifest)}`;
```

Pass the source to `agent.session({ environment })` or `agent.run(input, { environment })`. `connect(sandbox, { signal })` must return an `EnvironmentLease` whose Environment targets the supplied sandbox and whose disposer joins the gateway. Returning a host executor for a cloud sandbox does not connect its filesystem. The SDK does not deploy a gateway, provision cloud accounts, install Docker volume plugins, or make an arbitrary container suitable for native execution. The executor must support the native runtime's normal sandbox, including its namespaces and mount requirements; do not disable those controls to make a container work.

The source captures the Manifest and plain provider `options` before asynchronous work. It preserves opaque SDK objects and functions by reference; the application owns their lifetime and mutations. Each opening calls the provider's normal `create()` pipeline. The provider owns validation of storage, strategy, credentials, selected resources and creation options. Strategies must be explicit. Mounts default to `readOnly: true`; writable requests work only where the provider supports them.

| Resource provider | Existing storage implementation | Limits |
| --- | --- | --- |
| Docker | `local_bind`; `docker_volume` with configured Rclone/Mountpoint drivers; `in_container` helpers | Driver/pattern matrix varies. S3/GCS/R2/Azure/Box use supported drivers or helpers; S3 Files requires the `s3files` pattern. Read-only host binds cannot be combined with helpers requiring mount privileges. |
| Modal | `modal_cloud_bucket`: S3/GCS/R2 | Native provider bucket API; GCS needs compatible HMAC credentials or provider secrets. |
| Cloudflare | `cloudflare_bucket_mount`: S3/GCS/R2 | Native bucket API; credential/endpoint variants are provider-specific. |
| E2B / Daytona | `e2b_cloud_bucket` / `daytona_cloud_bucket`: S3/GCS/R2/Azure/Box | Rclone FUSE/NFS; requires the corresponding runtime privileges and helper support. |
| Blaxel | `blaxel_cloud_bucket`: S3/GCS/R2; separate drive strategy | Uses provider helpers; other typed storage types are unsupported. |
| Vercel | `vercel_cloud_bucket`: S3 | Mountpoint, configured at creation; no dynamic mount or credential refresh contract. |

These are existing implementation paths, not a claim of live cloud qualification. Credentials, prefixes, endpoints and writable modes have narrower provider-specific support. Invalid combinations fail in the owning provider before creation/helper effects. S3 Files requires an existing filesystem and suitable networking/identity; this integration does not provision or qualify that infrastructure.

Mount credentials stay in trusted provider configuration. In-container helpers may expose credentials to the same sandbox principal: the existing policy denies that by default and requires an explicit acknowledgement for the exact mount path. The adapter never grants that acknowledgement. Prefer provider-native mounts or external drivers when suitable. `renderStorageLayout` returns only `{workspace, storage:[{path, access, description?}]}` with `read_only`/`read_write` access. It never renders provider configuration, environment values, source credentials or file contents, and does not resolve credentials. Paths and descriptions are intentional model-facing text; callers must keep those strings safe. If a provider rebases the workspace root, render its prepared `sandbox.state.manifest` or configure an explicit root supported by that provider.

Native retirement finishes before the source releases the gateway and provider session. Cleanup uses the provider lifecycle with preservation disabled and attempts later owners even if an earlier cleanup fails. Selected resources follow that provider's actual ownership policy: selection does not universally mean preservation, so supply only resources you authorize that provider to dispose of. The source requires a cleanup route and reports failures the provider exposes; it cannot recover errors a provider suppresses internally.

Native checkpoints do not serialize provider handles, credentials or a sandbox snapshot. Reopening uses current trusted Manifest/options and `connect`; it does not resume provider state from a checkpoint. Native permission checks still apply, but their receipt does not fingerprint provider mount configuration or prove identical backing data. Applications must establish that the new resource and data are appropriate for restored conversations.

## Direct local Linux mounts

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

Pass this environment to `agent.session({ environment })`. See [the complete example](../local-storage-mount.ts). Both directories must already exist. Source and destination must be identical canonical absolute paths without symlinks. The workspace remains writable; place mounted storage outside it and outside all writable roots. Mounts cannot overlap each other or expose private SDK runtime or session storage. Native validation also checks filesystem identities and mount aliases. It rejects existing hard links that share a regular file between mounted storage and `cwd` or an additional writable root. Hard links wholly within read-only storage or outside the writable grants are allowed.

## Direct local mount configurations

| Environment | Storage and strategy | Access |
| --- | --- | --- |
| Local Linux | Local directory, same-path `local_bind` | Read-only; omitted `readOnly` means `true` |
| Local Linux | `readOnly: false` | Unsupported; use `writableRoots` for explicit write grants |
| Local Linux | Relocated destination, overlapping roots, or symlink source | Unsupported |
| macOS, Windows, or remote executor | Mount declarations | Unsupported |
| Any environment | Cloud providers, other strategies, credentials, or unknown mount fields | Unsupported |

The SDK validates the complete list before launching execution helpers or making model requests. It rejects unsupported fields without including their values in the error. You cannot replace `writableRoots` for a Session with active mounts, including through queued turns. Open a new Session to change its filesystem grants.

The SDK must be able to list every source directory and inspect its entries. During preflight, the SDK traverses each source without following symlinks and collects files with multiple hard links. If it finds any, it scans the writable grants once for hard links to the same files, stopping at the first conflict. This costs a source-tree traversal and, when needed, a writable-tree traversal on each validation. The SDK rejects configurations when required inspection fails. Mounted sources may contain only regular files, directories, and symlink entries. Preflight rejects sockets, FIFOs, devices, and other special entries without opening them or following symlinks. A read-only bind alone does not prevent special-file IPC.

## Ownership and cancellation

Your application owns the source directories. The SDK never deletes or changes ownership or permissions of mounted storage. Existing native process cleanup releases each command's mount namespace. Await Session close before releasing application resources; cancellation does not undo completed effects in writable directories.

The application host and source ancestors must remain trusted. Keep sources and filesystem topology stable while a Session uses them. The source checks run at preflight; a trusted host must not introduce special entries or new writable hard-link aliases afterward. Read-only access restricts native commands, including children and continued processes. It does not restrict application function callbacks, which run with the Node process's permissions. It also does not prevent another host process from changing the data. A mount is not a snapshot or a backup.

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
