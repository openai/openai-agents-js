# Supervise a durable native worker

Run a separate process for each worker. Give each process its own private directory, executor workspace, local history, and MCP credentials. The supervisor admits one process per worker directory at a time. Use a supported Linux host with the native addon and local executor helpers. The sandbox needs a compatible `bwrap` and a host policy that permits its user namespaces.

Build the TypeScript and native packages, then qualify the Linux host by running the synthetic workflow from the repository root.

```sh
OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX=1 pnpm test:native \
  packages/agents-codex/test/native/supervised-worker-example.test.ts \
  packages/agents-codex/test/native/local-executor-policy-native.test.ts \
  -t 'steers and reconnects|joins a timed-out|applies a per-turn write policy'
```

This setting makes the tests fail when the host cannot launch the native sandbox. The default test run skips the example if the first worker reports that the sandbox could not start.

The test starts two processes with a scripted Responses endpoint and a local MCP peer. One process accepts exact-turn steering, then loses its tool reply when the supervisor kills it. The other saves a question for review. A later process opens each original conversation. One supplies a verified tool result and the other answers the question and requests a revision.

## Set up the worker

Pass your application-owned directory, model, API key, and connected MCP client to `superviseArtifact`. Choose the directory and the tools in trusted code. The example explicitly approves `reports.report` as its only selected MCP tool. This tool records a report on the peer. The caller supplies and closes the MCP client. Configure transport deadlines on that client. Core-owned `HttpMCP` and `StdioMCP` declarations use a different path from `selectMcpTools`. Use the selected-tool path with local storage.

The example turns off project guidance. It uses the SDK's managed configuration and opens a local executor with the workspace as its working directory. Each turn grants writes only to that workspace. Commands can read the workspace and the platform files and helpers needed to run the sandbox. They start with a fresh environment and a system `PATH`. Install the SDK and its native helpers outside the worker's workspace. Supply current executor settings again when the worker restarts.

The sample uses an API key and starts with the SDK's default local network policy. Set an explicit policy when your application needs an allowlist. Qualify filesystem and network policy on your target hosts.

## Observe and revise

The worker writes the native thread ID to `snapshot.json` before submitting model work. A status reader can call `readWorkerSnapshot` while the process is active or after it exits. The read uses the application journal and takes no SDK writer. Reconnecting a status reader has no effect on the active turn.

Pass a supervisor's steering input while the original turn is active. The worker takes the native turn ID from `turn_started` and supplies it to `turn.steerExact`. It saves the resulting receipt in the snapshot. After a turn completes, pass review findings or an answer as the next task. The worker opens the same thread ID and starts a new turn.

The worker asks for a standalone `sha256sum draft.md` command in the submitted task. It checks the structured claim, reads the actual bytes of `draft.md`, and looks for a successful invocation of that exact command in the workspace on that turn. Native history combines stdout and stderr. The worker allows shell diagnostics before a single final hash line and compares that line with the digest of the file. A missing draft, a missing matching command result, or a question leaves the draft for review. If the worker rejects an invalid draft, it saves `needs_review` before reporting the error. Set an artifact format and review rules that match your product.

Call `publishAcceptedDraft` after the worker exits. It checks the accepted digest against the current bytes and writes a separate, content-keyed local file. Repeating the publication of the same bytes returns the same path. Production applications own the publication destination, access checks, and operation key.

## Reopen after a crash

Wait for the previous process to exit before reopening its worker directory. If startup fails after that process left a `working` snapshot, the replacement saves `needs_attention` before reporting the error.

Keep the local profile and native thread ID in durable application storage. A cold open can raise `LocalRecoveryRequired` when an original invocation has no saved result. Read `calls` for the original IDs, tool name, namespace, and arguments. Read `turns` and `items` for work that reached the profile. An `interrupted` turn has no recorded completion. Treat these fields as private application data.

Check the effect using an independent record, such as a provider receipt or an application transaction. Keep the worker paused if the result is still unknown.

For selected MCP calls, `onToolStart` receives the native call ID before the client dispatches. Store its link to your application operation key before the call can take effect. A start record alone leaves the outcome unknown.

Return a `ReconciledCall` with the exact IDs, the confirmed outcome `applied` or `not_applied`, and result text safe for the model. The SDK validates every receipt under the native local writer. It saves the results and confirms they can be read before it admits the session. A later open can reuse an identical receipt. Different values for a saved result fail.

The SDK fences replay of the reconciled call IDs. Use an application operation key to prevent duplicate effects across new call IDs. The example handles root calls. An unfinished descendant still blocks cold recovery.

## Set deadlines and measure phases

The startup signal covers selected-tool discovery and native opening. Reconciliation callbacks and MCP transports must also honor their own deadline. A separate turn deadline covers submission and the wait for completion or attention. If submission is still pending at the deadline, the worker starts closing the session, saves `needs_attention` with reason `deadline`, and waits for submission and cleanup to settle before exiting. It does not retry the submission. After admission, the worker cancels the turn and joins its cleanup before saving `needs_attention` with the reason, such as a deadline, rate limit, or unexpected interaction. Wait for the worker to exit before reopening its profile. Cleanup can take longer than the deadline.

Use the snapshot timings to track startup, follow-up submission, the first tool result, and completion separately. The legacy `firstToolMs` field measures time from submission to the first observed managed tool start. It is null if the worker sees no managed tool start.

`firstToolResultMs` measures time from submission to the first result the worker observes in that turn. It counts managed tool finishes and native execution completions with a completed or failed status. A native command can return a result before any managed tool starts. Cancelled or incomplete work does not count. The field is null when the worker observes no result, including when a gap hides it. Older snapshots can omit the field. The worker writes new timing values when it gets a final model output.

Treat the synthetic run as evidence for the reference workflow. Measure production latency and check real artifacts, permissions, and recovery behavior in the adopting application.
