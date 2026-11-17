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

`CodexProvider` has been using the stock Codex App Server protocol from Codex 0.166.0. The workspace example has been creating and reading `hello.txt` with Codex's native shell. Codex has been handling authentication and configuration separately from the Agents SDK's OpenAI client, using an existing Codex CLI login, `CODEX_API_KEY`, or `OPENAI_API_KEY` from the process environment.

App Server has been storing local state in a writable `CODEX_HOME`. On hosts with a read-only default, set `CODEX_HOME` to a writable directory before starting the example.

The provider has been locating the installed stock CLI automatically on Node.js 22.14 and later. `codexOptions.codexPathOverride` has been allowing applications to supply the executable path explicitly.

```sh
pnpm -F tools exec tsx codex-provider.ts codex
```

`CODEX_MODEL` has been selecting the model for Codex mode.

Without `CODEX_MODEL`, the example has been leaving model selection to Codex. For the temporary directory, it has been selecting `workspace-write`, skipping the Git repository check, and setting the approval policy to `never` for unattended execution. Codex has been applying its own configuration and sandbox rules. Linux execution has been depending on a host permitting Codex to start its Bubblewrap sandbox.

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

The Runner has been executing SDK function tools and handoffs, including SDK tool approvals and guardrails. The provider has been returning one SDK callback request per model step. Codex has been executing native tools separately under its own permissions. Native approval requests have been producing errors; the examples have been selecting `approvalPolicy: 'never'`. Each model step has been starting a fresh ephemeral Codex thread. The Runner has been replaying prior messages, SDK tool calls, and tool results as context.

The provider has been disabling Codex connected apps and native web search by default. Applications have been able to enable connected apps with `codexOptions.config.features.apps` and choose native web search with `threadOptions.webSearchMode`. The native shell has been following the selected sandbox policy.

### Model settings

Codex has been honoring explicit `reasoning.effort`, `reasoning.summary`, and `text.verbosity` through its own configuration. Available values have been depending on the selected Codex model. When the SDK only supplies implicit defaults, Codex has been using the provider's configured effort and verbosity.

With `reasoning.summary`, Codex has been returning any available summary as `providerData.codexReasoningSummary` on the last output item of the model step. With `preserveRawUsage: true`, the Runner has been including Codex's original token usage in `result.rawResponses[n].rawUsage` alongside the SDK's normalized usage.

Codex has been using automatic tool selection and ephemeral threads. It has been accepting `toolChoice: 'auto'` and `store: false` to match that behavior. The Runner has been applying `timeoutMs` and `retry` to Codex calls. It has been treating Codex calls as unsafe to replay because native tools can change the workspace.

### Current limits

Codex has been rejecting Responses API response IDs, conversation IDs, prompt IDs, and hosted tools. It has also been rejecting forced or disabled tool selection, parallel tool settings, and deferred or programmatic tools. Sampling controls and output token limits have been requiring a different provider.

Codex has been replaying ordinary messages and SDK tool exchanges between model steps. Reasoning summaries have been available as Codex output metadata. Responses API reasoning replay controls, remote image URLs, and file inputs have been remaining unsupported.

Input guardrails using `runInParallel: false` have been completing their checks before Codex execution. Workspace writes have been surviving some failures, timeouts, cancellations, and output guardrail rejections.

## Verification

The workspace example has been creating a fresh temporary workspace, checking the actual file contents and final response, and printing `Verified hello.txt: Hello from Codex`. Both examples have been removing their temporary workspaces in a `finally` block and producing a nonzero exit code on failure.
