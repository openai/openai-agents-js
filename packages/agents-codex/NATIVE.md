# Native API

Import the SDK from `@openai/agents`. Codex runs model turns and maintains conversation history. Your application supplies tool callbacks and closes the resources it opens. Start by [running your first agent](README.md#run-an-agent), then choose a task below.

Read [the architecture guide](examples/guides/architecture.md) for runtime ownership, the differences from v0 and Classic, and the contracts for turns, observations, and recovery.

## Install

- [Install the SDK and run the starter](examples/guides/installation.md)
- <a name="add-the-sdk-to-an-existing-application"></a>[Add the SDK to an existing application](examples/guides/installation.md#add-the-sdk-to-an-existing-application)
- <a name="deno-and-bun"></a>[Deno and Bun](examples/guides/installation.md#deno-and-bun)
- <a name="build-from-source"></a>[Build from source](examples/guides/building.md#build-from-source)

The guides describe this source checkout. For the `0.22.0-alpha.1` starter, use the [installation guide](examples/guides/installation.md) and the [documentation at its release tag](https://github.com/openai/openai-agents-js/blob/v0.22.0-alpha.1/README.md). Build the current source when a guide identifies a newer feature.

## Run and manage sessions

- <a name="agents-and-sessions"></a>[Agents and sessions](examples/guides/sessions.md#agents-and-sessions) · <a name="update-a-session"></a>[Update a session](examples/guides/sessions.md#update-a-session)
- <a name="provider-connection-and-credentials"></a>[Provider connection and credentials](examples/guides/session-configuration.md#provider-connection-and-credentials) · <a name="per-session-configuration"></a>[Per-session configuration](examples/guides/session-configuration.md#per-session-configuration) · <a name="connection-retries-and-errors"></a>[Connection retries and errors](examples/guides/session-configuration.md#connection-retries-and-errors)
- <a name="context-compaction"></a>[Context compaction](examples/guides/session-configuration.md#context-compaction) · <a name="validate-agent-defaults"></a>[Validate agent defaults](examples/guides/session-configuration.md#validate-agent-defaults)
- <a name="observations-and-interruption"></a>[Stream, steer, and cancel turns](examples/guides/sessions.md#observations-and-interruption) · <a name="read-events-for-one-turn"></a>[Read events for one turn](examples/guides/sessions.md#read-events-for-one-turn) · <a name="interrupt-a-session"></a>[Interrupt a session](examples/guides/sessions.md#interrupt-a-session)
- <a name="cancel-one-root-turn"></a>[Cancel one root turn](examples/guides/sessions.md#cancel-one-root-turn) · <a name="cancel-one-child-turn"></a>[Cancel one child turn](examples/guides/sessions.md#cancel-one-child-turn)
- <a name="native-checklists"></a>[Native checklists](examples/guides/sessions.md#native-checklists)
- <a name="native-telemetry"></a>[Native telemetry](examples/guides/telemetry.md#native-telemetry)

- [Prepare a model request](examples/guides/request-preparation.md) · [Observe request metadata](examples/guides/request-metadata.md)
- [Configure trace processors](examples/guides/trace-processors.md)

## Save and recover a conversation

- <a name="history-and-state"></a>[Read history and restore checkpoints](examples/guides/state.md#history-and-state) · <a name="save-or-suspend-a-session"></a>[Save or suspend a session](examples/guides/state.md#save-or-suspend-a-session) · <a name="restore-instructions-and-tools"></a>[Restore instructions and tools](examples/guides/state.md#restore-instructions-and-tools)
- <a name="output-and-checkpoint-versions"></a>[Output and checkpoint versions](examples/guides/state.md#output-and-checkpoint-versions) · <a name="model-settings-on-restore"></a>[Model settings on restore](examples/guides/state.md#model-settings-on-restore) · <a name="usage-counters"></a>[Usage counters](examples/guides/state.md#usage-counters)
- <a name="manual-suspension-and-repair-receipts"></a>[Manual suspension and repair receipts](examples/guides/state.md#manual-suspension-and-repair-receipts)
- <a name="live-capabilities-and-checkpoint-advice"></a>[Check session capabilities and capture readiness](examples/guides/recovery.md#live-capabilities-and-checkpoint-advice) · <a name="check-capture-readiness"></a>[Check capture readiness](examples/guides/recovery.md#check-capture-readiness)
- <a name="reconcile-external-effects"></a>[Reconcile effects and resume external work](examples/guides/recovery.md#reconcile-external-effects) · <a name="resume-external-work"></a>[Resume external work](examples/guides/recovery.md#resume-external-work)
- <a name="local-native-profiles"></a>[Reopen a local profile](examples/guides/local-state.md#local-native-profiles) · <a name="profile-ownership"></a>[Profile ownership](examples/guides/local-state.md#profile-ownership) · <a name="supported-capabilities"></a>[Supported capabilities](examples/guides/local-state.md#supported-capabilities)
- <a name="reopen-with-descendant-history"></a>[Reopen with descendant history](examples/guides/local-state.md#reopen-with-descendant-history) · <a name="persistence-failures-and-cleanup"></a>[Persistence failures and cleanup](examples/guides/local-state.md#persistence-failures-and-cleanup)
- [Store canonical conversation state in application-owned files](examples/guides/session-store.md)
- <a name="native-local-goals"></a>[Native local goals](examples/guides/local-state.md#native-local-goals)

- [Fork a conversation](examples/guides/state.md#fork-a-conversation) · [Inspect effective turn settings](examples/guides/state.md#inspect-effective-turn-settings)

## Choose an output contract

- <a name="choose-an-output-mode"></a>[Choose an output mode](examples/guides/output.md#choose-an-output-mode) · <a name="native-structured-output"></a>[Native structured output](examples/guides/output.md#native-structured-output) · <a name="prompted-output"></a>[Prompted output](examples/guides/output.md#prompted-output)
- <a name="retry-invalid-prompted-output"></a>[Retry invalid prompted output](examples/guides/output.md#retry-invalid-prompted-output) · <a name="override-output-for-one-turn"></a>[Override output for one turn](examples/guides/output.md#override-output-for-one-turn) · <a name="queue-independent-turns"></a>[Queue independent turns](examples/guides/output.md#queue-independent-turns)
- <a name="wait-steer-and-reply-on-an-overridden-turn"></a>[Wait, steer, and reply on an overridden turn](examples/guides/output.md#wait-steer-and-reply-on-an-overridden-turn)
- <a name="reusable-output-choices"></a>[Reusable output choices](examples/guides/output.md#reusable-output-choices) · <a name="output-policies-in-subclasses"></a>[Output policies in subclasses](examples/guides/output.md#output-policies-in-subclasses)

## Connect tools and executors

- [Run local commands](examples/guides/local-execution.md) · [Grant workspace access](examples/guides/workspace-grants.md) · [Load instruction files and discover skills](examples/guides/project-guidance.md)

- <a name="input-tools-and-output"></a>[Send input and declare tools](examples/guides/tools.md#input-tools-and-output) · <a name="function-tools"></a>[Function tools](examples/guides/tools.md#function-tools) · <a name="tool-discovery"></a>[Tool discovery](examples/guides/tools.md#tool-discovery)
- <a name="tool-results"></a>[Tool results](examples/guides/tools.md#tool-results) · <a name="tool-call-identity"></a>[Tool call identity](examples/guides/tools.md#tool-call-identity) · <a name="manual-tool-requests"></a>[Manual tool requests](examples/guides/tools.md#manual-tool-requests)
- <a name="select-tools-for-one-root"></a>[Select tools for a turn](examples/guides/tools.md#select-tools-for-one-root) · <a name="select-tools-before-a-model-step"></a>[Select tools before a model step](examples/guides/tools.md#select-tools-before-a-model-step) · <a name="selection-limits-and-restore"></a>[Selection limits and restore](examples/guides/tools.md#selection-limits-and-restore)
- <a name="inspect-or-change-tool-values"></a>[Inspect or change tool values](examples/guides/tools.md#inspect-or-change-tool-values)
- <a name="programmatic-tool-calling"></a>[Programmatic tool calling](examples/guides/tools.md#programmatic-tool-calling)
- <a name="native-web-search"></a>[Native web search](examples/guides/tools.md#native-web-search)
- <a name="remote-tools-and-children"></a>[Connect native MCP tools](examples/guides/mcp.md#mcp-connections) · <a name="mcp-connections"></a>[Mcp connections](examples/guides/mcp.md#mcp-connections) · <a name="connect-http-tools-on-demand"></a>[Connect HTTP tools on demand](examples/guides/mcp.md#connect-http-tools-on-demand)
- <a name="run-a-stdio-server-on-the-host-or-executor"></a>[Run a stdio server on the host or executor](examples/guides/mcp.md#run-a-stdio-server-on-the-host-or-executor) · <a name="choose-a-stdio-process-lifetime"></a>[Choose a stdio process lifetime](examples/guides/mcp.md#choose-a-stdio-process-lifetime) · <a name="mcp-call-policy"></a>[MCP call policy](examples/guides/mcp.md#mcp-call-policy)
- <a name="update-mcp-policy-while-idle"></a>[Update MCP policy while idle](examples/guides/mcp.md#update-mcp-policy-while-idle) · <a name="mcp-and-executor-timeouts"></a>[MCP and executor timeouts](examples/guides/mcp.md#mcp-and-executor-timeouts)
- <a name="materialize-a-borrowed-sdk-mcp-namespace"></a>[Borrow an SDK MCP server](examples/guides/mcp.md#materialize-a-borrowed-sdk-mcp-namespace) · <a name="await-observations-on-borrowed-mcp-calls"></a>[Await observations on borrowed MCP calls](examples/guides/mcp.md#await-observations-on-borrowed-mcp-calls)
- <a name="remote-executor-tools"></a>[Connect remote executors and run child agents](examples/guides/executors.md#remote-executor-tools) · <a name="lease-an-executor"></a>[Lease an executor](examples/guides/executors.md#lease-an-executor) · <a name="remote-skill-directories"></a>[Remote skill directories](examples/guides/executors.md#remote-skill-directories)
- <a name="native-child-agents"></a>[Native child agents](examples/guides/executors.md#native-child-agents) · <a name="configured-shell"></a>[Configured shell](examples/guides/executors.md#configured-shell)
- <a name="managed-executor-network-policy"></a>[Managed executor network policy](examples/guides/executors.md#managed-executor-network-policy)

- [Connect or serve remote Agents over A2A](A2A.md) with the current source build.
- [Supervise a native worker](examples/supervised-worker/README.md) in a local execution environment.

## Handle native interactions

- [Choose a cancellation lifetime](examples/guides/sessions.md#choose-a-cancellation-lifetime) · [Wait for a supervisory outcome](examples/guides/interactions.md#wait-for-a-supervisory-outcome)

- <a name="native-questions"></a>[Answer approvals, forms, and URL requests](examples/guides/interactions.md#native-questions) · <a name="collect-form-answers"></a>[Collect form answers](examples/guides/interactions.md#collect-form-answers) · <a name="supported-form-schemas"></a>[Supported form schemas](examples/guides/interactions.md#supported-form-schemas)
- <a name="request-ownership-and-expiry"></a>[Request ownership and expiry](examples/guides/interactions.md#request-ownership-and-expiry) · <a name="read-pending-interactions"></a>[Read pending interactions](examples/guides/interactions.md#read-pending-interactions) · <a name="when-requests-are-available"></a>[When requests are available](examples/guides/interactions.md#when-requests-are-available)
- <a name="explicit-url-consent-and-completion"></a>[Explicit URL consent and completion](examples/guides/interactions.md#explicit-url-consent-and-completion)
- <a name="explicit-verification-and-personal-apps"></a>[Verify a user and configure personal Apps](examples/guides/interactions.md#explicit-verification-and-personal-apps) · <a name="personal-apps-credentials"></a>[Personal Apps credentials](examples/guides/interactions.md#personal-apps-credentials) · <a name="reply-to-a-verification-challenge"></a>[Reply to a verification challenge](examples/guides/interactions.md#reply-to-a-verification-challenge)
