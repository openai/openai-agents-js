# Sandbox Runtime and Provider Boundaries

Use this reference for sandbox preparation, sessions, capabilities, manifests, mounts, path grants, snapshots, credentials, timeout, resume, process execution, or cleanup.

## Trusted Configuration and Persisted State

- Treat serialized sandbox session state, manifests, mount metadata, and provider values as untrusted. Recreate clients, credentials, policy, and executable tools from current trusted configuration.
- Persist only the state needed to find or recreate a session. Never serialize live provider clients, resolved secrets, API keys, or host capabilities into RunState.
- A prepared internal sandbox agent can add tools and prompts, but filters, hooks, handoffs, and results should keep the public source agent identity.
- Merge provided and restored manifests by owned field. Preserve current environment resolvers and trusted configuration instead of allowing stale persisted fields to override them.

## Paths, Mounts, and Materialization

- Validate real host paths, normalized sandbox paths, traversal, symlinks, Git subpaths, archive entries, and extraction limits before materialization. A lexical prefix check is not a filesystem trust boundary.
- Path grants must be enforced by every materialization route they claim to cover. Do not document a grant for local files, directories, archives, or Git sources unless that path actually consults it.
- Keep remote mount commands allowlisted and separate command arguments from shell text. Validate privileged command environment and user selection.
- Pin binaries downloaded by privileged sandbox setup to immutable release artifacts, verify embedded checksums before execution or installation, and replace final executables atomically. Pin updaters must enforce any observation cooldown against the release and every required asset's creation time, then cross-check checksum manifests against server-computed asset digests.
- Mount secrets and temporary archives must be cleaned on every failure path, including provider create, upload, extract, and late timeout completion.

## Session and Process Lifecycle

- Distinguish preserve from cleanup. A resumable session may survive a run, while disposable sessions must be destroyed; provider close and remote destroy are not interchangeable.
- Remote timeout does not guarantee the remote operation stopped. Track late create/exec/cleanup completion and clean resources that appear after the local timeout.
- Refresh provider credentials before expiry and on resume according to provider behavior. Prefer provider SDK state over assumptions from docs alone when units, lifecycle defaults, or generated types differ.
- PTY and non-PTY process execution have different signal, buffering, exit, resize, and terminal-default behavior. Preserve output/status metadata and observe child failures during cleanup.

## Provider Adapters

- Keep shared archive, path, mount, process, session, and snapshot semantics in `sandbox/shared/`. Provider adapters should translate those contracts rather than fork validation rules.
- Preserve structured provider error details and retryability without exposing credentials. Cleanup failure can be significant even when execution already failed; retain both causes.

### Remote mount simplicity boundary

Remote mounts should default to one narrow lifecycle: declare them during sandbox creation, keep their contents outside workspace persistence, and unmount them during close. When persistence or hydration requires detaching a mount, restore it immediately afterward. Mount credentials must remain trusted current configuration and must not be reconstructed from serialized session state.

Treat dynamic mount mutation, snapshot-backed mounts, and resumable mounts as opt-in provider capabilities rather than default requirements. If a privileged mount transition becomes ambiguous, stop the sandbox instead of adding reconciliation or recovery state. Do not add credential resolvers, refresh loops, persisted mount registries, or dynamic mount APIs unless the provider exposes a trusted primitive that makes the lifecycle transition unambiguous and the change is supported by focused provider evidence.

Provider adapters may deliberately support a narrower lifecycle. Document that boundary next to the adapter state that enforces it so future maintainers do not mistake an intentional exclusion for an unfinished feature. The Vercel S3 adapter follows the create-time-only form of this policy.

## Review Checklist

1. Trace create, prepare, mount/materialize, execute, snapshot, preserve/destroy, resume, and failure cleanup.
2. Validate host real paths, remote paths, archives, Git subpaths, symlinks, and command allowlists.
3. Test timeout with a remote operation that completes late.
4. Resume with stale or missing credentials and untrusted persisted state.
5. Compare provider adapters with shared contracts and preserve structured errors without secrets.

## Sources

- `packages/agents-core/src/sandbox/`
- `packages/agents-extensions/src/sandbox/`
- `packages/agents-core/src/runner/sandbox.ts`
- `packages/agents-core/src/runState.ts`
- `packages/agents-core/test/sandboxRuntime.test.ts`
- `packages/agents-core/test/sandboxManifest.test.ts`
- `packages/agents-core/test/sandboxes/`
- `packages/agents-extensions/test/sandbox/`
- `docs/src/content/docs/guides/sandbox-agents.mdx`
- `docs/src/content/docs/guides/sandbox-agents/concepts.mdx`
- `docs/src/content/docs/guides/sandbox-agents/clients.mdx`
