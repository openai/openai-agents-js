# SDK examples

Run these commands from the repository root after [building the native addon](guides/building.md). Each example says when you need model credentials.

- [basic.ts](basic.ts): ask an Agent to use a greeting tool, then print its answer.
- [image-input.ts](image-input.ts): submit an inline PNG and return a validated dominant color. Run `pnpm exec tsx packages/agents/examples/image-input.ts` with model credentials. Set `OPENAI_BASE_URL` to use a different Responses endpoint.
- [typed-context.ts](typed-context.ts): pass application context to a tool and validate a typed final answer.
- [conversation.ts](conversation.ts): observe a captured Turn through completion, inspect history, and restore a saved conversation. See [Session history and state](guides/state.md).
- [manual-replies.ts](manual-replies.ts): answer a typed manual request, then save and restore a pending turn. See [Manual tool requests](guides/tools.md#manual-tool-requests).
- [external-job.ts](external-job.ts): prepare a durable manual job, finish it in another process, and resume from the saved checkpoint. See [Run an external job across processes](../EXTERNAL_JOBS.md).
- [application-memory.ts](application-memory.ts): read a selected note through an application-owned async API, with tenant identity supplied through context.
- [persistent-memory.ts](persistent-memory.ts): save, reopen, recall and delete one SQLite fact per authenticated user. See [Persistent application facts](#persistent-application-facts).
- [retrieval.ts](retrieval.ts): search tenant passages and check citations from the current run. See [Retrieve and check sources](#retrieve-and-check-sources).
- [validated-artifact.ts](validated-artifact.ts): use an audience note, return expected JSON validation failures for correction, and write accepted content to an application-selected file.

The introductory examples use the public `@openai/agents` API and run without a remote executor. Examples that create a provider also close it. The conversation example keeps its portable checkpoint in memory. The external-job example uses local application state and its own synthetic services.

## Check a native workflow without a model key

```sh
pnpm exec tsx packages/agents/examples/scripted-effects.ts
```

The example uses the public `@openai/agents/testing` helper to script two calls with the same synthetic key. The real native loop executes the application's tool, and the example checks both returned receipts and one entry in its fake ledger. It requires no model API key.

These checks cover tool execution and the fake effect within this process, without testing model judgment or durable deduplication. A scripted model still executes registered tools. Inject safe application fakes before testing effects. See the [testing guide](../TESTING.md) for helper ownership and network limits.

### Run the specialist example

Run [specialist-agent.ts](specialist-agent.ts) to consult a separately owned Agent without a model key:

```sh
pnpm exec tsx packages/agents/examples/specialist-agent.ts
```

The outer `consult` tool opens an independent specialist Session with only a selected readonly catalog value, one `read_catalog` tool and a strict summary schema. The example checks both actual tool receipts.

The outer tool's cancellation signal closes and joins that inner Session, including cancellation during opening or submission. Each scripted peer closes its provider after its Sessions settle. An unexpected callback or output-validation failure rejects the outer run. The specialist's cancellation error also remains visible in the outer Turn's cleanup errors; callers must observe cancellation and Session-close failures.

This example combines two Agents with independent Sessions. Native children use a shared Session and different lifecycle rules. Selecting context and tools limits what the specialist receives. It does not sandbox arbitrary callback closures. The application must select trusted tools and data.

## Run a focused lesson

These lessons use scripted model responses unless noted. Run the commands from the checkout or call the exported helper where indicated. Scripted responses still execute the declared tools.

| Task | Lesson | Expected result |
| --- | --- | --- |
| Submit an inline image, retrieve tenant passages, or consult a specialist | [Input, retrieval, and specialist tools](input-retrieval-specialist/README.md) | Validated synthetic color, checked source IDs, or a selected catalog summary. |
| Share a quota and inspect effects after failure | [Concurrency and effects](concurrency-effects/README.md) | One reservation across two Sessions and one ledger entry for a repeated logical write. |
| Inspect native telemetry beside application outcomes | [Observability](observability/README.md) | A local JSON artifact with received traces, logs, application receipts, and projected history. |
| Compare repeated trials and model configurations | [Evaluation](evaluation/README.md) | Separate completion, answer, and tool-behavior scores, plus an optional baseline comparison. Live mode requires explicit selection and credentials. |
| Launch a selected local MCP peer or aggregate tool data in V8 | [Stdio and programmatic tools](stdio-programmatic/README.md) | The synthetic catalog price or a paper-sales total of 50 dollars. |
| Decide whether to continue after a settled answer | [Settled text continuation](settled-text-continuation/README.md) | An application decides whether to submit another Turn after reading the prior result. |
| Prepare the classic Runner's model request | [Prepared model declarations](prepared-model-declarations/README.md) | A scripted model sees adjusted declarations. The original tool still waits for approval. |
| Combine findings from two native children | [Parallel research](parallel-research/README.md) | The parent's answer, issued child Turn identities, and source receipts. This lesson makes live model requests and requires a real WSS executor. |

## Stream a migrated SDK Model without a model key

[migration-stream.ts](migration-stream.ts) uses the public `@openai/agents/migration` entrypoint and an in-process classic ScriptedModel with the real native loop.

```sh
pnpm exec tsx packages/agents/examples/migration-stream.ts
```

The example counts live **unvalidated** Model events without printing their content. It waits for final guards and physical cleanup, then reads accepted SDK semantic replay and final output. See [the packaged migration guide](../CLASSIC.md#live-model-events-and-accepted-semantic-replay) for the 4 MiB raw backlog policy, cancellation and stream ownership.

## Reopen a migrated file Session without a model key

[migration-session.ts](migration-session.ts) exposes `openFileSession(path, sessionId)` and `runMigrationSessionPhase(phase, session, effectsPath)`. It combines a selected public classic `ScriptedModel` with an application-owned JSON history store and real file effects. See [the complete invocation and storage limits](../CLASSIC.md#reopen-an-application-owned-file-session) for three sequential application processes that retain 4, 8, then 10 items without replaying the old effect.

Use Node.js 24 and built classic packages with the matching native addon and runtime helpers. Keep the files in a private application-owned directory with one sequential writer. Reuse the same session identity and history path after restart.

Successful awaited writes survive ordinary application restarts. After a failed write, the application must reconcile its state before another run. This recipe saves completed classic Session history, with the existing migration admission limits. It does not save pending approvals or native checkpoints, and it makes no crash-durability or exactly-once-effect promise. Importing the module does not start the example.

## Held migration function

[The held-function example](migration-approvals.ts) uses a scripted Model and a native-held registered function without credentials. It checks that execution waits for consent, then approves or rejects the exact live item and joins continuation. The carrier stays in the original process; it is not RunState or a checkpoint. See [the packaged migration contract](../CLASSIC.md#hold-one-function-for-approval).

```sh
pnpm exec tsx packages/agents/examples/migration-approvals.ts
pnpm exec tsx packages/agents/examples/migration-approvals.ts reject
```

## Embedded native commands

[Discover and run embedded commands](embedded-commands/README.md) reads the model-free catalog and uses [the command helper](embedded-commands.ts) with an application-owned Session. It preserves native compaction and review Turns, background-terminal cleanup receipts, and thread-name updates.

## Choose another example

Supply model credentials for entries that make live requests. Run a command entrypoint directly. Call an exported function from your application, because running its file alone does not call it.

| Task | File and entrypoint | What your application supplies |
| --- | --- | --- |
| Select eligible tools before a root or model step | [operation-selection.ts](operation-selection.ts): command entrypoint or call `runExample()` | Current model credentials. The example uses an in-memory record and checks eligibility again before execution. See [tool selection](guides/tools.md#select-tools-for-one-root). |
| Validate native or prompted output | [output-modes.ts](output-modes.ts): call `runOutputModes()` | Current model credentials. The example catches validation errors without printing rejected output. |
| Choose a root Turn's output contract | [output-overrides.ts](output-overrides.ts): call `runOutputOverrides()` | Current model credentials. The example reads each selected output contract through its issued Turn. |
| Replace a function callback between completed turns | [tool-updates.ts](tool-updates.ts): command entrypoint or call `runToolUpdates()` | Current model credentials. The example awaits each Turn and the idle update; see [Update a session](guides/sessions.md#update-a-session). |
| Limit calls with an application quota | [callback-quota.ts](callback-quota.ts): command entrypoint | Current model credentials. The example creates a fresh quota in each run's context; the quota grants no native tool permissions. |
| Configure executor argument and stop decisions | [executor-decisions.ts](executor-decisions.ts): call `executorEnvironment(url, cwd)` | A provisioned executor endpoint and workspace, plus your own Session lifecycle and context. This helper configures callbacks; it does not execute a model or provision an executor. See [Remote executor tools](guides/executors.md#remote-executor-tools). |
| Transform MCP arguments and approve a native MCP call | [mcp-policy.ts](mcp-policy.ts): command entrypoint | Current model credentials and access to `gpt-5.5`. Set `MCP_URL` to a trusted Streamable HTTP record server exposing `lookup` with a string `key` argument. Set `OPENAI_BASE_URL` for an alternate Responses endpoint. This example does not set MCP credentials. |
| Resume one MCP thumbnail task | [mcp-tasks.ts](mcp-tasks.ts): command entrypoint; see [MCP Tasks](../MCP_TASKS.md) | Node.js 24, a private POSIX state directory, and separately started local MCP and model peers. Uses a synthetic local credential; handles one thumbnail call per order and rejects forms. |
| Inspect tool call metadata | [call-metadata.ts](call-metadata.ts): command entrypoint | Current model credentials and access to its selected `gpt-5.5` model. Call metadata grants no control or reply authority. |
| Give two Sessions different tenant tools | [opening-tools.ts](opening-tools.ts): command entrypoint or call `runOpeningTools()` | Current model credentials. The example supplies separate tenant declarations and joins both requests before closing its provider. |
| Connect a report worker to a browser | [http-report-service.ts](http-report-service.ts): command entrypoint or call `startReportService()` | Current model credentials and a local demo token. The [service recipe](http-report-service.md) covers detached readers, live choices, Stop and authorized downloads. |
| Close and reopen a local conversation | [local-storage.ts](local-storage.ts): command entrypoint or call `runLocalConversation(path, options?)` | Current model credentials and a trusted profile directory. The CLI uses a temporary private profile, reopens the same Session ID, prints `Reopened answer:` with the remembered meal preference, and removes the profile. `useLocalStorage(path, resume?, options?)` retains the caller-selected profile for record lookups. |
| Expose selected text documents | [document-workspace.ts](document-workspace.ts): import `SelectedDocuments` | Selected files, a trusted root and permitted writes. Attach its tools to your Agent; see [Selected documents](#selected-documents). |
| Bound a result wait and join cleanup | [timeout-cleanup.ts](timeout-cleanup.ts): command entrypoint or call `runWithTimeout()` | Current model credentials. A timeout releases the waiter; owned Session disposal then stops and joins its work. |
| Answer native questions and forms | [native-questions.ts](native-questions.ts): call `askOnceWithForms(agent, input, collect)` or `answerNextSessionQuestion(session, collect, signal)` | An application-owned Agent or Session and form collector. The helpers deny approvals and decline URLs. The Session reader includes [Session-scoped URL requests](guides/interactions.md#when-requests-are-available). `askWithQuestions` handles requests owned by its Turn. Manual tools need their own handler. |
| Reuse completed classic history after approval | [migration-classic-handover.ts](migration-classic-handover.ts): command entrypoint | Built addon, no model credentials. Answer the terminal's approval prompt. The example completes the original classic run, passes its history through a classic Session, and checks that the native continuation does not repeat the effect. See [Completed Session history](../CLASSIC.md#completed-session-history). |
| Aggregate tool results with Code Mode | [code-mode.ts](code-mode.ts): command entrypoint or call `runCodeMode()` | Current model credentials and access to `gpt-5.5`. The bundled JavaScript host aggregates synthetic sales; it grants no executor or workspace access. |
| List the workspace skill catalog | [workspace-layout.ts](workspace-layout.ts): command entrypoint or call `runWorkspaceCatalog(task, workspace, model, options?)` | Built matching native products, current model credentials, and an authenticated WSS executor with a prepared workspace. Selects its root for skill metadata with no execution tools. See [Remote skill directories](guides/executors.md#remote-skill-directories). |
| Inspect a pre-provisioned executor | [remote-executor.ts](remote-executor.ts): command entrypoint or call `runRemoteTask(task, environment, options?)` | Current model credentials, access to `gpt-5.5`, and an authenticated WSS executor with an assigned workspace. See [Remote executor](#remote-executor). |
| Admit a native child role | [native-children.ts](native-children.ts): call `runNativeChildren(task, environment, options?)` | The same executor prerequisites, with all three execution tools admitted, and current model credentials. The recipe declares a reviewer role and child/depth limits. |

Run these model-backed examples from the checkout root:

```sh
pnpm exec tsx packages/agents/examples/callback-quota.ts
pnpm exec tsx packages/agents/examples/call-metadata.ts
pnpm exec tsx packages/agents/examples/mcp-policy.ts
pnpm exec tsx packages/agents/examples/opening-tools.ts
pnpm exec tsx packages/agents/examples/timeout-cleanup.ts
pnpm exec tsx packages/agents/examples/code-mode.ts
```

Set `OPENAI_API_KEY` as in the [quickstart](../README.md#run-an-agent). Keep credentials in the server process.

Code Mode is optional. Ordinary function calls do not need generated JavaScript. The example's expected paper-sales total is 50, but a live answer depends on the model. It does not save a pending code cell. Portable idle history checkpoints do not serialize a live JavaScript VM. See the native guide's [history and state limits](guides/state.md#history-and-state).

## Remote executor

The application must provision a compatible executor before running `remote-executor.ts`. Configure the selected workspace and credentials.

- Set `EXECUTOR_URL` to its authenticated `wss://` endpoint.
- Set `EXECUTOR_CWD` to the absolute assigned remote workspace.
- Supply `EXECUTOR_TOKEN` through the application's normal secret mechanism.
- Set `EXECUTOR_CAPABILITIES` only when selecting one absolute remote capability directory.

Set `OPENAI_API_KEY` before running the example.

```sh
pnpm exec tsx packages/agents/examples/remote-executor.ts "Inspect the assigned workspace"
```

The recipe selects `exec_command`, `write_stdin` and `apply_patch`, and prints the settled answer and accepted checklist. Choose a workspace and permissions for this task. Do not use an unrelated host directory or an executor shared with an untrusted tenant.

The SDK closes the Session and provider before returning. The application owns executor deprovisioning. Capability directories permit discovery reads, not a general filesystem sandbox.

### Configure native children

For native children, call the separate `runNativeChildren()` helper with that provisioned `Environment`. It declares one additional `NativeRole` with an explicit model and reasoning effort, `maxChildren: 1`, and `maxDepth: 1`.

Roles provide instructions. They do not isolate authority. Children share the Session's admitted tools, context and executor permissions. Asking the reviewer to avoid edits is an instruction, not an operating-system restriction.

### Wait for captured child Turns

The helper waits for the root Turn, captures the current child snapshots, and awaits each captured child's issued `turn` when present. Root completion alone does not prove that every child finished. Each child wait joins that exact Turn. It does not join future child turns or every descendant that may appear later. The returned statuses describe the snapshot, not a live view.

To cancel a child, use the captured child's `tryCancel(turn)` and join that Turn with `turn.wait()`. See [native children](guides/executors.md#native-child-agents). Before the helper returns, owned Session disposal stops and joins remaining work, then closes the provider. Completed external effects remain.

### Apply collaboration policy

The application can supply `NativeAgents.approval` when declaring native collaboration policy. That callback receives the chosen context, observed call, and cancellation signal. It can allow or deny collaboration dispatch, but cannot replace arguments or expand executor permissions.

Executor approvals belong to `Environment.approval`, and manual-tool decisions use their issued reply flow.

A Session opened with `NativeAgents` keeps its instructions and model/settings fixed, even before a child exists. Open a new Session to change those values. Managed-tool updates remain limited to opening tool names. They do not replace the fixed native-role declaration.

## Selected documents

Run the selected-document demo from the repository root after the SDK and native addon are built:

```sh
pnpm exec tsx packages/agents/examples/selected-documents.ts
```

The demo makes model requests through `NativeProvider`. Use your authorized provider setup, with optional `OPENAI_BASE_URL` for its endpoint. The application creates a temporary UTF-8 document, exposes it as `notes`, and asks the agent to revise its status. It prints the final response and reopened status line, then removes the temporary directory. Importing the example does not run the demo.

### Select files and connect tools

For your own application, import `runSelectedDocuments` from `selected-documents.ts`. Pass the options accepted by `SelectedDocuments.open()`, a task, and optional `NativeProviderOptions`.

The application chooses a trusted root, aliases mapped to relative file paths, and writable aliases. Only the application chooses paths. Model tool arguments use aliases. The runner connects the helper's tools to an `Agent` and disposes its provider when the run ends.

`document-workspace.ts` supplies three custom function tools:

- `read_document` returns up to 4096 Unicode code points, a content revision, and `nextOffset`.
- `search_document` returns up to 16 matches, each with up to 128 code points. Follow its `nextOffset` with the same revision to find phrases across page boundaries.
- `revise_document` replaces one unique text occurrence in a writable document. Read its current revision first. Each replacement accepts at most one page of old and new text. The helper saves and reopens the file before reporting success.

### Continue reads and handle conflicts

Read only the pages needed for the task. Continue with the returned offset and revision. If the revision changes, read again. These bounds apply to returned content, not to total JSON size or a session-wide token budget. Prior tool results can remain in the model's context.

A revision conflict returns a failed `ToolOutput` to the model with a fresh-read instruction. It does not replay an earlier successful edit. Unexpected filesystem errors still reject the run. The direct application methods such as `documents.read()` continue to reject stale revisions so the application can choose its own recovery policy.

### File and concurrency limits

The helper accepts application-selected decoded UTF-8 text files up to 16 MiB, including text the application already extracted from a PDF. It reads each selected file into application memory before returning a page. It does not parse PDF, Word or Excel binaries or perform hosted retrieval. It rejects unknown aliases, disallowed writes and selected paths that become symlinks. It serializes its own edits. Applications with external writers need a shared lock.

### Scripted coverage

The native test in `../test/native/retained-research.test.ts` drives the exported runner with a scripted model server. It checks three Unicode pages, continuation revisions, a boundary-spanning search and an unchanged unselected decoy. The existing research scenario checks saved citations and a later user-directed revision.

## Fork and supply a summary

`fork-summary.ts` shows how an application can choose a summary, compact an idle Session, and explore another answer in a new Session. `exploreAlternative(agent, input, summary)` closes both Sessions in `finally`. The application supplies the summary. The SDK does not ask a model to write it. Recorded history remains available for audit. Use a portable root without goal storage, children or pending work. Local storage does not support this flow.

## Bounded MCP reports

[mcp-reports.ts](mcp-reports.ts) awaits a selected MCP tool and the application's report resolver, then replaces large text and structured results with an excerpt and a private reference. The application can retrieve the original before the connection closes. See the [report recipe](mcp-reports.md) for the command, expected peer protocol, storage limits, media handling and cancellation rules.

## Classic API example

[classic.ts](classic.ts) imports `Agent` and `Runner` from `@openai/agents/classic` and `ScriptedModel` from `@openai/agents/classic/testing`. It returns a scripted answer through the classic runtime. This example needs the built classic workspace packages and their dependencies, but no model API key or native addon.

From the checkout root, run `pnpm exec tsx packages/agents/examples/classic.ts`. See [Select the classic API explicitly](../CLASSIC.md) for the runtime choice and the separate selected-Modal sandbox recipe.

### Use voice or migration examples

The [GPT Live browser example](live/README.md) connects voice conversation to a classic order specialist through Responses delegation. It keeps credentials and tools on the server, runs each specialist request with at most five model turns, and waits for active work before closing Live. See its guide for the command, microphone controls, offline checks, and model-access requirements.

The [migration.ts](migration.ts) example also uses a scripted classic Model, but runs it through the native loop. It needs the matching native addon and runtime helpers as well as built classic packages, and needs no model API key. Run `pnpm exec tsx packages/agents/examples/migration.ts` or call its exported `runMigration()` function. Importing it does not start the example.

## Recover one synthetic external order

Run `pnpm exec tsx packages/agents/examples/external-order-recovery.ts /absolute/trusted/job-directory` with Node.js 24 and the built native addon. The command uses a scripted model and a local synthetic provider; it needs no model credentials and places no real order. Run it again with the same directory to recover or read its terminal receipt. The application selects the directory and authorizes the single order in `syntheticOrder`; model arguments cannot select another order, tenant, endpoint or path.

### Journal and recover the effect

The application journal retains the original pending manual checkpoint, the business identity and payload digest. It records `creating` before dispatch. The provider stores one separate effect record with a private receipt and small public result. On recovery, an authoritative lookup finds that effect or permits a create-or-find request with the same business key. An inconclusive lookup records `unknown` and refuses automatic dispatch. Real services need their own idempotency and authoritative lookup guarantees.

After the result is durable, `answerJob` restores with current declarations and answers only the newly issued live request. It never saves a reply grant or treats a stored call ID as authority. `settleJob` saves terminal completion after that answer settles. A crash between those steps can repeat model continuation from the original checkpoint, while the stored business result prevents another effect.

The provider receipt stays in application storage. Only the public result reaches the model.

### Storage limits and crash coverage

Use one sequential process owner and trusted local storage outside model-visible workspaces. The temporary-file write, file sync and atomic rename protect the prior record during process crashes. They do not provide distributed locking or guarantee power-loss or network-filesystem durability.

The native child-process tests stop at pending, provider-commit, public-result and answered boundaries, then recover with one physical provider effect. This is an application protocol example, not an SDK durable queue or an exactly-once guarantee for arbitrary external APIs.

## Native telemetry and a small evaluation

These Node.js 24 commands use synthetic responses and need no API key.

```sh
pnpm exec tsx packages/agents/examples/native-telemetry.ts
pnpm exec tsx packages/agents/examples/evaluate-catalog.ts candidate.json
pnpm exec tsx packages/agents/examples/evaluate-catalog.ts next.json candidate.json
```

### Record native telemetry

Run [native-telemetry.ts](native-telemetry.ts) in a fresh process. It configures one local `/v1/traces` JSON receiver before opening Sessions.

It records four application outcomes: success, a returned failed tool result that lets the Turn continue, a thrown callback, and invalid structured output.

Each receipt includes the Session ID, Turn ID and settled history. The summary also includes available exported span IDs and attributes. Missing native fields stay missing. Application receipts and exported spans can cover different events.

The command closes each Session and scripted provider before native telemetry shutdown, then closes the receiver.

Prompt, response and tool-result logging stay off. This does not prove complete redaction: other fields, including tool arguments, can contain content. Keep real secrets and user data out of this walkthrough. Native telemetry shutdown does not close classic tracing processors.

### Evaluate two scripted cases

[evaluate-catalog.ts](evaluate-catalog.ts) runs two fixed catalog cases once each. It records executed tool arguments and checks completion, trimmed exact answers and exact call order separately. A duplicate lookup fails even with the expected answer.

The JSON artifact contains synthetic answers and calls, fixed case/catalog fingerprints, model and instructions, and safe failure categories. It omits raw errors, headers and keys. A trial failure still produces an artifact and a failing command exit.

An optional baseline must match the artifact format, scripted mode, case/catalog fingerprint and scorer, with both unique case IDs. Model and instruction changes remain visible for review. The command reports case regressions and the change in passed count.

These two scripted cases check the application integration. They do not measure live model quality, statistical significance, or speed. The application chooses output paths. Use a trusted local directory.

## Persistent application facts

[persistent-memory.ts](persistent-memory.ts) uses Node.js 24's built-in SQLite to save one short fact per authenticated application user. Run `pnpm exec tsx packages/agents/examples/persistent-memory.ts` after building the SDK and matching native addon. Its scripted peer needs no model API key.

The demo saves a fact, closes and reopens the store, recalls it in a fresh Session, then deletes the actual row. It removes its temporary database after cleanup. A real application supplies and retains its own private database path.

### Scope facts to the authenticated user

Authentication chooses `userId` in context. Model arguments contain only the fact. Prepared SQL parameters scope every operation to that user.

The caller owns the store and borrowed provider. Keep the store open until callbacks and Session cleanup finish. Unexpected database errors fail the run. A failed or cancelled run may already have committed a save or delete. Do not automatically replay effects.

### Persistence and deletion limits

This synchronous store demonstrates application data. It is separate from `localStorage`, native memory, checkpoints, reply grants and conversation recovery. It supplies no identity provider, encryption, expiry, retention service or cross-system transaction.

Deleting a row does not erase earlier model context, saved states, history, files or telemetry. Persistence across reopen makes no backup or power-loss durability claim. Do not store real secrets in the demo. The existing [read-only memory example](application-memory.ts) still demonstrates an injected asynchronous service.

## Retrieve and check sources

[retrieval.ts](retrieval.ts) searches a fixed synthetic corpus scoped to the application's tenant. Run `pnpm exec tsx packages/agents/examples/retrieval.ts` with authorized model credentials for a live request; `OPENAI_BASE_URL` can select its Responses endpoint. No vector database or embeddings are needed.

### Bound passages and validate citations

The model supplies a bounded query. The tool returns at most two passages, each capped at 240 Unicode code points, and records only those passages in a fresh map for that run.

After structured output settles, `checkSources` requires every cited ID to appear in that map and requires `found` to match whether the answer cites any sources. Unknown citations reject as an application error.

Provider failures remain failures rather than missing search results. These checks prove source membership. They do not prove that an answer follows from the passages or evaluate answer quality.

## Trusted project guidance

[project-guidance.ts](project-guidance.ts) uses the native SDK with a provisioned remote executor and configured model credentials. The host supplies the trusted executor directory and opts in to its `.claude/rules` tree; the example does not provision the executor. This setup is separate from the introductory examples that need no remote executor.

## Await MCP call observers

Run `pnpm exec tsx packages/agents/examples/mcp-observers.ts` to wait for start/end observers around one synthetic client call. The [complete example](mcp-observers.ts) needs built classic workspace packages, but no credentials, network server or native runtime. The example explains its direct-invocation scope; Agent runs retain their separate approval flow.

## Project native text into a UI stream

[Native UI streams](native-ui/README.md) provides Vercel UI Message Stream v1 and scoped AG-UI examples, with native IDs, canonical display checks and explicit reader ownership. Its CLI makes live model calls and prints SSE. It does not start a web server.

## Store canonical conversation state in application-owned files

[custom-storage.ts](custom-storage.ts) uses `fileSessionStore(directory)` through the public `storage` option. It saves the native runtime's full canonical snapshot, including conversation history and native state. Run it with model credentials and retain both the directory and the returned conversation ID. The CLI accepts an optional `OPENAI_BASE_URL` for a Responses endpoint:

```sh
pnpm exec tsx packages/agents/examples/custom-storage.ts /absolute/private/conversations
pnpm exec tsx packages/agents/examples/custom-storage.ts /absolute/private/conversations SESSION_ID
```

Each process closes its Session before the next process resumes it. The adapter supports one writer per conversation. A separate directory lock holds a random ownership token. Commits compare the expected revision, sync a temporary file, rename it over the prior record, and sync the directory before returning. Retrying the latest logical write with the same write ID, expected revision, and exact snapshot succeeds without adding a revision. Applications must serialize operations within each acquired lease.

This is a Node reference adapter for trusted local filesystems with atomic rename and file and directory `fsync`. It targets process crashes after a completed commit. It does not support network filesystems or promise recovery from disk failure. Provision a private directory; snapshots can contain prompts and tool results. The adapter rejects IDs with path separators and leaves corrupt records in place with an error. It does not make external tool effects atomic or deduplicate those effects.

A crashed process leaves its `<sessionId>.lock` directory. The adapter never removes stale locks automatically. Before explicit recovery, stop and confirm that the former writer process is dead. Then remove only that conversation's lock directory and resume with a fresh adapter. Never remove a live writer's lock: doing so breaks the single-writer guarantee. Preserve its `.json` record and any evidence needed to diagnose the crash. An interrupted commit may leave a `.tmp` file; readers ignore these files.

The same adapter instance accepts an exact release retry after removing the lock, including a lost acknowledgment or a failed final directory sync. The retry syncs the directory without touching a successor writer's lock. If release removes the owner file but cannot remove its lock directory, it retains ownership of that exact directory so a retry can finish cleanup. It rejects a replacement directory and preserves unexpected files. A process crash during partial cleanup requires the operator recovery described above. Do not remove an empty lock directory merely because its owner file is missing; another process may still be acquiring it.

For built-in `localStorage(directory)`, the rollout file holds canonical execution history; supported checklist and goal stores retain their separately owned state. The recorder's enqueue acknowledgment accepts records into its queue. The built-in thread store's append waits for the subsequent flush barrier. A successful append, standard persistence, or flush barrier drains prior accepted records and flushes the rollout file to the operating system, so another process can read them after process death. This boundary does not promise survival after host failure or power loss. Once a canonical operation surfaces a failure, the SDK retains that failure through later flush, completion, and close operations, while still attempting writer cleanup. Repeated `Session.close()` calls continue to report an unresolved canonical failure after resource cleanup finishes. Search indexes and telemetry are rebuildable data; they never prove tool completion.

The custom-store API is a preview. Supply an object that implements `SessionStore` directly as `Agent.session({ storage })`. `acquire(sessionId)` returns an exclusive writer token. The SDK calls `read(sessionId, token)` only after acquisition, including during resume. `read` returns `null` for a missing conversation or the opaque snapshot string last accepted by the backend. `commit(sessionId, token, writeId, expectedRevision, snapshot)` must atomically check ownership and the expected revision, then make the complete snapshot durable before it resolves. The initial revision is zero; each successful write advances it by one. The backend must accept an exact retry of its latest write identity without advancing the revision again. An optional `flush(sessionId, token)` supplies a further durability barrier. Omitting `flush` asserts that every completed commit already meets the backend's durability promise. `release(sessionId, token)` releases only that owner and preserves its saved data. The SDK serializes operations within an acquired lease. Adapter methods must not reenter the Session they serve.

Snapshots contain canonical native creation metadata, ordered rollout changes, tool calls, and recorded tool results. Native memory holds only a disposable projection of these records. Indexes and telemetry do not establish tool completion. Custom storage currently supports root conversations with application-managed function tools. It rejects environments, native search, checklists, goals, child agents, manual tools, MCP, Code Mode, forks, and portable SessionState before effects. Supply current application tool bindings when reopening; saved data never supplies credentials or callback implementations.

A tool call must reach canonical storage before dispatch. Its real result must reach canonical storage before the SDK releases the response to native execution. An append, commit, or flush failure blocks further work and remains visible through completion and close. Closing still attempts to release the writer. The SDK never switches a failed custom store to memory or local storage. If a commit loses its acknowledgment, the SDK reads under the same token and checks that the saved snapshot exactly matches the submitted write. It then confirms that same write through an idempotent commit retry. Both checks must succeed before execution continues. Otherwise, close the Session and inspect the backend before continuing. Started sibling effects remain external facts; the SDK cannot roll them back.

An unresolved tool intent blocks automatic resume, including repeated resume attempts. First reconcile the original action against authoritative external records. With the Session closed and the former process dead, call `reconcileSessionStore(store, { sessionId, turnId, callId, result })` with the original native identities and the verified result. `result` accepts a string or `ToolOutput`, including failed or structured results, and uses the same validation and conversion as ordinary tool callbacks. As with ordinary receipts, canonical history preserves the output content; Core omits runtime-only success metadata when serializing either path. This operation acquires the writer, verifies that the original call remains unresolved, and records its result without executing the tool. It rejects a second result for the same call. Then reopen that same conversation with the current application's tools and credentials. Do not invent a result or remove the pending intent to bypass this check.

Snapshot format version 1 is native SDK data, not a cross-language checkpoint. Keep backups and qualify a new SDK/runtime revision before upgrading stored conversations. The SDK rejects unknown format versions. This reference adapter rewrites the full accumulated snapshot at each commit; it suits a bounded example, not an unmeasured production workload. Qualify your production backend's atomic writes, fencing, acknowledgment loss, crash recovery, and storage capacity separately.
