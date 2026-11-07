# SDK examples

Use Node.js 24 and [build the SDK and native runtime](guides/building.md) from the same checkout as the examples. Run commands from the repository root. For a released starter bundle, use the [installation guide](guides/installation.md).

## Check a native workflow without a model key

```sh
pnpm exec tsx examples/codex/scripted-effects.ts
```

The [scripted example](scripted-effects.ts) runs the native tool loop twice with the same synthetic business key. It checks both receipts and one entry in its in-memory ledger. Scripted responses still execute tools. Use application fakes for effects you want to test locally. See [testing native agents](../../packages/agents-codex/TESTING.md).

For a live example, set `OPENAI_API_KEY` and run [basic.ts](basic.ts) the same way. The model requests a greeting tool, and the script prints the final answer. **Run** identifies a command you can execute. **Import** identifies a function or class you can use in your own application.

## Start a conversation

| Task | Example and result |
| --- | --- |
| Pass application data to a tool | Run [typed-context.ts](typed-context.ts) for typed context and structured output, or [application-memory.ts](application-memory.ts) to read a tenant's selected note. Both use a live model. |
| Inspect the settings used by a Turn | **Run** [session-configuration.ts](session-configuration.ts) with scripted responses. It loads ordered instruction files and checks the effective settings and instruction hashes in the Turn receipt. |
| Submit an image | Run [image-input.ts](image-input.ts) for a live response with a validated dominant color. [Scripted image input](input-retrieval-specialist/README.md) exercises the same kind of request locally. |
| Stream and continue a conversation | Run [conversation.ts](conversation.ts) to wait for a captured Turn, read its history, and restore a checkpoint. See [session state](guides/state.md). |
| Reopen a local profile | Run [local-storage.ts](local-storage.ts) with model credentials. It reopens the same Session ID, prints the remembered meal preference, and removes its temporary profile. |
| <a name="store-canonical-conversation-state-in-application-owned-files"></a>Store a conversation in application-owned files | Run [custom-storage.ts](custom-storage.ts) to create and resume a Session in separate processes. Follow [file storage and recovery](guides/session-store.md) to recover a crashed writer or reconcile a pending tool call. |
| Recover callback identities after a crash | **Import** [custom-storage-recovery.ts](custom-storage-recovery.ts) to journal the callback identity before dispatch. Follow [recovery identities](guides/session-store.md#record-recovery-identities-before-dispatch) for the remaining crash window and recovery test. |
| Answer a manual tool request | Run [manual-replies.ts](manual-replies.ts) to answer a typed request, or save and restore a pending Turn. See [manual tools](guides/tools.md#manual-tool-requests). |
| Choose another Turn after an answer | Follow [settled text continuation](settled-text-continuation/README.md). Your application supplies the Session, chooser, and approval handler. |
| <a name="fork-and-supply-a-summary"></a>Explore another answer | **Import** [`exploreAlternative()`](fork-summary.ts). Supply a summary for an idle portable Session without children, goal storage, or pending work. The helper preserves recorded history and closes both Sessions. |

## Select tools and validate output

<a name="choose-another-example"></a>These live examples use the model credentials configured in your application. Each file marked **Run** has a command entry point. For example, run `pnpm exec tsx examples/codex/opening-tools.ts` to see two Sessions with different tenant tools.

| Task | Entry point and behavior |
| --- | --- |
| Select eligible tools | **Run** [operation-selection.ts](operation-selection.ts). It rechecks eligibility before execution. See [tool selection](guides/tools.md#select-tools-for-one-root). |
| Update a tool between Turns | **Run** [tool-updates.ts](tool-updates.ts). It waits for each Turn and the [idle Session update](guides/sessions.md#update-a-session). |
| Bound calls or waiting | **Run** [callback-quota.ts](callback-quota.ts) for a per-run application quota, or [timeout-cleanup.ts](timeout-cleanup.ts) to release a waiter and join Session cleanup. |
| Edit a supported model request | **Run** [prepared-request.ts](prepared-request.ts) against a local Responses endpoint. See [request preparation](guides/request-preparation.md) for supported transports and return values. |
| Correlate model requests and tool calls | **Run** [request-metadata.ts](request-metadata.ts) with scripted responses. It joins request dispatch identities and tool-call occurrences without changing requests. |
| Inspect a tool call | **Run** [call-metadata.ts](call-metadata.ts) with access to its selected model. It reads metadata. Decisions and replies require their own grants. |
| Validate an artifact | **Run** [validated-artifact.ts](validated-artifact.ts). The tool returns validation failures for correction and writes accepted content to an application-selected file. |
| Choose an output contract | **Import** [`runOutputModes()`](output-modes.ts) for native and prompted output, or [`runOutputOverrides()`](output-overrides.ts) to read a root Turn's selected contract. |
| Answer an approval or form | **Import** a [native question handler](native-questions.ts) for your own collector, or **run** its terminal consent demo with model credentials, `MCP_URL`, and `MCP_TOOL`. The configured MCP tool must request URL consent. See [URL consent](guides/interactions.md#explicit-url-consent-and-completion). |
| Aggregate tool results in JavaScript | **Run** [code-mode.ts](code-mode.ts) with access to `gpt-5.5`. The bundled host aggregates synthetic sales. The expected total is 50, and the live answer depends on the model. |

## Work with application data and services

| Task | Start here |
| --- | --- |
| <a name="persistent-application-facts"></a><a name="scope-facts-to-the-authenticated-user"></a><a name="persistence-and-deletion-limits"></a>Keep one fact across Sessions | [Persistent application facts](persistent-memory.md) runs [persistent-memory.ts](persistent-memory.ts) against SQLite with scripted responses. |
| <a name="retrieve-and-check-sources"></a><a name="bound-passages-and-validate-citations"></a>Retrieve tenant passages and check citations | [Live and scripted retrieval](input-retrieval-specialist/README.md#retrieve-and-check-sources-with-a-live-model) explains the live [retrieval.ts](retrieval.ts) entry point and its source-membership check. |
| <a name="selected-documents"></a><a name="select-files-and-connect-tools"></a><a name="continue-reads-and-handle-conflicts"></a><a name="file-and-concurrency-limits"></a><a name="scripted-coverage"></a>Read or revise selected files | [Selected documents](selected-documents.md) runs [selected-documents.ts](selected-documents.ts). **Import** [`SelectedDocuments`](document-workspace.ts) to choose your own trusted root and writable aliases. |
| Search a collection and stage selected documents | [Selective collection](selective-collection.md) composes metadata search, application-owned acquisition, and bounded reads, with a 10,000-document native fixture and a matched bulk-copy benchmark. |
| Finish a deferred job in another process | [External jobs](../../packages/agents-codex/EXTERNAL_JOBS.md) runs [external-job.ts](external-job.ts) with a private state directory and synthetic services. |
| <a name="recover-one-synthetic-external-order"></a><a name="journal-and-recover-the-effect"></a><a name="storage-limits-and-crash-coverage"></a>Recover a synthetic order after restart | [External order recovery](concurrency-effects/README.md#recover-one-synthetic-external-order) runs [external-order-recovery.ts](external-order-recovery.ts) with a journal on disk and a provider lookup. |
| Apply MCP argument and approval policy | Run [mcp-policy.ts](mcp-policy.ts) with model credentials and `MCP_URL` set to a trusted Streamable HTTP server exposing `lookup({ key })`. This example sends no MCP credentials. |
| Resume one MCP thumbnail task | Follow [MCP Tasks](../../packages/agents-codex/MCP_TASKS.md) to start local peers and run [mcp-tasks.ts](mcp-tasks.ts) with a private POSIX state directory. |
| <a name="bounded-mcp-reports"></a>Bound MCP results | [The report recipe](mcp-reports.md) runs [mcp-reports.ts](mcp-reports.ts) and keeps the full result in application storage. |
| <a name="await-mcp-call-observers"></a>Observe one classic MCP call | Run [mcp-observers.ts](mcp-observers.ts). It uses the built classic packages and local synthetic callbacks. |
| Search the web through the native provider | Run [native-web-search.ts](native-web-search.ts) with model credentials. See [native web search](guides/tools.md#native-web-search) for search modes and limits. |
| Use provider-hosted file search, code, and images | Follow [the hosted-tools example](hosted-tools/README.md) with the current native source build and model credentials. |
| Call two remote Agents over A2A | Follow the [A2A guide](../../packages/agents-codex/A2A.md) to run the [two-agent example](a2a/two-agents.ts) against local scripted peers. Use the current source checkout. |
| Resume deferred A2A work after a coordinator restart | Follow [the deferred A2A workflow](../../packages/agents-codex/A2A.md#run-deferred-work-across-coordinator-restarts) to run [deferred-thumbnail.ts](a2a/deferred-thumbnail.ts) against a long-lived local peer. |

## Connect an executor or a specialist

| Task | Start here |
| --- | --- |
| <a name="run-the-specialist-example"></a>Consult an independently configured Agent | [Run the standalone specialist](input-retrieval-specialist/README.md#run-the-standalone-specialist). [specialist-agent.ts](specialist-agent.ts) checks both tool receipts without model credentials. |
| <a name="remote-executor"></a><a name="configure-native-children"></a><a name="wait-for-captured-child-turns"></a><a name="apply-collaboration-policy"></a>Inspect a remote workspace or run native children | Follow [remote executor setup](guides/executors.md#run-the-remote-executor-example) to run [remote-executor.ts](remote-executor.ts). **Run** [native-children.ts](native-children.ts) with the same executor and model credentials, or **import** `runNativeChildren()` to admit a reviewer role to the same Session. |
| Run a local command with workspace access | **Run** [local-execution.ts](local-execution.ts) with scripted responses. It verifies a command and a file write in a temporary directory. See [local execution](guides/local-execution.md) and [workspace grants](guides/workspace-grants.md). |
| Configure executor approvals | **Import** [`executorEnvironment(url, cwd)`](executor-decisions.ts). Supply a provisioned executor, workspace, application context, and Session lifecycle. |
| <a name="trusted-project-guidance"></a>Load instruction files or discover skills | Run [session-configuration.ts](session-configuration.ts) with scripted responses, or [workspace-layout.ts](workspace-layout.ts) with an authenticated WSS executor, assigned workspace, and model credentials. See [instruction files and skills](guides/project-guidance.md). |
| Supervise a worker in a local execution environment | [Supervised worker](supervised-worker/README.md) covers submission, attention requests, deadlines, and recovery with the current source build. |
| Combine two native child results | [Parallel research](parallel-research/README.md) requires a live model and a compatible WSS executor. It records the issued child Turn identities and source receipts. |
| <a name="embedded-native-commands"></a>Run an embedded command | [Embedded native commands](embedded-commands/README.md) lists the local catalog and shows how to call the [command helper](embedded-commands.ts) with your Session. |

## Run a focused lesson

| Task | Recipe |
| --- | --- |
| Compare input, retrieval, and specialist tools | [Scripted input and delegation](input-retrieval-specialist/README.md) |
| Share a quota and inspect effects after failure | [Concurrency and effects](concurrency-effects/README.md) |
| <a name="native-telemetry-and-a-small-evaluation"></a><a name="record-native-telemetry"></a>Inspect native traces, logs, and application receipts | [Observability](observability/README.md) includes a [four-outcome CLI](native-telemetry.ts). **Import** [`runWithTrace()`](native-trace-context.ts) to pass W3C trace headers into a nested specialist run. |
| Add or replace trace processors | **Run** [trace-processors.ts](trace-processors.ts). It checks the initial, additive, and replacement processor routes against a local receiver. See [trace processors](guides/trace-processors.md). |
| <a name="evaluate-two-scripted-cases"></a>Compare model and tool behavior | [Evaluation](evaluation/README.md) covers repeated trials and the [two-case catalog CLI](evaluate-catalog.ts). Select live mode and supply credentials to compare live models. |
| Start a local MCP peer or aggregate tool data | [Stdio and programmatic tools](stdio-programmatic/README.md) |
| <a name="project-native-text-into-a-ui-stream"></a>Display native results in a browser | [Native UI streams](native-ui/README.md) projects SSE for Vercel UI and AG-UI clients. The [web starter](web-starter/README.md) runs a browser application. |
| Connect a report worker to a browser | [HTTP report service](http-report-service.md) runs [http-report-service.ts](http-report-service.ts) with model credentials and a local demo token. |

## Use the classic API or migrate a run

| Task | Recipe |
| --- | --- |
| <a name="classic-api-example"></a><a name="use-voice-or-migration-examples"></a>Run a classic Agent and Runner | Run [classic.ts](classic.ts) against a scripted Model with the built classic packages. The [classic guide](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/packages/agents/CLASSIC.md) lists the imports. The [GPT Live browser demo](live/README.md) connects voice to a classic order specialist. |
| Prepare a classic Model request | [Prepared model declarations](prepared-model-declarations/README.md) changes the request while preserving the original tool's execution and approval policy. |
| Run a supported classic Model through the native loop | [Migrate a Model](guides/migrate-models.md) runs [migration.ts](migration.ts) with a scripted Model and the built native runtime. |
| <a name="stream-a-migrated-sdk-model-without-a-model-key"></a>Display tentative events and accepted results | [Migrated streaming](guides/migrate-sessions.md#live-model-events-and-accepted-semantic-replay) runs [migration-stream.ts](migration-stream.ts). |
| <a name="reopen-a-migrated-file-session-without-a-model-key"></a>Reopen completed classic history | [File Session recovery](guides/migrate-sessions.md#reopen-an-application-owned-file-session) runs [migration-session.ts](migration-session.ts) across three processes. |
| Finish a classic approval before migrating | [Classic approval handover](migration-engine-ownership/README.md#finish-an-existing-classic-approval) runs [migration-classic-handover.ts](migration-classic-handover.ts) to finish an approval on its original engine. |
| <a name="held-migration-function"></a>Approve or reject one migrated function | [Migrated tool approval](guides/migrate-tools.md#hold-one-function-for-approval) runs [migration-approvals.ts](migration-approvals.ts) and joins its continuation. |
