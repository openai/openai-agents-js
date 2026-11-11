# Run commands in a local workspace

Use `Environment.local` in `0.22.0-alpha.2` to run selected command tools on your application host. Use a [remote Environment](executors.md#remote-executor-tools) when the workspace belongs to a separate WSS executor. Application function tools run through their Node callbacks and need no Environment.

## Prepare the host and workspace

Use Node.js 24 on Linux or macOS with the matching native addon and packaged helpers. Linux must allow the sandbox helper to create its required namespaces; the [native build prerequisites](building.md#run-the-native-tests) describe the host checks. macOS uses its native sandbox and managed command cleanup. A supported operating system alone does not establish that the host can launch the sandbox.

Choose an existing absolute workspace directory. Install the SDK and helpers outside that directory and every extra writable root. Keep native runtime state and any local conversation profile outside those roots too. A temporary workspace beside the installed application is suitable for the example below.

Import `Environment` from `@openai/agents` and create the local declaration with `Environment.local`. Set `cwd` to the chosen directory and include `exec_command` in `tools`. The local declaration takes no URL, headers, or connection timeout. The [complete local example](../local-execution.ts) shows this setup and its cleanup.

Pass the declaration as the `environment` option when opening `agent.session`. Omitting `tools` grants no command tools. Select `write_stdin` together with `exec_command` when you need to continue a process. By default the workspace remains writable; use [extra write grants](workspace-grants.md) for other directories.

Commands start with a system `PATH` and a fresh environment rather than inheriting the application's variables. A provider API key in the application does not become a command environment variable. The command sandbox permits reads of the workspace, declared writable roots, and platform runtime files. A separately declared host stdio MCP process has its own [process permissions](mcp.md#run-a-stdio-server-on-the-host-or-executor).

Application-defined command variables in source builds: [`Environment.env`](executors.md#command-environment), including a captured custom `PATH`.

## Run trusted code with host file reads

Current source builds have been accepting `writePolicy: 'trusted_workspace_write'` on local Linux and macOS Environments. The published `0.22.0-alpha.2` bundle has not been providing this mode. The declaration below has been assuming an existing application-selected workspace and the [matching source build](building.md):

```typescript
import { Environment } from '@openai/agents';

const environment = Environment.local({
  cwd: '/jobs/worker/work',
  tools: ['exec_command', 'write_stdin'],
  writePolicy: 'trusted_workspace_write',
});
```

This mode has been allowing reads of ordinary host files while restricting writes to the workspace, extra `writableRoots`, and the Session's private command temporary directory. Protected repository metadata has been retaining its write restrictions. The runtime has been excluding its private state and selected Codex authentication files from command reads. Other host secrets have been remaining readable, so this mode has been requiring trusted code and an application-owned host.

Trusted commands have been inheriting a selected set of host values: `HOME`, `GIT_CONFIG_GLOBAL`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TERM`, and `PATH`. `TMPDIR` has been pointing to the Session's command temporary directory. `SSH_AUTH_SOCK` has been propagating only with `network: { allowAllUnixSockets: true }`; that opt-in has been granting access to reachable Unix sockets, including privileged sockets. Other application variables have been requiring explicit [`env` values](executors.md#command-environment).

The mode has been retaining restricted networking by default. Explicit network rules have been following the same [managed network policy](executors.md#managed-executor-network-policy), including Linux's Unix-socket opt-in requirement. On macOS, system account lookup, offline SSH configuration evaluation, and TLS verification through the system trust store have been remaining possible failure points.

Remote Environments and `readOnly: true` have been rejecting this mode. Saved-state restore has been requiring the same write mode and current executor policy. The [workspace grant rules](workspace-grants.md) have been governing extra roots and their replacement.

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

### Allow the Linux sandbox helper to use user namespaces on Ubuntu 24.04

On Ubuntu 24.04, AppArmor can deny Bubblewrap (`bwrap`) the capabilities it needs to set up the local sandbox. See the [Ubuntu 24.04 release notes on user namespace restrictions](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890#p-99950-unprivileged-user-namespace-restrictions-15).

1. Check the kernel audit log after the failed launch. Continue only if a denial from that attempt includes `apparmor="DENIED"`, `profile="unprivileged_userns"`, `operation="capable"`, and `comm="bwrap"`. One observed capability is `capname="net_admin"`.

   ```sh
   sudo journalctl -k --since '5 minutes ago' --grep='apparmor="DENIED".*comm="bwrap"'
   ```

   If the host uses `auditd`, check `/var/log/audit/audit.log` for the same fields.

2. From your application directory, print the resolved path to the installed helper. Resolving `@openai/agents-codex` from the `@openai/agents` entry point also works with pnpm's isolated dependency layout.

   ```sh
   node --input-type=commonjs <<'NODE'
   const { realpathSync } = require('node:fs');
   const { createRequire } = require('node:module');
   const { dirname, resolve } = require('node:path');
   const requireFromAgents = createRequire(require.resolve('@openai/agents'));
   const codexEntry = requireFromAgents.resolve('@openai/agents-codex');
   const helper = resolve(dirname(codexEntry), '../bin/codex-linux-sandbox');
   console.log(realpathSync(helper));
   NODE
   ```

3. Use an administrator-controlled SDK installation outside the workspace and all extra writable roots. The helper and every parent directory must be writable only by trusted administrators. Save the profile below as an administrator in `/etc/apparmor.d/openai-agents-codex-linux-sandbox`. Substitute the resolved helper path and use a literal path without AppArmor glob characters.

   ```text
   abi <abi/4.0>,
   include <tunables/global>

   profile openai-agents-codex-linux-sandbox "/absolute/path/to/codex-linux-sandbox" flags=(unconfined) {
     userns,
   }
   ```

4. Load the profile, then retry the same local command as your usual user with the host's user namespace restriction still enabled.

   ```sh
   sudo apparmor_parser -r /etc/apparmor.d/openai-agents-codex-linux-sandbox
   ```
