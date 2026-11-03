# Remote executors and child agents

Use an `Environment` to connect to a remote executor. See [timeout defaults](mcp.md#mcp-and-executor-timeouts) for MCP and Environment policies.

## Remote executor tools

Pass an `Environment` to `agent.session({ environment })` with a WSS URL and selected executor tools. Approval, argument, and result callbacks receive the original agent and session context.

For admitted `exec_command`, `write_stdin`, and `apply_patch`, `transformResult` accepts the whole JSON result in direct calls or Code Mode. Only accepted output reaches the model or code. The SDK withholds raw output from observations and native output projections.

If the transform fails, times out, or is cancelled, the SDK withholds the output. It neither repeats nor undoes the effect. `write_stdin` requires `exec_command` and the real process identity.

## Lease an executor

An application can instead supply an async `EnvironmentSource`. Acquire the resource inside that function, then return `Environment.lease(environment, dispose, sourceSignal?)` while its async-local resource scope is active. The SDK captures that scope for disposal and keeps the caller's scope unchanged. Return a fresh lease for each opening; a lease cannot be claimed twice or directly disposed while a Session owns it. Ordinary `Environment` values remain borrowed declarations.

Output views accept the same source and signal options. For example, `agent.withOutputType(schema).run(input, { environment: source, signal })` retains the selected output contract while the source and caller cancellation follow their normal lifetimes.

The factory receives `{ signal }` for acquisition cancellation. Before returning a lease, the factory owns rollback on failure. Once the SDK accepts the lease, acquisition cancellation ends and the SDK retains its resource until native use and callback cleanup finish. Dispose only from the supplied disposer after that handoff. The optional `sourceSignal` requests Session retirement if the resource owner is interrupted independently; it must not release a resource still in native use. Cleanup joins a late acquisition result even when cancellation has already won.

A Session `signal` cancels opening through publication. After `agent.session(...)` returns, the caller owns the Session. For `agent.run(..., { signal })`, cancellation stays in effect through run completion and cleanup.

Close retires the native transport, engine, carrier, and entered child callbacks before it disposes the source. Provider resources release afterward, even if the disposer rejects. Concurrent cleanup and retries share the same disposer promise. A disposer cannot close, wait on, or submit to its own Session. Close Sessions before their provider.

## Remote skill directories

Set `Environment.capabilityDirectories` to absolute remote directories to discover their skills. The declaration copies the list. Later edits to the input array have no effect. Paths may use POSIX or Windows absolute spelling, or absolute file URIs. Omitted directories and `[]` both select no roots. The native request still distinguishes them. The SDK does not inherit controller-host, saved, or executor-advertised roots. Selecting directories permits discovery reads. It grants neither executor tools nor additional workspace write access.

On idle restore, supply the destination's current Environment or a fresh source and directories. Historical messages may mention old skills, but they do not authorize fresh reads of source directories. A supported Environment manual checkpoint requires the destination to supply its current Environment and explicit grants; the checkpoint restores neither resources nor permissions. Saved state never retains a source function or an application lease. Direct executor filesystem RPCs remain the executor owner's responsibility; a selected directory is not a general filesystem sandbox.

## Configured shell

For a command task, select `exec_command` in the [remote Environment](#remote-executor-tools) and pass the command directly in its `cmd` argument. For example, `printf proof` is command text for a POSIX shell. Use syntax supported by the executor's shell. Calling this tool does not require a shell wrapper.

The executor supplies its shell type and executable path. The native runtime constructs the launch arguments. For Bash, Zsh and Sh, it uses that path with `-lc` for login startup or `-c` otherwise. This is why a launch such as `/bin/bash -lc ...` can appear. PowerShell and Cmd use different arguments. The native `Environment` API does not expose a shell-selection option, and this route does not promise Bash or login startup on every platform.

Putting `bash -lc ...` inside `cmd` asks the configured shell to launch a second shell. Use that nesting only when the task intentionally needs Bash and Bash is available on the executor. Direct command text still follows the selected tool's [approval limits](interactions.md#native-questions). Keep the owning Session alive for its work and [await cleanup](sessions.md#open-and-run-a-session); changing the command wrapper grants no additional permissions.

## Native child agents

Add a `NativeAgents` declaration to `tools` to declare child roles and limits. Children require an explicit model and an environment with all executor tools. `session.subagents()` yields child snapshots; live children support `submit()`, and their issued turns support `wait()`. Application tool callbacks receive a `ChildInvocation` when invoked by a child. Add `new NativeAgents({ interactions: true })` to allow supported child approvals and forms through the same Session interaction APIs. This option defaults to `false` and does not add executor permissions.

Use the optional `NativeAgents.beforeStep` hook to select tools before a child's model step. Its result uses the existing `ToolSelector` contract or `undefined`. Its `ChildBeforeStepContext` extends `BeforeStepContext` with `child: ChildInvocation`. Use `submission` for the original child Turn, `context` for application data, `stepIndex` for its preparation index, and `signal` for cancellation. Keep application policy tied to that child incarnation rather than looking up a later child with the same ID.

Select from the child's admitted tools within its existing collaboration approval. Return `undefined` for the child's defaults or `[]` to select no tools. Narrowing later steps leaves issued work in place.

Each child Turn starts at `stepIndex: 0` and runs the captured hook independently. Respect its callback signal when waiting. Keep callbacks in current application configuration. The [child example](../native-children.ts) exports `oneToolStepPerChildTurn` to keep tools for the first preparation only.

## Managed executor network policy

Set `Environment.network` to select the SDK-managed proxy policy for native commands. The declaration requires `exec_command`; it does not select additional tools. Omit `network` to retain ordinary restricted networking. An explicit empty object enables a managed policy with no allowed domains.

The [remote execution example](../remote-executor.ts) accepts an application-selected Environment.

Rules accept ASCII hosts, host patterns and IP addresses. They cover all ports. Rules cannot contain URLs, ports or IPv6 zone identifiers. The SDK captures an immutable canonical copy, removes duplicates and gives denials precedence. Equivalent case, trailing-dot and IPv4-mapped IPv6 forms share checkpoint identity. DNS can resolve before a request is denied.

Admission uses the remote executor's platform and advertised managed-proxy capability. It requires Linux or macOS and a POSIX workspace. It refuses incompatible controller proxies, legacy sandbox paths and command escalation. The application must still trust its selected executor. An independently managed endpoint firewall does not replace this policy.

Linux requires `allowAllUnixSockets: true`. This permits every reachable Unix socket, including abstract and privileged sockets. Individual socket-path grants are unsupported. Use an executor isolated from privileged host sockets. `allowLocalBinding: true` permits additional local traffic outside the domain rules; on macOS this can include direct traffic to reachable IPs on port 53, including non-DNS traffic. Do not treat domain rules as stronger host isolation.

Checkpoint policy metadata stores only a versioned digest, not the policy rules or transport credentials. Ordinary conversation and tool history still retain their content. Restoring requires a fresh Environment with an equivalent canonical policy. A changed policy, or an omitted-versus-empty mismatch, rejects before reconnecting or requesting the model. Default checkpoints continue to require the default policy. The explicit-policy envelope rejects older SDK readers rather than allowing them to drop the restriction.

Platform qualification remains separate from declaration checks. Linux proxy enforcement has a dedicated native test. That test does not qualify macOS. Windows explicit-policy enforcement is unsupported.
