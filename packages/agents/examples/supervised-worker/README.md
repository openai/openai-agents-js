# Supervise a durable native worker

The supervisor runs one process per worker directory at a time. Each worker has a private directory, executor workspace, local history, and MCP credentials.

Use a supported Linux host with the native addon and local executor helpers. The host must allow a compatible `bwrap` to create user namespaces.

## Run the example

Build the workspace packages and matching native helpers first. [Build the native SDK from source](../guides/building.md).

From the repository root, run the two-worker recovery example.

```sh
OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX=1 pnpm test:native \
  packages/agents/test/native/supervised-worker-example.test.ts \
  -t 'steers and reconnects'
```

The workflow uses scripted Responses and MCP peers. It needs no live model or MCP credentials.

Run the broader check to cover timeout cleanup, reopening, and per-turn write permissions.

```sh
OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX=1 pnpm test:native \
  packages/agents/test/native/supervised-worker-example.test.ts \
  packages/agents/test/native/local-executor-policy-native.test.ts \
  -t 'steers and reconnects|joins a timed-out|applies a per-turn write policy'
```

This setting makes the tests fail when the host cannot launch the native sandbox. The default test run skips the example if the first worker reports that the sandbox could not start.

The test exercises two kinds of recovery.

- The supervisor steers the first worker's active turn, then kills its process before it receives the tool reply. A replacement reopens the conversation and supplies a verified tool result.
- The second worker saves a question for review. Its replacement reopens the conversation, answers the question, and requests a revision.

## Set up the worker

Choose the directory and tools in trusted application code. Pass the directory, model, API key, and connected MCP client to `superviseArtifact`.

For local storage, the example uses `selectMcpTools` with an application-owned client. It approves only `reports.report`, which records a report on the peer. Configure the client's transport deadlines and close it when the worker finishes. SDK-owned `HttpMCP` and `StdioMCP` declarations use a separate connection path.

### Configure the executor

The example disables project guidance, uses the SDK's managed configuration, and opens the local executor in the worker's workspace. Each turn grants writes only to that workspace. Commands can read the workspace and the platform files and helpers the sandbox needs.

Commands start with a fresh environment and a system `PATH`. Install the SDK and its helpers outside the workspace. Supply current executor settings again when the worker restarts.

The sample uses an API key and starts with the SDK's default local network policy. Set an explicit policy when your application needs an allowlist. Qualify filesystem and network policy on your target hosts.

## Observe and revise

The worker writes the native thread ID to `snapshot.json` before submitting model work. A status reader can call `readWorkerSnapshot` while the process is active or after it exits. The read uses the application journal and takes no SDK writer. Reconnecting a status reader has no effect on the active turn.

While the turn runs, give the worker the supervisor's steering input. The worker takes the native turn ID from `turn_started`, passes it to `turn.steerExact`, and saves the receipt in the snapshot.

After the turn completes, pass review findings or an answer as the next task. The worker opens the same thread ID and starts a new turn. Wait for the old worker process to exit before starting its replacement.

### Verify and publish the draft

The submitted task asks the agent to run `sha256sum draft.md` as a standalone command. Before accepting the draft, the worker checks three things.

1. The structured result has no open question, and `draft.md` starts with the expected release-note heading.
2. The native history for that turn shows that the exact command succeeded in the worker's workspace.
3. The command's final hash line matches the digest of the current file. Native history combines stdout and stderr, so shell diagnostics can appear before the single hash line.

A missing draft, missing command evidence, or open question leaves the draft for review. If validation raises an error, the worker saves `needs_review` before reporting it. Choose an artifact format and review rules that fit your application.

Call `publishAcceptedDraft` after the worker exits. It checks the accepted digest against the current bytes and writes a separate, content-keyed local file. Repeating the publication of the same bytes returns the same path. Production applications own the publication destination, access checks, and operation key.

## Reopen after a crash

Wait for the previous process to exit before reopening its worker directory. If startup fails after that process left a `working` snapshot, the replacement saves `needs_attention` before reporting the error.

Keep the local profile and native thread ID in durable application storage. A cold open can raise `LocalRecoveryRequired` when an original invocation has no saved result. Read `calls` for the original IDs, tool name, namespace, and arguments. Read `turns` and `items` for work that reached the profile. An `interrupted` turn has no recorded completion. Treat these fields as private application data.

Check the effect using an independent record, such as a provider receipt or an application transaction. Keep the worker paused if the result is still unknown.

For selected MCP calls, `onToolStart` receives the native call ID before the client dispatches. Store its link to your application operation key before the call can take effect. A start record alone leaves the outcome unknown.

Return a `ReconciledCall` with the exact IDs, the confirmed outcome `applied` or `not_applied`, and result text safe for the model. The SDK validates every receipt under the native local writer. It saves the results and confirms they can be read before it admits the session. A later open can reuse an identical receipt. Different values for a saved result fail.

The SDK fences replay of the reconciled call IDs. Use an application operation key to prevent duplicate effects across new call IDs. The example handles root calls. An unfinished descendant still blocks cold recovery.

## Set deadlines

The startup signal covers selected-tool discovery and session opening. Reconciliation callbacks and MCP transports must honor their own deadlines.

The turn deadline starts before `session.submit()` and also covers `turn.waitForAttention()`. The worker handles a deadline according to whether submission has returned a Turn.

- **Submission is pending.** The worker starts closing the session, saves `needs_attention` with reason `deadline`, and waits for submission and cleanup before exiting. It submits the work once.
- **Submission has returned a Turn.** If the wait fails or needs supervisor action, the worker calls `turn.cancel()` and awaits cleanup before saving `needs_attention`. The snapshot records the reason, such as a deadline, rate limit, or unexpected interaction.

Cleanup can outlast the deadline. Let the worker exit before reopening its profile.

## Read snapshot timings

When the worker receives a final model output, it records startup, follow-up submission and completion times. It also records two timings measured from submission.

- `firstToolMs` is the legacy time to the first observed managed tool start. It is `null` when the worker observes no managed tool start.
- `firstToolResultMs` measures time to the first observed result. A managed tool finish or a native execution completion qualifies when its status is `completed` or `failed`. A native command can finish before any managed tool starts.

`firstToolResultMs` is `null` when the worker observes no result, including when an event-stream gap hides it. Older snapshots can omit this field.

Treat the synthetic run as evidence for the reference workflow. Measure production latency and check real artifacts, permissions, and recovery behavior in the adopting application.
