# Remote executors and child agents

Use an `Environment` to give a native Session access to selected tools on a remote executor. Your application chooses the endpoint, credentials, and permissions; the executor enforces its declared policy.

For commands on the application host, use [local execution](local-execution.md). See [workspace write grants](workspace-grants.md) to add or replace writable directories, and [project guidance and skills](project-guidance.md) to prepare rule files or discover a skill catalog.

Choose how your application owns that connection:

| Declaration | Resource owner |
| --- | --- |
| `Environment` | The application keeps the executor available and disposes it separately. |
| `EnvironmentSource` returning a lease | The application acquires the executor; the Session disposes the accepted lease after its native work and callbacks finish. |

See [timeout defaults](mcp.md#mcp-and-executor-timeouts) for MCP and Environment policies.

## Remote executor tools

Pass an `Environment` to `agent.session({ environment })` with a WSS URL and selected executor tools. Approval, argument, and result callbacks receive the original agent and session context.

For admitted `exec_command`, `write_stdin`, and `apply_patch`, `transformResult` accepts the whole JSON result in direct calls or Code Mode. Only accepted output reaches the model or code. The SDK withholds raw output from observations and native output projections.

If the transform fails, times out, or is cancelled, the SDK withholds the output. It neither repeats nor undoes the effect. `write_stdin` requires `exec_command` and the real process identity.

### Run the remote executor example

[Build the native SDK and workspace packages](building.md), then provision a compatible executor. From the repository root, configure the following application-selected values:

| Variable | Value |
| --- | --- |
| `EXECUTOR_URL` | Authenticated `wss://` executor endpoint. |
| `EXECUTOR_CWD` | Absolute assigned workspace on that executor. |
| `EXECUTOR_TOKEN` | Credential supplied through your application's secret mechanism. |
| `EXECUTOR_CAPABILITIES` | Optional single absolute remote capability directory. |
| `OPENAI_API_KEY` | Model-provider credential. |

The command makes live model calls:

```sh
pnpm exec tsx examples/codex/remote-executor.ts "Inspect the assigned workspace"
```

It selects `exec_command`, `write_stdin`, and `apply_patch`, then prints the settled answer and accepted checklist. Choose a workspace and permissions for this task. Keep unrelated host directories and executors shared with untrusted tenants outside the grant.

The helper closes its Session and provider before returning. Your application still owns executor deprovisioning. Capability directories permit discovery reads, not general filesystem access.

## Lease an executor

An application can instead supply an async `EnvironmentSource`. Acquire the resource inside that function, then return `Environment.lease(environment, dispose, sourceSignal?)` while its async-local resource scope is active. The SDK captures that scope for disposal and keeps the caller's scope unchanged. Return a fresh lease for each opening; a lease cannot be claimed twice or directly disposed while a Session owns it. Ordinary `Environment` values remain borrowed declarations.

Output views accept the same source and signal options. For example, `agent.withOutputType(schema).run(input, { environment: source, signal })` retains the selected output contract while the source and caller cancellation follow their normal lifetimes.

The lease has three ownership stages:

1. The factory receives `{ signal }` and owns acquisition and rollback if acquisition fails.
2. After the SDK accepts the lease, acquisition cancellation ends. The Session retains the resource until native use and callback cleanup finish.
3. The Session invokes the supplied disposer after that work finishes. Release the resource from this disposer.

The optional `sourceSignal` requests Session retirement when the resource owner is interrupted independently. It must not release a resource still in native use. Cleanup also joins an acquisition that returns after cancellation.

A Session `signal` cancels opening through publication. After `agent.session(...)` returns, the caller owns the Session. For `agent.run(..., { signal })`, cancellation stays in effect through run completion and cleanup.

Close retires the native transport, engine, carrier, and entered child callbacks before it disposes the source. Provider resources release afterward, even if the disposer rejects. Concurrent cleanup and retries share the same disposer promise. A disposer cannot close, wait on, or submit to its own Session. Close Sessions before their provider.

## Remote skill directories

For a tested `SKILL.md` layout and catalog check, see [prepare a skill catalog](project-guidance.md#prepare-a-skill-catalog).

Set `Environment.capabilityDirectories` to absolute remote directories to discover their skills. Paths may use POSIX or Windows absolute spelling, or absolute file URIs. The declaration copies the list, so later edits to the input array have no effect.

Omitted directories and `[]` both select no roots, though the native request distinguishes them. The SDK does not inherit controller-host, saved, or executor-advertised roots. Selecting directories permits discovery reads. It grants neither executor tools nor additional workspace write access.

On idle restore, supply the destination's current Environment or a fresh source and directories. A supported Environment manual checkpoint also requires the destination's current Environment and explicit grants. The checkpoint restores neither resources nor permissions, and saved state never retains a source function or an application lease.

Historical messages may mention old skills, but they do not authorize fresh reads of source directories. Direct executor filesystem RPCs remain the executor owner's responsibility. A selected directory is not a general filesystem sandbox.

## Command environment

Source builds: explicit command variables through `Environment.env`, for both local and remote execution.

```typescript
import { Environment } from '@openai/agents';

const environment = Environment.local({
  cwd: '/jobs/worker/work',
  tools: ['exec_command'],
  env: { APP_MODE: 'batch', PATH: '/opt/worker/bin:/usr/bin:/bin' },
});
```

Remote equivalent: `new Environment({ url, cwd, tools, env })`.

Session usage: `agent.session({ environment })`. One-shot usage: `agent.run(input, { environment })`.

| Setting | Behavior |
| --- | --- |
| Explicit values | An immutable copy at construction, overriding the selected executor policy's values for new commands. Empty string values: supported. |
| `undefined` or `{}` | Existing execution defaults: a fresh local environment with a system `PATH`, or the remote executor's existing environment policy. |
| A replacement or restored Session | Current destination values. No saved copy of the earlier map. |
| Private declaration data | The map excluded from the Environment's default JSON, saved configuration, and passive observations. Values printed by commands: ordinary tool output. |

Variable names: nonempty strings without `=` or NUL. Values: strings without NUL. Both names and values: valid UTF-8 text. Reserved SDK helper names: `CODEX_SDK_BWRAP_SEARCH_PATH` and `CARGO_BIN_EXE_bwrap`.

Shell startup scripts: possible subsequent changes to the initial command values.

## Configured shell

For a command task, select `exec_command` in the [remote Environment](#remote-executor-tools) and pass the command directly in its `cmd` argument. For example, `printf proof` is command text for a POSIX shell. Use syntax supported by the executor's shell. Calling this tool does not require a shell wrapper.

The executor supplies its shell type and executable path. The native runtime constructs the launch arguments. For Bash, Zsh and Sh, it uses that path with `-lc` for login startup or `-c` otherwise. This is why a launch such as `/bin/bash -lc ...` can appear. PowerShell and Cmd use different arguments. The native `Environment` API does not expose a shell-selection option, and this route does not promise Bash or login startup on every platform.

Putting `bash -lc ...` inside `cmd` asks the configured shell to launch a second shell. Use that nesting only when the task intentionally needs Bash and Bash is available on the executor. Direct command text still follows the selected tool's [approval limits](interactions.md#native-questions). Keep the owning Session alive for its work and [await cleanup](sessions.md#open-and-run-a-session); changing the command wrapper grants no additional permissions.

## Native child agents

Add a `NativeAgents` declaration to `tools` for workspace delegation with child roles and limits. Children require an explicit model and an `Environment` with `exec_command`, `write_stdin`, and `apply_patch`, even when the delegated task only calls functions or MCP tools.

For delegation without an executor workspace, call separately configured `Agent` instances and let your application coordinate their inputs, results, and lifetimes.

Use `session.subagents()` to get child snapshots. Live children support `submit()`, and their issued turns support `wait()`. Application tool callbacks receive a `ChildInvocation` when invoked by a child.

Add `new NativeAgents({ interactions: true })` to allow supported child approvals and forms through the same Session interaction APIs. This option defaults to `false` and does not add executor permissions.

### Configure native children

Call the separate [runNativeChildren() helper](../native-children.ts) with the provisioned Environment. It declares an additional `NativeRole` with an explicit model and reasoning effort, `maxChildren: 1`, and `maxDepth: 1`.

Roles provide instructions; children share the Session's admitted tools, context, and executor permissions. Asking a reviewer to avoid edits does not impose an operating-system restriction.

### Wait for captured child Turns

The helper waits for the root Turn, captures the current child snapshots, and awaits each captured child's issued `turn` when present. Root completion alone does not prove that every child finished. A child wait joins that exact Turn, not future turns or descendants that appear later. Returned statuses describe the captured snapshot.

To cancel a child, call the captured child's `tryCancel(turn)` and join that Turn with `turn.wait()`. Before the helper returns, Session disposal stops and joins remaining owned work, then closes the provider. Completed external effects remain.

### Apply collaboration policy

`NativeAgents.approval` receives the application context, observed collaboration call, and cancellation signal. It can allow or deny dispatch, but cannot replace arguments or expand executor permissions. Executor approvals use `Environment.approval`; manual tools use their issued reply flow.

A Session opened with `NativeAgents` keeps its instructions and model/settings fixed, even before a child exists. Open a new Session to change them. Managed-tool updates remain within opening tool names and do not replace the native-role declaration.

### Select tools before a child step

Use the optional `NativeAgents.beforeStep` hook to select tools before a child's model step. Its result uses the existing `ToolSelector` contract or `undefined`. Its `ChildBeforeStepContext` has the same preparation fields as `BeforeStepContext`, with `child: ChildInvocation` and `submission: ChildTurn`. Capture `submission` for application code to observe and wait for that exact child Turn outside the callback. The child cannot proceed until `beforeStep` returns, so waiting for it inside the callback rejects. Use `context` for application data, `stepIndex` for its preparation index, and `signal` for cancellation. Keep application policy tied to that child incarnation rather than looking up a later child with the same ID.

Select from the child's admitted tools within its existing collaboration approval. Return `undefined` for the child's defaults or `[]` to select no tools. Narrowing later steps leaves issued work in place.

Each child Turn starts at `stepIndex: 0` and runs the captured hook independently. External asynchronous policy work may run inside the hook; respect its callback signal while waiting for that work. Keep callbacks in current application configuration. The [child example](../native-children.ts) exports `oneToolStepPerChildTurn` to keep tools for the first preparation only.

## Managed executor network policy

Set `Environment.network` to select the SDK-managed proxy policy for native commands. The declaration requires `exec_command`; it does not select additional tools. Omit `network` to retain ordinary restricted networking. An explicit empty object enables a managed policy with no allowed domains.

The [remote execution example](../remote-executor.ts) accepts an application-selected Environment.

### Define network rules

Rules accept ASCII hosts, host patterns, and IP addresses. They cover all ports. Rules cannot contain URLs, ports or IPv6 zone identifiers. The SDK captures an immutable canonical copy, removes duplicates and gives denials precedence. Equivalent case, trailing-dot and IPv4-mapped IPv6 forms share checkpoint identity. DNS can resolve before a request is denied.

Both `allowedDomains` and `deniedDomains` reject a lone `*`. Use `NetworkPolicy.allowAll()` or `allowedDomains: ['**']` to allow public hosts. Use exact hosts or scoped host patterns such as `*.example.com` in `deniedDomains`.

### Allow outbound public hosts

`NetworkPolicy.allowAll()` selects the `**` wildcard for outbound requests to public hosts through the managed proxy. Explicit denials take precedence. Unix-socket access and local binding require separate opt-ins.

The `0.22.0-alpha.1` and `0.22.0-alpha.2` bundles predate `NetworkPolicy.allowAll()`. To try the example before a published bundle includes the helper, [build a local bundle from the current source](building.md#build-a-local-bundle-for-an-application).

After [installing the matching bundle](building.md#install-the-local-bundle), save this Linux declaration as `network-policy.mjs` in your application directory. Choose an existing job-private workspace and keep the SDK and sandbox helpers outside it. From the application directory, run `node network-policy.mjs /absolute/path/to/workspace` with that workspace path. The script validates the declaration and exits. It needs no credentials.

```js
import { Environment, NetworkPolicy } from '@openai/agents';

const workspace = process.argv[2];
if (!workspace) throw new Error('Pass the absolute workspace path.');

const environment = Environment.local({
  cwd: workspace,
  tools: ['exec_command'],
  network: NetworkPolicy.allowAll({
    deniedDomains: ['blocked.example.com'],
    allowAllUnixSockets: true,
  }),
});
```

On macOS, omit `allowAllUnixSockets` to keep Unix-socket access disabled. See [platform requirements](#check-platform-requirements) for the scope of the Linux grant and the separate `allowLocalBinding` option.

### Check platform requirements

Admission uses the remote executor's platform and advertised managed-proxy capability. It requires Linux or macOS and a POSIX workspace. It refuses incompatible controller proxies, legacy sandbox paths and command escalation. The application must still trust its selected executor. An independently managed endpoint firewall does not replace this policy.

Linux requires `allowAllUnixSockets: true`. This permits every reachable Unix socket, including abstract and privileged sockets. Individual socket-path grants are unsupported. Use an executor isolated from privileged host sockets. `allowLocalBinding: true` permits additional local traffic outside the domain rules; on macOS this can include direct traffic to reachable IPs on port 53, including non-DNS traffic. Do not treat domain rules as stronger host isolation.

### Restore the same network policy

Checkpoint policy metadata stores only a versioned digest, not the policy rules or transport credentials. Ordinary conversation and tool history still retain their content. Restoring requires a fresh Environment with an equivalent canonical policy. A changed policy, or an omitted-versus-empty mismatch, rejects before reconnecting or requesting the model. Default checkpoints continue to require the default policy. The explicit-policy envelope rejects older SDK readers rather than allowing them to drop the restriction.

Platform qualification remains separate from declaration checks. Linux proxy enforcement has a dedicated native test. That test does not qualify macOS. Windows explicit-policy enforcement is unsupported.
