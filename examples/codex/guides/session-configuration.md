# Configure native sessions

Choose the provider, model, and tools for a conversation. For a two-turn example, see [Open and run a session](sessions.md#open-and-run-a-session).

The [typed Decisions guide](decisions.md) has been showing Agent `decisions` configuration, standalone `agent.decide()` calls, and callback checks through `ctx.decide()`.

## Validate agent defaults

`await agent.validate()` checks the Agent's default tool declarations and output schema without opening a Session, reading credentials, or connecting to services. It returns `undefined` on success and throws if a declaration is invalid. The packaged native addon must be available.

Context, environment, opening overrides, and native model requirements still need checks when a Session opens. Validation checks the defaults at the time of the call. Changes to those defaults need another check. It does not verify credentials or model availability.

## Provider connection and credentials

The default `NativeProvider` transport has been sending model requests through Codex's built-in Responses client. Custom endpoints on this transport have been requiring the Responses protocol. The provider options have been controlling its endpoint, API key, and WebSocket policy.

- For API-key authentication, `baseUrl` defaults to `https://api.openai.com/v1`. To use `OPENAI_BASE_URL`, pass `baseUrl: process.env.OPENAI_BASE_URL`.
- A custom endpoint has been using HTTP by default. At the default endpoint, eligible `agent.run()` calls have been selecting HTTP, while explicit Sessions have been allowing WebSockets. The [provider lifetime](#provider-lifetime) section has been describing reuse eligibility and explicit transport settings.
- When you omit the key, the SDK reads `OPENAI_API_KEY` as the Session opens.

### Use Sign in with ChatGPT

With the current source build, a registered application can use a user's ChatGPT plan for native text Sessions. Supply a `SignInWithChatGPT` credential source to `NativeProvider`. Each Session opening, including resume, calls `getCredential()` once and uses that access token for the Session's lifetime.

```ts
import { Agent, NativeProvider, type SignInWithChatGPT } from '@openai/agents';

export async function runOnChatGPTPlan(
  getCredential: SignInWithChatGPT['getCredential'],
) {
  await using provider = new NativeProvider({
    signInWithChatGPT: { getCredential },
  });
  const agent = new Agent({ instructions: 'Answer briefly.', provider });
  return (await agent.run('What is a prime number?')).finalOutput;
}
```

At sign-in, your application verifies the ID token's signature using OpenAI's published JWKS and checks its issuer, audience, expiration, and nonce. Use `https://auth.openai.com` as the issuer and the issued OAuth client ID as the expected audience. Store the verified issuer and subject with that client ID and the access token from the same code exchange. [Sign-in validation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in#4-validate-the-id-token-and-chatgpt-plan-permission)

Implement `getCredential()` to return `{ accessToken, issuer, clientId, subject }` from one protected record for the selected account. On refresh, keep the verified identity paired with the renewed access token. When refresh returns a replacement ID token, verify it and confirm it belongs to the same profile before updating the record. For a self-hosted VM, import the protected record using the VM's stable host identity and a protected transfer, or read it from an application-controlled credential broker. Keep the refresh token with the application that handles renewal. [Self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)

The SDK checks decoded access-token claims for route eligibility, including the resource audience, matching client ID, validity window, and `resource.invoke` and `chatgpt.tokens.use.direct` scopes. OpenAI verifies the access token signature and plan entitlement on model requests. [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference#access-token-claims)

The provider uses streaming Responses Lite over HTTP. Use a Lite model with one Agent and direct local function tools. Use a separate provider for API keys, ChatGPT Apps, Realtime, custom endpoints, or model backends. If a token expires, obtain a renewed token through your application and open a new Session. The SDK sends each model request once.

Save a settled Session as portable state or open it with `localStorage(path)` or a `SessionStore`. To resume, supply the state, or the original store and Session ID, with the current credential record for the same registration and verified OIDC subject. The SDK saves only a digest of the issued client ID and verified ID-token subject as the plan identity. If a tool result needs application-store reconciliation, pass `{ signInWithChatGPT }` as the third argument to `reconcileSessionStore`.

### Use a saved Codex login on a headless host

With the current [source build](building.md), a Node application can use a file-backed ChatGPT login saved by the Codex CLI. For a workspace login, ask your admin to turn on **Enable device code authentication for Codex CLI**. For a personal account, enable device code authentication in ChatGPT security settings. Set `cli_auth_credentials_store = "file"` in the CLI's `config.toml`, run `codex login --device-auth`, and follow the browser sign-in instructions on another device. [Codex authentication guide](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)

For a browser sign-in on a trusted machine, set the same file storage option there before signing in. Then securely copy that machine's `auth.json` to a private, writable directory on the headless host. Treat this file like a password. Use the destination file for the SDK and keep a single active copy of the login for refresh. [Codex credential storage](https://learn.chatgpt.com/docs/auth#credential-storage)

Pass the destination directory as `codexHome`. To use the default CLI directory from `CODEX_HOME` or `~/.codex`, pass `codexLogin: {}`. Set `accountId` if the application requires a specific ChatGPT account or workspace.

```ts
import { Agent, NativeProvider } from '@openai/agents-codex';

await using provider = new NativeProvider({
  codexLogin: { codexHome: '/private/codex-login' },
});
const agent = new Agent({ provider, instructions: 'Answer briefly.' });
await using session = await agent.session();
const turn = await session.submit('Summarize the deployment checklist.');
console.log((await turn.wait()).finalOutput);
```

Saved login uses the default ChatGPT Responses route over streaming HTTP. You can attach an `Environment` to the Session and enable `programmaticToolCalling` on the Agent where the selected model, tools, and storage support Code Mode. For local execution, keep `auth.json` in a private user directory outside the platform runtime paths available to sandboxed commands. Keep the file and its aliases outside the workspace, additional writable roots, and read-only storage mounts. The SDK rejects overlapping configured grants before model requests. [Local execution](local-execution.md) · [Programmatic tool calling](tools.md#programmatic-tool-calling)

Realtime uses an explicit API key with a saved-login Session. Sessions in one process coordinate refresh for the same saved user and workspace. A later process can open the updated cache after the first process exits.

For structured output with saved login, use native output or prompted output with `maxRetries: 0`.

For web search with saved login, use `webSearch({ route: 'hosted' })` with a model that supports hosted web search.

### Capture provider routing and buffered JSON

With the current [source build](building.md), provider options accept `headers`, `queryParams`, and `envHeaders` maps, plus `organization` and `project`. `envHeaders` maps header names to environment-variable names. The descriptor copies maps and resolves those environment values at construction; missing or empty values stay omitted. Create a new provider to refresh them. Native authentication, protocol and private-hop headers remain reserved, and configured routing does not follow redirects.

`responseMode: 'buffered'` has been selecting complete Responses JSON over API-key HTTP. The provider has been accepting an omitted or `false` `supportsWebsockets` value and rejecting `true` in buffered mode. The JSON reader enforces a 64 MiB body limit and structural limits through the selected transport. The default `responseMode: 'streaming'` preserves the existing SSE/WebSocket route. Buffered responses still feed the ordinary session, tool and event lifecycle.

### Provider lifetime

Your application owns the provider, including the default provider created by `new Agent(...)` when you omit `provider`. That default is available as `agent.provider`. Closing a Session or completing `agent.run()` has been releasing that operation's resources. The provider remains available for later Sessions, including its reusable HTTP connections.

With the current [source build](building.md), a shared `NativeProvider` has been reusing idle engines for eligible API-key `agent.run()` calls over streaming or buffered HTTP. Eligible runs have been selecting HTTP by default, including at the default endpoint. With `supportsWebsockets` omitted, other streaming calls have been allowing WebSockets at the default endpoint, including explicit Sessions. For streaming calls, `supportsWebsockets: true` has been allowing WebSockets and disabling idle-engine reuse. Setting it to `false` has been forcing HTTP for other streaming calls, including explicit Sessions.

Reuse has been excluding runs with tools, structured output, initial messages, restored state, a custom environment, or `returnState: true`. Request editing, instruction files, and discovered project guidance have also been preventing idle-engine reuse. Each eligible run starts a fresh conversation with its own instructions, settings, and callbacks. Keep an explicit [Session](sessions.md#open-and-run-a-session) open to carry conversation history into later turns.

Close all Sessions using a provider before calling `await provider.close()`, or `await agent.provider.close()` for the default. Without an explicit `NativeRuntime`, provider close has been releasing any retained native engine and HTTP connections. An explicit `await using provider = new NativeProvider()` scope can close it after its Sessions' disposal scopes finish. Keep a shared provider open while any Agent still needs it. A closed provider cannot open more Sessions. Create a new provider for later work.

With the current [source build](building.md), providers configured with the same application-owned `NativeRuntime` have been sharing HTTP clients and retaining one eligible idle plain-run engine across provider closes. A shared runtime supports API-key HTTP only. Close all Sessions first, then their borrowing providers, then call `await runtime.close()` to release the shared resources. Runtime close has been rejecting active provider borrows. The [`NativeRuntime` example](../../../packages/agents-codex/src/runtime/native-runtime.ts) shows this order.

### Per-run model selection

Native runs have been accepting a string `modelOverride` on `agent.run()` and `session.submit()`. The admitted choice has been applying across configured handoff targets, native child roles, and output repair. Agents and Sessions have been retaining their default models for later runs. Overrides have been requiring a compatible approval reviewer; an implicit authority upgrade has been rejecting before sampling. Deferred Tool Search has been using the admitted model capabilities. An explicit override has been supplying the model even when a hosted prompt has been omitting its default.

```ts
import { Agent, NativeProvider } from '@openai/agents';

async function main() {
  const modelOverride = process.env.RUN_MODEL;
  if (!modelOverride)
    throw new Error('Set RUN_MODEL before running this example.');
  await using provider = new NativeProvider();
  const agent = new Agent({ instructions: 'Answer clearly.', provider });
  const result = await agent.run('Compare the approaches.', { modelOverride });
  console.log(result.finalOutput);
}

main().catch(console.error);
```

Queued submissions have been capturing the string at submission time. Manual checkpoint continuation has been retaining the admitted choice; steering and restored active runs have been rejecting replacement choices. A new run from settled history has been accepting a new override.

Application `ModelProvider` backends have been resolving the effective model name, and direct `NativeModel` backends have been receiving that name in the request body. These native run options have been accepting strings only.

### Supply an application model

The matching [source build](building.md) has been accepting `modelBackend` as either a `NativeModel` with `complete(request)` or a `ModelProvider` with `getModel(modelName)`. The native runtime has been retaining conversation history and tool execution while the application backend has been producing complete Responses-shaped output items. This route has been using HTTP mode without ChatGPT authentication; `supportsWebsockets: true` has been rejecting it.

```ts
import OpenAI from 'openai';
import { Agent, ChatCompletionsModel, NativeProvider } from '@openai/agents';

const client = new OpenAI(); // Application-owned client and credentials.
await using provider = new NativeProvider({
  supportsWebsockets: false,
  modelBackend: new ChatCompletionsModel(client, 'gpt-5.5'),
});
const agent = new Agent({
  instructions: 'Answer briefly.',
  model: 'gpt-5.5',
  provider,
});
console.log((await agent.run('What is a prime number?')).finalOutput);
```

This example has been requiring Node.js 24, the matching built SDK, the `openai` package, and client credentials such as `OPENAI_API_KEY`. A custom `NativeModel` has been owning its own authentication and has not been requiring an SDK API key. Each `complete` call has been receiving detached request data, application context, IDs, and an `AbortSignal`; it has been returning `{ output, responseId?, usage? }` with complete Responses items rather than deltas. Cancellation has been joining admitted backend work and discarding late output, so backends have been needing to honor the signal and settle their work.

The same source build has also been exporting `ResponsesModel(client, model?, options?)` for an application-owned OpenAI Responses client and `AiSdkModel(model, providerOptions?, adapterOptions?)` for an AI SDK language model with specification version `v2`, `v3`, or `v4`. Both adapters have been producing complete responses through `modelBackend`; they have been leaving the native runtime in charge of the tool loop. The language-model specification version has been naming the provider interface, rather than the `ai` package version. The [adapter source](../../../packages/agents-codex/src/runtime/models.ts) has been defining supported request fields and response conversions.

`ChatCompletionsModel` has been requesting `stream: false` and exactly one response choice. It has been translating text, image URLs, default-namespace function tools, text tool results, and native JSON-schema output. It has been accepting completed `stop` and `tool_calls` choices, plus refusals; truncated and unsupported completions have been failing. Hosted tools, other function namespaces, other message content, and Responses-only prompt, truncation, and context-management controls have been requiring a Responses provider or a custom `NativeModel`. The adapter has been forwarding the cancellation signal to the injected client's request. Existing [classic model configuration](../../../packages/agents/CLASSIC.md#choose-a-model-for-a-classic-run) has been remaining available for staged migrations.

## Per-session configuration

Pass `provider`, `model`, or `modelSettings` to `agent.session(...)` or `agent.run(...)` to configure one conversation.

Native `modelSettings` accepts the following fields in the current [source build](building.md). `invocationTimeoutMs`, `topLogprobs`, `store`, `promptCacheRetention`, and `promptCacheTtl` are not included in `0.22.0-alpha.2`:

| Field | Value and behavior |
| --- | --- |
| `reasoningEffort` | A string selecting the model's reasoning effort. |
| `reasoningSummary` | A string selecting the model's reasoning summary setting. |
| `serviceTier` | Native routing normalizes `fast` to `priority` and may omit a tier under its model/catalog policy; `null` clears an inherited override. |
| `toolChoice` | `'auto'`, `'none'`, `'required'`, a `toolRef(name, namespace?)`, or `null` to clear a named choice. A named target narrows the already admitted catalog; it does not grant execution authority or widen a selected subset. |
| `invocationTimeoutMs` | Positive uint32 milliseconds for one model invocation, including preparation waits and retries; `null` clears the override. Accepted terminal responses disarm it before result settlement. Owned cleanup can finish after expiry. |
| `maxOutputTokens` | Nonnegative safe integer for ordinary generation; `null` clears the override. |
| `temperature`, `topP` | Provider-supported sampling values; `null` clears an override. |
| `topLogprobs` | Integer from zero to 255; requests probabilities and alternatives reported as [received response facts](request-metadata.md#received-response-facts). |
| `parallelToolCalls`, `verbosity` | A boolean for parallel calls; `'low'`, `'medium'`, or `'high'` for verbosity. |
| `metadata` | A captured string map sent with the request. |
| `store` | A boolean sent as the provider storage preference; `null` clears the override. |
| `promptCacheRetention` | `'in_memory'` or `'24h'`; `null` clears the override. |
| `promptCacheTtl` | `'30m'` or `'12h'`, independently of retention; `null` clears the override. |

Supported values and account access depend on the model provider. Accepting a setting in the SDK does not establish that the provider accepts it. When you omit reasoning settings, native model metadata can supply defaults. For the resolved fields of a sampling call, read [passive request metadata](request-metadata.md). Use `maxOutputTokens` for the native output limit. Classic `maxTokens` and `retry` settings remain part of the [classic runtime](../../../packages/agents/CLASSIC.md).

- An opening provider or model overrides the Agent default.
- Defined `modelSettings` keys override the matching Agent settings. Omitted or `undefined` keys inherit the defaults. An empty object inherits every default.
- `serviceTier: null` clears an inherited tier. Tools and workspace access come from their own declarations.

Each Session captures its effective configuration when it opens. The Agent keeps its defaults for other Sessions. The Session borrows a supplied provider and releases its own resources when it closes. Other Sessions can keep using that provider.

Portable `state`, including state from `session.fork()`, retains the saved model and accepted settings. Restore through the same Agent even if its default model differs or is absent. Leave `model` and `modelSettings` undefined when restoring. Passing `modelSettings: {}` rejects the restore.

You can supply a provider with current credentials on restore. Afterward, an idle Session can use `session.update(...)` to change supported settings. A `NativeAgents` Session keeps its opening model settings. Checkpoints omit provider credentials and tool grants. They retain `store`, `promptCacheRetention` and `promptCacheTtl`; verify checkpoint integrity and application-policy approval [before restoring](state.md#restore-instructions-and-tools). A pending manual continuation can sample before an idle update, so a later update cannot serve as its privacy-policy check.

The scripted [session configuration example](../session-configuration.ts) merges settings, clears an inherited tier, and checks the recorded configuration. It uses the current [source build](building.md), with no model credentials. Run it from the repository root:

```sh
pnpm exec tsx examples/codex/session-configuration.ts
```

The command prints a native Turn receipt after checking the request's effective reasoning settings and omitted service tier. Its synthetic model name and setting values demonstrate configuration; they do not verify access to a live model or tier.

## Load trusted instruction files

In `0.22.0-alpha.2`, pass `instructionFiles` when opening a Session or starting a new `agent.run()`. The SDK loads each selected file as UTF-8 during opening, appends its text after the Agent instructions in the supplied order, and separates the parts with blank lines. Relative paths resolve against the application's current working directory. An unreadable file, non-file path, or invalid UTF-8 rejects opening.

Select files and parent directories that untrusted actors cannot modify. File contents become developer instructions. This option does not discover project files automatically or read files through an executor. Later edits to a file do not update an open Session's captured instructions.

The [session configuration example](../session-configuration.ts) creates two private temporary policy files, opens a Session with both, and checks their order in the sampled input. It then reads the Turn receipt, checks the resolved paths and exact byte hashes, closes the Session, and removes the files. See [Inspect effective turn settings](state.md#inspect-effective-turn-settings) for receipt fields and observation limits.

## Prepare one model request

In `0.22.0-alpha.2`, use `prepareRequest` to edit detached sampling instructions, input, and tool presentation. Return the edited request to apply it. Read [Prepare a native model request](request-preparation.md) for the HTTP, model, tool, compaction, and restore constraints before adding a callback.

## Control model context and completion

The current [source build](building.md) adds three Agent callbacks. These callbacks are not included in `0.22.0-alpha.2`. Declare them on the Agent before opening a Session:

| Callback | Return value and effect |
| --- | --- |
| `transformContext` | Return replacement Responses input items for the next request, or `undefined` to keep the original items. It changes sampled input without rewriting canonical history or granting tool authority. |
| `beforeComplete` | Return `undefined` to accept a proposed completion, `{ action: 'continue', instructions }` to continue the same Turn with nonempty feedback, or `{ action: 'stop' }` to stop the root or child Turn that proposed the completion. |
| `beforeCompact` | Return a nonempty summary to replace native summarization, or `undefined` to let the native model summarize. The accepted summary becomes canonical history. |

All three receive application `context`, `sessionId`, `turnId`, the model, and a cooperative cancellation `signal`. Child callbacks also receive `subagentId`. `transformContext` receives detached `items`, `requestId`, and `purpose`: `turn`, `compaction`, or `output_repair`. Return a new or edited item list to apply an edit; mutations followed by `undefined` are discarded. Transport retries reuse the captured replacement.

`beforeCompact` also receives detached `items`, `requestId`, and `automatic`, which identifies automatic rather than explicit compaction. Use these items to produce the returned summary; editing them without returning a summary does not change history.

`beforeComplete` receives proposed `text` and `continuationCount`, which starts at zero. Natural text proposals precede output-schema conversion. A [`finishTurn` function](tools.md#finish-a-turn-from-a-function-tool) instead supplies `text: null`, its detached validated `finalOutput`, and `toolCall`. Editing that proposal does not change the accepted value. Already streamed text remains visible, and a stop cannot undo completed tool effects. Continued work retains the operation's model-step budget.

Save the following as `completion-policy.mts` and run `pnpm exec tsx completion-policy.mts` from the source checkout. It uses local scripted responses and needs no API key. The callback rejects the first proposal, requests one continuation, and accepts the second:

```ts
import assert from 'node:assert/strict';
import { Agent } from '@openai/agents';
import { text, withScriptedResponses } from '@openai/agents/testing';

await withScriptedResponses(
  [[text('First draft.')], [text('Final answer.')]],
  async (peer) => {
    const agent = new Agent({
      instructions: 'Answer clearly.',
      provider: peer.provider,
      beforeComplete: ({ continuationCount }) => {
        if (continuationCount === 0)
          return { action: 'continue', instructions: 'Revise the draft.' };
      },
    });
    const result = await agent.run('Answer the question.', {
      maxModelSteps: 2,
    });
    assert.equal(result.finalOutput, 'Final answer.');
    assert.equal(peer.requests.length, 2);
  },
);
```

Callbacks are captured at opening. Restore binds current callbacks from your supplied Agent declarations; checkpoints do not contain callback code. Cancellation and close wait for entered callbacks, so honor their signals and finish their cleanup. Do not call mutating methods on the owning Session from these callbacks.

Use `transformContext` to replace request input across native model work. Use [`prepareRequest`](request-preparation.md) when you also need to edit tool presentation or request instructions within its narrower supported root HTTP profile. Neither callback replaces tool selection, argument validation, or approval policy.

## Override opening tools

Open a Session with `agent.session({ tools })` to replace its initial tool declarations, as with Python's `agent.session(tools=...)`. Omit `tools` to inherit `agent.tools`. Pass `[]` to open without those declarations. The SDK captures each Session's opening configuration before its first await. Concurrent Sessions can use the same tool names with different callbacks or MCP connections. Application hooks keep the original Agent, and the SDK does not change `agent.tools`.

Opening overrides do not remove a separately supplied Environment or programmatic execution capabilities. MCP declarations using the default activation connect during opening. To override tools, use a Session. `agent.run()` does not accept `tools`. Restore uses the current opening declarations and bindings after the existing checkpoint matching checks.

See [the tenant tools example](../opening-tools.ts) for two Sessions with separate callbacks.

## Connection retries and errors

`NativeProvider` exposes `requestMaxRetries` for failed HTTP requests and `streamMaxRetries` for dropped response streams. Omitted values use the native defaults: four request retries and five stream reconnections. Set either value to zero to disable that recovery path. Values must be nonnegative safe integers; the native client caps each limit at 100.

```ts
const provider = new NativeProvider({
  requestMaxRetries: 2,
  streamMaxRetries: 0,
});
```

The native client owns retry classification and backoff. These options do not rerun a whole Turn or replay completed tool effects. Classic Model retry settings remain part of the [classic runtime](../../../packages/agents/CLASSIC.md). The SDK disables unbounded connection retries. Startup fails if a managed requirement mandates them. Native retry limits do not set a total operation timeout or cap server-requested delays.

Use `turn.cancel()` to stop an active Turn and join its cleanup, including while it waits to retry. If a request fails, inspect the error before deciding whether to submit more work.

| NativeError field | How to read it |
| --- | --- |
| `statusCode` | Observed HTTP status as a number, or `null` when unavailable. |
| `code` | Observed provider error code as a string, or `null` when unavailable. |
| `category` | Native error classification as a string, such as `authentication_error` or `rate_limit_exceeded`, or `null` when unavailable. |
| `requestId` | Observed provider request ID as a string, or `null` when unavailable. This differs from the SDK's passive request-observation ID. |
| `retryable` | The runtime classified this request error as eligible or ineligible for retry. A terminal error can still report `true` after exhausting its attempt budget. `null` means the runtime supplied no classification. |
| `retryAfterMs` | The server-advised delay remaining when the runtime reported the error. `null` means the runtime observed no advice. `0` includes expired advice. The value stays fixed after the error is reported. |

`NativeError.effects` describes the failed operation.

- `unknown` means the SDK cannot establish its effects. Transport failures and invalid or mismatched receipts report `unknown`, even for `TurnNotSubmitted`.
- `notStarted` means a validated native `not_submitted` receipt rejected the operation before admission.
- `recorded` is reserved for confirmed effects. The SDK does not currently produce this value.

Before repeating an operation with uncertain effects, check the original action against an application or provider record.

### Diagnose authentication failures

In `0.22.0-alpha.2`, terminal HTTP 401 or 403 errors retain their observed status, provider code, request ID, and `authentication_error` category when available. Native authentication recovery can make another attempt before reporting a terminal 401. Once recovery ends, authentication errors report `retryable: false`, even if the server supplied `Retry-After` advice. A reported delay does not make that failure retryable.

Check the selected endpoint, model credential, and provider error code before starting more work. An explicit provider API key is captured by that provider; changing `OPENAI_API_KEY` does not replace it. Create a provider with corrected credentials for a new Session or supported restore, and close its Sessions before closing the old provider. A later authentication failure can follow a completed tool effect, so reconcile earlier work before repeating the operation.

### Inspect an incomplete model response

In `0.22.0-alpha.2`, `NativeError.responseIntegrityReason` can identify why the runtime rejected model output. Known causes are `undecodable_output_item`, `provider_owned_tool_receipt`, `unfinished_assistant_item`, and `missing_supported_terminal_output`. The field is `null` when the runtime has no recognized cause for the selected failure. Use it for diagnosis alongside the effect information above.

### Check the WebSocket request size

For admitted WebSocket requests, the carrier checks the final JSON after schema restoration and continuation encoding. It rejects requests above 64 MiB of UTF-8 before sending them to the provider. Requests at the exact limit are allowed. Model context limits are separate. A send or disconnect failure has an unknown outcome and is not replayed. Oversized loopback messages rejected before admission can still report a generic connection failure.

## Context compaction

`await session.compact()` asks the model to summarize its context. For an idle, memory-backed root, `await session.compact({ summary: 'The user prefers vegetarian meals.' })` installs a supplied summary without a model request or a new Turn. The SDK keeps system and developer messages, canonical history, Session identity, and current bindings.

To retain other originals, call `await session.modelContext()` while the Session is idle. The snapshot exposes detached Responses-shaped JSON items in native context order. Pass both `snapshot` and `retain` to `await session.compact({ summary, snapshot, retain })`. Each index must be a zero-based integer within the snapshot. An empty list keeps only the protected originals alongside the summary. The SDK ignores duplicate indices and keeps the originals in context order. For a tool call and its result, retain both items or omit both.

Use a fresh snapshot from the same open Session. A turn that changes context or a successful compaction makes older snapshots stale. Edits to the exposed JSON have no effect on retained originals. Use `saveState()` after compaction. Supported restores preserve the summary, retained context, and canonical history. Capture a new snapshot after restore.

A supplied summary must contain text. An abort before source retirement discards the candidate when cleanup succeeds. Once source retirement begins, the SDK finishes publication before reporting cancellation. Close joins the compaction operation. If cleanup is incomplete, the SDK retires the Session. Retry close in that case.

Use a memory-backed root for an application-supplied summary. Persistent storage, goals, active or background work, children, and pending effects prevent this operation.

A declared code environment can accept its first supplied summary if the SDK can prove it is unused. For used or previously compacted programmatic code, use ordinary `compact()` for model-driven compaction of supported state.

The [retained compaction example](../retained-compaction.ts) saves a compacted Session, restores it, and checks the next model request. Run it with the current [source build](building.md) and a scripted provider that needs no credentials.

```sh
pnpm exec tsx examples/codex/retained-compaction.ts
```
