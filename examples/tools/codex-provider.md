# Codex as a model provider

These examples have been using the default OpenAI provider or `CodexProvider` through the same Agents SDK `Runner`. The workspace example has been creating and reading `hello.txt`. The capabilities example has been combining a local image, a specialist handoff, an SDK function tool, streamed text, and structured output.

## Setup

The example has been using the Node.js and pnpm versions in [CONTRIBUTING.md](../../CONTRIBUTING.md#getting-started).

The following commands have been installing dependencies and building the SDK from the repository root.

```sh
pnpm install
pnpm build
```

## OpenAI mode

The default provider has been using `OPENAI_API_KEY` for API authentication. The example has been providing two SDK function tools with access only to the temporary `hello.txt` file.

```sh
pnpm -F tools exec tsx codex-provider.ts openai
```

`OPENAI_MODEL` has been selecting the model for OpenAI mode.

## Codex mode

`CodexProvider` has been using the stock Codex App Server protocol from Codex 0.166.0. The workspace example has been creating and reading `hello.txt` with Codex's native shell. Codex uses its own CLI login and configuration.

App Server has been storing local state in a writable `CODEX_HOME`. On hosts with a read-only default, set `CODEX_HOME` to a writable directory before signing in. Run `codex login` in that environment. For API-key authentication, run `printenv OPENAI_API_KEY | codex login --with-api-key`. Use the same `CODEX_HOME` when starting the example. On hosts that allow API-key login, passing `codexOptions: { apiKey: process.env.OPENAI_API_KEY }` to `CodexProvider` has been signing in for the lifetime of the child process. It has been leaving the saved CLI login in place. On managed hosts, omitting `apiKey` has been leaving authentication to the host.

The provider has been locating the installed stock CLI automatically on Node.js 22.14 and later. `codexOptions.codexPathOverride` has been allowing applications to supply the executable path explicitly.

For automatic discovery, install `@openai/codex-sdk@0.166.0` with its optional CLI dependencies. Applications using the separate `codexTool()` function tool can keep `@openai/codex-sdk@0.86.0`. An application that needs both can keep the older SDK for the tool and pass the path to a stock 0.166.0 executable for the provider.

```sh
pnpm -F tools exec tsx codex-provider.ts codex
```

`CODEX_MODEL` has been selecting the model for Codex mode.

Without `CODEX_MODEL`, Codex has been selecting its default model. For an unattended run, the example has been using a temporary workspace, selecting `workspace-write`, skipping the Git repository check, and setting the approval policy to `never`.

### Missing `hello.txt` in Codex mode on Linux

The example has been checking the file on disk. If that check has been returning `ENOENT`, check shell startup separately, without a model call:

```sh
codex sandbox -c 'sandbox_mode="workspace-write"' -- /bin/sh -c 'echo sandbox-ready'
```

- **`sandbox-ready`:** Codex has been starting its native shell. Check the output of the command that should have written the file.
- **`app-server socket directory must be a user-owned directory with mode 0700`:** Codex has been stopping before shell startup. On some hosts, an outer sandbox has been masking `/tmp/codex-daemon-<uid>` with a read-only directory of mode `000`. Changing `CODEX_HOME` has not been changing that mount.

For the socket error, retry the example on a host where the check has been printing `sandbox-ready`. Keep `workspace-write` enabled. Both modes have been printing `Verified hello.txt: Hello from Codex` on success, without an MCP server.

## Image, handoff, tool, and structured output

[codex-provider-capabilities.ts](./codex-provider-capabilities.ts) has been running the same workflow in both modes. Image triage has been handing off to a wildlife specialist. The specialist has been inspecting the existing bison image fixture, calling `lookup_animal_record`, and returning a report matching a Zod schema. The SDK tool has been returning a deterministic synthetic catalog record.

```sh
pnpm -F tools exec tsx codex-provider-capabilities.ts openai
pnpm -F tools exec tsx codex-provider-capabilities.ts codex
```

Both modes have been reading [image_bison.jpg](../basic/media/image_bison.jpg) locally and sending its bytes as an SDK `input_image` data URL. Codex mode has been selecting `read-only` for its temporary workspace. The example has been printing `output_text_delta` events during generation, then validating `finalOutput` with the report schema. Its verification has been checking the actual handoff callback, SDK tool callback, final specialist, nonempty description, and receipt of text deltas. Failures have been producing a nonzero exit code.

The final report has been using `animal: "bison"`, `recordId: "synthetic-bison-001"`, and a description of visible features. The final verification line has been reporting the number of received text deltas; chunk sizes and counts have been depending on the provider.

## Switching an application

The example has been selecting Codex through `Runner` configuration.

```ts
import { Runner } from '@openai/agents';
import { CodexProvider } from '@openai/agents-extensions/experimental/codex';

const runner = new Runner({
  modelProvider: new CodexProvider(),
});
```

In the workspace example, OpenAI mode has been supplying application-owned SDK tools, while Codex mode has been using native tools. The capabilities example has been supplying the same SDK tools and handoff in both modes. OpenAI mode has been omitting `modelProvider`. Both modes have been disabling SDK tracing; Codex has been handling its own diagnostics.

The provider has been passing agent instructions to Codex as developer instructions. It has been accepting SDK function tools, handoffs, structured output, and image data URLs. SDK tool history has also been accepting inline image bytes or base64 with a supported image media type. App Server text deltas have been reaching the Runner during generation. Codex has been reporting token usage through the provider.

Codex has been delivering each SDK function's arguments together in one streaming update. For strict structured output, Codex has been enforcing the schema during generation. With `strict: false`, the provider has been including the schema in the final-answer instructions and the Runner has been parsing the returned JSON.

The Runner has been executing SDK function tools and handoffs, including SDK tool approvals and guardrails. The provider has been returning one SDK callback request per model step. Codex has been executing native tools separately under its own permissions. Native approval requests have been producing errors; the examples have been selecting `approvalPolicy: 'never'`. Each model step has been starting a fresh ephemeral Codex thread. The Runner has been replaying prior messages, SDK tool calls, and tool results as context.

The provider has been disabling Codex connected apps and native web search by default. Applications have been able to enable connected apps with `codexOptions.config.features.apps` and choose native web search with `threadOptions.webSearchMode`. The native shell has been following the selected sandbox policy.

### Model settings

Codex has been honoring explicit `reasoning.effort`, `reasoning.summary`, and `text.verbosity` through its own configuration. Available values have been depending on the selected Codex model. When the SDK only supplies implicit defaults, Codex has been using the provider's configured effort and verbosity. When the model has been supplying a requested reasoning summary, the SDK has been exposing it as a `reasoning_item` and streaming its text through `response.reasoning_summary_text.delta` model events.

With `reasoning.summary`, Codex has been returning any available summary as `providerData.codexReasoningSummary` on the last output item of the model step. With `preserveRawUsage: true`, the Runner has been including Codex's original token usage in `result.rawResponses[n].rawUsage` alongside the SDK's normalized usage.

Codex has been using automatic tool selection and ephemeral threads. It has been accepting `toolChoice: 'auto'` and `store: false` to match that behavior. The Runner has been applying `timeoutMs` and `retry` to Codex calls. It has been treating Codex calls as unsafe to replay because native tools can change the workspace.

### Conversation history and compaction

The SDK has been continuing conversations through [`MemorySession`](../docs/running-agents/conversationSession.ts) or [`result.history`](../docs/running-agents/previousResponseHistory.ts) with either provider. Codex has been rejecting `conversationId` and `previousResponseId`, which have been selecting OpenAI-managed history. The [reasoning companion](../docs/models/portableReasoning.ts) has been setting `reasoning.effort: 'medium'` without pinning a model; GPT-5.6's `reasoning.mode` and `reasoning.context` have been remaining Responses-only, and Codex has also been rejecting prompt-cache controls.

[`OpenAIResponsesCompactionSession`](../docs/sessions/responsesCompactionSession.ts) has been compacting local history separately through OpenAI's `responses.compact` endpoint. With Codex, automatic compaction has been selecting input mode, and subsequent turns have been replaying the returned encrypted compaction items with their IDs intact. The compactor has been requiring OpenAI credentials through `OPENAI_API_KEY` or its configured `client`, even when Codex has been using a CLI login. Its `model` option has been selecting the OpenAI compaction model independently of the agent's model. The [manual streaming example](../docs/sessions/responsesCompactionManualSession.ts) has been compacting between turns and running a follow-up against the compacted history.

### SDK sandbox tools

With `SandboxAgent`, Codex has been calling the SDK's sandbox tools under a distinct tool namespace. The SDK has been retaining the sandbox filesystem, path policy, approvals, and lifecycle. The provider has been disabling Codex's native execution environment, connected apps, web search, plugins, native subagents, hooks, code mode, and notification commands for these runs. An ordinary `Agent` with SDK local shell or apply-patch tools has been using the same isolation so the SDK's executor or editor can enforce approval. Other ordinary agents, including the workspace example above, have been retaining Codex's native execution behavior.

Before starting a sandbox-backed thread, the provider has been reading the effective Codex configuration and rejecting enabled Codex MCP servers. Setting `mcp_servers.<name>.enabled=false` for each configured server has been satisfying this requirement; SDK tools have been supplying the sandbox operations instead. Codex-backed sandbox runs have been omitting Responses-only server compaction and hosted patch controls while retaining SDK function tools for workspace operations.

With `memory()`, both generation phases use the sandbox agent's effective Codex model by default. Close the writer's sandbox and preserve its `memories/` directory to recall a fact in a new conversation. See the [sandbox memory guide](../../docs/src/content/docs/guides/sandbox-agents/memory.mdx).

### SDK-managed MCP

The Runner can connect to an MCP server and expose its tools as SDK function tools in either mode. The [basic](../docs/mcp/sdkManaged.ts), [approval](../docs/mcp/sdkManagedHITL.ts), and [streaming](../docs/mcp/sdkManagedStream.ts) companions use this approach. The [MCP guide](../../docs/src/content/docs/guides/mcp.mdx) includes the commands for switching providers.

### Hosted web search

With a web-search-capable provider, stock 0.166.0 has been returning hosted search calls on `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.5`. The two 5.4 models have been searching text. The 5.5 model has been allowing text and image results. On cache-only hosts, searches have been using cached results even when the application has been allowing live access. Setting `externalWebAccess: false` has been limiting searches to cached results.

### Current limits

Codex has been rejecting Responses API response IDs, conversation IDs, prompt IDs, and hosted file search or code interpreter. It has also been rejecting forced or disabled tool selection, parallel tool settings, and programmatic tool callers. Sampling controls and output token limits have been requiring a different provider.

Codex has been discovering deferred SDK functions through its native tool search. The Runner has been applying the agent's tool approvals after discovery. Codex has been replaying ordinary messages and SDK tool exchanges between model steps. Stock has also been accepting encrypted reasoning history. Inline audio has been requiring a model whose Codex catalog entry declares audio input. When the agent has been requesting a reasoning summary, Codex has been returning public summary text as an SDK reasoning item. Streaming runs have also been emitting summary parts and text deltas when the model has been providing them. Responses API reasoning replay controls, remote image URLs, and file inputs have been remaining unsupported.

Input guardrails using `runInParallel: false` have been completing their checks before Codex execution. Workspace writes have been surviving some failures, timeouts, cancellations, and output guardrail rejections.

## Verification

The workspace example has been creating a fresh temporary workspace, checking the actual file contents and final response, and printing `Verified hello.txt: Hello from Codex`. Both examples have been removing their temporary workspaces in a `finally` block and producing a nonzero exit code on failure.
