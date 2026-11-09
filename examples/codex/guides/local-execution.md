# Run commands in a local workspace

Use `Environment.local` in `0.22.0-alpha.2` to run selected command tools on your application host. Use a [remote Environment](executors.md#remote-executor-tools) when the workspace belongs to a separate WSS executor. Application function tools run through their Node callbacks and need no Environment.

## Prepare the host and workspace

Use Node.js 24 on Linux or macOS with the matching native addon and packaged helpers. Linux must allow the sandbox helper to create its required namespaces; the [native build prerequisites](building.md#run-the-native-tests) describe the host checks. macOS uses its native sandbox and managed command cleanup. A supported operating system alone does not establish that the host can launch the sandbox.

Choose an existing absolute workspace directory. Install the SDK and helpers outside that directory and every extra writable root. Keep native runtime state and any local conversation profile outside those roots too. A temporary workspace beside the installed application is suitable for the example below.

Import `Environment` from `@openai/agents` and create the local declaration with `Environment.local`. Set `cwd` to the chosen directory and include `exec_command` in `tools`. The local declaration takes no URL, headers, or connection timeout. The [complete local example](../local-execution.ts) shows this setup and its cleanup.

Pass the declaration as the `environment` option when opening `agent.session`. Omitting `tools` grants no command tools. Select `write_stdin` together with `exec_command` when you need to continue a process. By default the workspace remains writable; use [extra write grants](workspace-grants.md) for other directories.

Commands start with a system `PATH` and a fresh environment rather than inheriting the application's variables. A provider API key in the application does not become a command environment variable. The command sandbox permits reads of the workspace, declared writable roots, and platform runtime files. A separately declared host stdio MCP process has its own [process permissions](mcp.md#run-a-stdio-server-on-the-host-or-executor).

## Inspect a read-only workspace

This option is available in current source builds. The `0.22.0-alpha.2` release does not include it.

Set `readOnly: true` to let native commands read the workspace while denying changes to its files. Select command tools explicitly; the default tool list is empty. Replace `/jobs/worker/work` with an existing absolute workspace outside the SDK installation. That workspace must contain the `README.md` file you want summarized. Configure your model-provider credentials before running this example, which makes a model call.

```typescript
import { Agent, Environment, NativeProvider } from '@openai/agents';

await using provider = new NativeProvider();
const environment = Environment.local({
  cwd: '/jobs/worker/work',
  tools: ['exec_command'],
  readOnly: true,
});
const agent = new Agent({
  model: 'gpt-5.5',
  instructions: 'Summarize the assigned workspace.',
  provider,
});
await using session = await agent.session({ environment });
const turn = await session.submit('Read README.md and summarize it.');
console.log((await turn.wait()).finalOutput);
```

The disposal scope closes the Session before its provider.

This option keeps the selected read and network scope. It rejects `apply_patch`, `NativeAgents`, `writePolicy: 'legacy'`, and nonempty `writableRoots`. An empty root list remains valid and cannot remove the read-only ceiling. Restore requires the same read-only mode and applied executor policy. Use a separate ordinary strict Environment for work that needs to edit files.

Local execution requires the supported Linux or macOS sandbox described above. A compatible strict WSS Environment accepts the same option, with enforcement owned by the trusted executor. Node callbacks and MCP services retain their own permissions. The SDK still manages its private runtime state.

## Run and verify the example

Build the [matching workspace and native runtime](building.md), then run from the repository root:

```sh
pnpm exec tsx examples/codex/local-execution.ts
```

The [example](../local-execution.ts) needs no API key. Its scripted model selects real native commands. It creates temporary directories, writes a workspace marker and an extra output marker, then replaces the extra writable directory for a second Turn. It checks command exit receipts, reads the saved bytes, verifies the old directory refused a write, and checks the recorded current roots. After closing the Session and provider, it removes the temporary files and prints:

```text
Verified local writes and replacement roots.
```

The assertions verify effects rather than relying on the scripted final answer. An unavailable sandbox fails this command; the example does not skip the check.

## Diagnose opening and command failures

| Failure | Check and recovery |
| --- | --- |
| `local executor requires the native process helper` or `local executor requires the native Linux sandbox helper` | Build or install the matching platform helpers alongside the addon. See [source setup](building.md). |
| `local executor write roots must not contain installed sandbox helpers` | Move the workspace and extra output roots outside the installed SDK. Granting the application installation as writable is refused. |
| `local executor sandbox launch failed` or `local executor could not establish the platform sandbox` | Check the host's namespace and sandbox support. Opening probes an actual sandboxed command before model work. A container or restricted host can refuse this even with the helpers installed. |
| A command cannot find an application variable or executable | Check the command's fresh environment and system `PATH`; the host application's environment is not inherited. |

Await the issued Turn and [Session cleanup](sessions.md#open-and-run-a-session) before deleting its workspace. A Turn's final answer alone does not show that every retained process ended. Changing a shell wrapper or an approval answer does not expand the workspace grant.
