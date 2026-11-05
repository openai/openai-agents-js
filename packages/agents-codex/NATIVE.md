# Native API

Import the SDK from `@openai/agents`. Codex runs model turns and maintains conversation history. Your application supplies tool callbacks and closes the resources it opens. Start by [running your first agent](README.md#run-an-agent), then choose a task below.

## Install

- [Install the SDK and run the starter](examples/guides/installation.md)
- <a name="add-the-sdk-to-an-existing-application"></a>[Add the SDK to an existing application](examples/guides/installation.md#add-the-sdk-to-an-existing-application)
- <a name="deno-and-bun"></a>[Deno and Bun](examples/guides/installation.md#deno-and-bun)
- <a name="build-from-source"></a>[Build from source](examples/guides/building.md#build-from-source)

## Run and manage sessions

- <a name="agents-and-sessions"></a><a name="update-a-session"></a>[Open and update a Session](examples/guides/sessions.md#open-and-run-a-session)
- <a name="provider-connection-and-credentials"></a><a name="per-session-configuration"></a><a name="connection-retries-and-errors"></a><a name="context-compaction"></a><a name="validate-agent-defaults"></a>[Configure providers, models, tools, and compaction](examples/guides/session-configuration.md)
- <a name="observations-and-interruption"></a><a name="read-events-for-one-turn"></a><a name="interrupt-a-session"></a><a name="cancel-one-root-turn"></a><a name="cancel-one-child-turn"></a>[Stream, steer, and cancel turns](examples/guides/sessions.md#observations-and-interruption)
- <a name="native-checklists"></a>[Native checklists](examples/guides/sessions.md#native-checklists)
- <a name="native-telemetry"></a>[Trace a workflow and export native telemetry](examples/guides/telemetry.md)

## Save and recover a conversation

- <a name="history-and-state"></a><a name="save-or-suspend-a-session"></a><a name="restore-instructions-and-tools"></a><a name="output-and-checkpoint-versions"></a><a name="model-settings-on-restore"></a><a name="usage-counters"></a><a name="manual-suspension-and-repair-receipts"></a>[Read history and restore checkpoints](examples/guides/state.md#history-and-state)
- <a name="live-capabilities-and-checkpoint-advice"></a><a name="check-capture-readiness"></a>[Check session capabilities and capture readiness](examples/guides/recovery.md#live-capabilities-and-checkpoint-advice)
- <a name="reconcile-external-effects"></a><a name="resume-external-work"></a>[Reconcile effects and resume external work](examples/guides/recovery.md#reconcile-external-effects)
- <a name="local-native-profiles"></a><a name="profile-ownership"></a><a name="supported-capabilities"></a><a name="reopen-with-descendant-history"></a><a name="persistence-failures-and-cleanup"></a>[Reopen a local profile](examples/guides/local-state.md#local-native-profiles)
- [Store canonical conversation state in application-owned files](examples/guides/session-store.md)
- <a name="native-local-goals"></a>[Native local goals](examples/guides/local-state.md#native-local-goals)

## Choose an output contract

- <a name="choose-an-output-mode"></a><a name="native-structured-output"></a><a name="prompted-output"></a><a name="retry-invalid-prompted-output"></a><a name="override-output-for-one-turn"></a><a name="queue-independent-turns"></a><a name="wait-steer-and-reply-on-an-overridden-turn"></a>[Choose an output mode](examples/guides/output.md#choose-an-output-mode)
- <a name="reusable-output-choices"></a><a name="output-policies-in-subclasses"></a>[Reusable output choices](examples/guides/output.md#reusable-output-choices)

## Connect tools and executors

- <a name="input-tools-and-output"></a><a name="function-tools"></a><a name="tool-discovery"></a><a name="tool-results"></a><a name="tool-call-identity"></a><a name="manual-tool-requests"></a>[Send input and declare tools](examples/guides/tools.md#input-tools-and-output)
- <a name="select-tools-for-one-root"></a><a name="select-tools-before-a-model-step"></a><a name="selection-limits-and-restore"></a>[Select tools for a turn](examples/guides/tools.md#select-tools-for-one-root)
- <a name="inspect-or-change-tool-values"></a>[Inspect or change tool values](examples/guides/tools.md#inspect-or-change-tool-values)
- <a name="programmatic-tool-calling"></a>[Programmatic tool calling](examples/guides/tools.md#programmatic-tool-calling)
- <a name="native-web-search"></a>[Native web search](examples/guides/tools.md#native-web-search)
- <a name="remote-tools-and-children"></a><a name="mcp-connections"></a><a name="connect-http-tools-on-demand"></a><a name="run-a-stdio-server-on-the-host-or-executor"></a><a name="choose-a-stdio-process-lifetime"></a><a name="mcp-call-policy"></a><a name="update-mcp-policy-while-idle"></a><a name="mcp-and-executor-timeouts"></a>[Connect native MCP tools](examples/guides/mcp.md#mcp-connections)
- <a name="materialize-a-borrowed-sdk-mcp-namespace"></a><a name="await-observations-on-borrowed-mcp-calls"></a>[Borrow an SDK MCP server](examples/guides/mcp.md#materialize-a-borrowed-sdk-mcp-namespace)
- <a name="remote-executor-tools"></a><a name="lease-an-executor"></a><a name="remote-skill-directories"></a><a name="native-child-agents"></a><a name="configured-shell"></a>[Connect remote executors and run child agents](examples/guides/executors.md#remote-executor-tools)
- <a name="managed-executor-network-policy"></a>[Managed executor network policy](examples/guides/executors.md#managed-executor-network-policy)

- [Connect or serve remote Agents over A2A](A2A.md) with the current source build.
- [Supervise a native worker](examples/supervised-worker/README.md) in a local execution environment.

## Handle native interactions

- <a name="native-questions"></a><a name="collect-form-answers"></a><a name="supported-form-schemas"></a><a name="request-ownership-and-expiry"></a><a name="read-pending-interactions"></a><a name="when-requests-are-available"></a><a name="explicit-url-consent-and-completion"></a>[Answer approvals, forms, and URL requests](examples/guides/interactions.md#native-questions)
- <a name="explicit-verification-and-personal-apps"></a><a name="personal-apps-credentials"></a><a name="reply-to-a-verification-challenge"></a>[Verify a user and configure personal Apps](examples/guides/interactions.md#explicit-verification-and-personal-apps)
