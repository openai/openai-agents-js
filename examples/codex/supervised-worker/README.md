# Supervise a native worker

## Attach to a running worker

The live example has been keeping one Session and one root Turn in an owner process. Separate supervisor processes have been observing events, sending exact steering, answering live questions, and cancelling work through a private Unix socket. Disconnecting a supervisor has been leaving that same Turn running.

Prerequisites: a POSIX host, workspace dependencies, the matching [native SDK build](../guides/building.md), and `OPENAI_API_KEY` in the owner's environment. Optional owner settings: `OPENAI_MODEL` (default `gpt-5`) and `OPENAI_BASE_URL`. This source example has been using the current checkout's public `@openai/agents` APIs.

The owner and supervisors have been using the same trusted temporary root from Node's `os.tmpdir()`. If the default directory fails the ownership check, create a private `0700` directory owned by your user and export its absolute path as `TMPDIR` in both terminals. Keep the path short enough for a Unix socket.

Terminal 1, from the repository root:

```sh
pnpm exec tsx examples/codex/supervised-worker/live.ts serve \
  'Write a short release note. First ask me which release date to use.'
```

The first JSON line has been reporting `directory`, `sessionId`, `turnId`, and `submissionId`. The owner has been retaining terminal status until Ctrl-C or SIGTERM, then joining cancellation and closing its resources. Killing the owner has been ending this in-memory run; the durable recovery example below has been covering process replacement.

Terminal 2, with `LIVE_DIR` set to the reported directory:

```sh
LIVE_DIR=/path/from/owner/output
pnpm exec tsx examples/codex/supervised-worker/live.ts status "$LIVE_DIR"
pnpm exec tsx examples/codex/supervised-worker/live.ts observe "$LIVE_DIR"
```

Ctrl-C in Terminal 2 has been detaching only that observer. Reconnecting with the last event's `sequence` has been continuing after that native cursor:

```sh
pnpm exec tsx examples/codex/supervised-worker/live.ts observe "$LIVE_DIR" 12
```

The stream has been returning native events directly, including retention `gap` events. In the JSON stream, `usage_updated` events have been encoding `bigint` counters as exact decimal strings and numeric counters as JSON numbers. `status` has been returning the current questions independently of event retention, along with `running`, `cancelling`, `completed`, `cancelled`, or `failed` state and any final `result`. A completed stream has been ending naturally.

Exact steering, with `TURN_ID` from the latest `turn_started` event:

```sh
TURN_ID=REPLACE_ME
pnpm exec tsx examples/codex/supervised-worker/live.ts steer \
  "$LIVE_DIR" "$TURN_ID" 'Keep the release note under 100 words.'
```

The steering command has been returning the SDK receipt, including `inputId`, or rejecting a stale ID with HTTP 409. It has been submitting once, without falling back to another Turn.

A live reply, with `QUESTION_TURN_ID` and `CALL_ID` copied from `status.questions`:

```sh
QUESTION_TURN_ID=REPLACE_ME
CALL_ID=REPLACE_ME
pnpm exec tsx examples/codex/supervised-worker/live.ts answer \
  "$LIVE_DIR" "$QUESTION_TURN_ID" "$CALL_ID" 'Use November 10.'
pnpm exec tsx examples/codex/supervised-worker/live.ts status "$LIVE_DIR"
```

The owner has been matching the current `ask_supervisor` request and delivering its typed reply through `session.respond`. Duplicate and stale answers have been failing. A lost control response has been leaving delivery uncertain; `status` has been exposing the current state without retrying the mutation.

Cancellation, including the Turn's cleanup:

```sh
pnpm exec tsx examples/codex/supervised-worker/live.ts cancel "$LIVE_DIR"
```

The owner has been creating a random `0700` directory under the trusted temporary root, a `0600` bearer-token file, and a private Unix socket. Clients have been checking ownership and file types before connecting directly. This example has been trusting processes running as the same OS user. It has been exposing model content only to authenticated clients and granting the model no command executor, MCP connection, or host filesystem access.

Scripted verification without live provider credentials:

```sh
pnpm test:native packages/agents-codex/test/native/supervised-worker-live.test.ts
```

## Supervise a durable worker

The supervisor runs one process per worker directory at a time. Each worker has a private directory, executor workspace, local history, and MCP credentials.

Use a supported Linux host with the native addon and local executor helpers. The host must allow a compatible `bwrap` to create user namespaces.

## Run the example

Build the workspace packages and matching native helpers first. [Build the native SDK from source](../guides/building.md).

From the repository root, run the two-worker recovery example.

```sh
OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX=1 pnpm test:native \
  packages/agents-codex/test/native/supervised-worker-example.test.ts \
  -t 'steers and reconnects'
```

The workflow uses scripted Responses and MCP peers. It needs no live model or MCP credentials.

Run the broader check to cover timeout cleanup, reopening, and per-turn write permissions.

```sh
OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX=1 pnpm test:native \
  packages/agents-codex/test/native/supervised-worker-example.test.ts \
  packages/agents-codex/test/native/local-executor-policy-native.test.ts \
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

Use the saved state to choose the supervisor's next action:

| Snapshot state | Meaning |
| --- | --- |
| `working` | Last recorded active-work state. Check the worker process before treating this snapshot as evidence that work is still running. |
| `needs_attention` | The worker recorded a failure or a decision it cannot handle. Inspect the recorded reason and worker error, then join the worker before reopening. |
| `needs_review` | The model returned a claim, but the application has not accepted the artifact. Review the question or missing evidence. |
| `accepted` | The artifact passed the sample's checks and owned resources closed. Publication is a separate application step. |

While the turn runs, give the worker the supervisor's steering input. The worker takes the native turn ID from `turn_started`, passes it to `turn.steerExact`, and saves the receipt in the snapshot.

After the turn completes, pass review findings or an answer as the next task. The worker opens the same thread ID and starts a new turn. Wait for the old worker process to exit before starting its replacement.

### Wait for work that needs attention

Use [`waitForWorkerAttention`](supervision.ts) when your application owns a root Turn. This example helper has been using public `turn.waitForAttention()` and an internal readiness hook to prefer a settled result over an account block. It has been requiring the matching source build and has been remaining an application example rather than a public SDK API. The wait returns a completed Turn, live requests, a native stop, or an account quota block. A settled native result takes precedence over an account block. Ordinary tool events stay inside the worker.

Choose the next action from the result.

- **Live request.** Send the matching reply through the Session that owns the Turn. Aborting the wait leaves the Turn running.
- **Native stop.** The example saves a known stop in `snapshot.attention`. For `connection_lost`, wait for the old worker to exit, reopen its durable Session, and decide what to submit next.
- **Account quota block.** If your supervisor already reads a trusted account service, [attach its quota feed](account-quota.md). The standard API-key worker runs without a feed.

`superviseArtifact` uses the wait internally. When it reports an attention stop, the example cancels its Turn and closes the Session before exiting. Use the wait directly when you need to answer a live request on that same Turn.

The release-note review question is in `snapshot.claim.question`. Pass the answer as the next task after the worker exits.

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

After confirming the effect:

1. Return a `ReconciledCall` with the original IDs, the confirmed outcome `applied` or `not_applied`, and result text safe for the model.
2. Let the SDK validate the receipt under the native local writer, save the result, and confirm it can be read before admitting the Session.
3. Retain the same receipt for later reopening. An identical receipt can be reused; different values for an already saved result fail.

The SDK guards against replay of reconciled calls in their original thread. Use an application operation key to prevent duplicate effects across new call IDs. This example declares root tools. If your application uses native children, reopen with the root Session ID and copy the reported child or grandchild IDs into each descendant receipt.

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
