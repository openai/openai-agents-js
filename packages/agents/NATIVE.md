# Native API

Import from `@openai/agents`. The embedded Codex runtime owns model execution, tool admission, history, and compaction. TypeScript owns application callbacks and their cleanup. Start with the [greeting example](examples/basic.ts).

## Install

Use Node.js 24 with its bundled npm. Download the `agents-starter-<version>-<platform>.tar.gz` bundle for your platform from [GitHub Releases](https://github.com/openai/openai-agents-js/releases). The bundle includes the prebuilt SDK and native runtime. It also includes a lockfile and a JavaScript example.

**The first release with the Codex harness is not available yet.**

The Linux x64 bundle requires glibc 2.39 or later and the OpenSSL 3 runtime. On a minimal Ubuntu 24.04 system, install `libssl3t64`.

Verify the bundle against `SHA256SUMS-<platform>` from the same release, then extract it. The release also includes `build-<platform>.json`, which records the package build. Set `OPENAI_API_KEY` and run these commands from the `agents-starter` directory.

```sh
npm ci --ignore-scripts
node hello.mjs
```

npm installs the SDK packages from the bundle and downloads third-party dependencies from your configured registry. Keep the lockfile and bundled packages together. The example makes a live model request and prints a greeting.

### Add the SDK to an existing application

The starter contains four SDK tarballs in `vendor/agents/`. The release also provides them separately. Use all four tarballs from the same version and platform.

Copy the four tarballs into your application's `vendor/agents/` directory. Merge these entries into your `package.json`. The example uses version `0.22.0-alpha.1` and platform `linux-x64`. Use the filenames from your download.

```json
{
  "dependencies": {
    "@openai/agents": "file:vendor/agents/openai-agents-0.22.0-alpha.1-linux-x64.tgz",
    "@openai/agents-core": "file:vendor/agents/openai-agents-core-0.22.0-alpha.1-linux-x64.tgz",
    "@openai/agents-openai": "file:vendor/agents/openai-agents-openai-0.22.0-alpha.1-linux-x64.tgz",
    "@openai/agents-realtime": "file:vendor/agents/openai-agents-realtime-0.22.0-alpha.1-linux-x64.tgz"
  },
  "overrides": {
    "@openai/agents-core": "$@openai/agents-core",
    "@openai/agents-openai": "$@openai/agents-openai",
    "@openai/agents-realtime": "$@openai/agents-realtime"
  }
}
```

The npm overrides make transitive SDK dependencies use these same local packages. Run `npm install --ignore-scripts` to update your application's lockfile. Keep that lockfile and the four tarballs. Use `npm ci --ignore-scripts` for later installs. npm downloads third-party dependencies from your configured registry. The tarballs include the prebuilt native runtime.

### Deno and Bun

Deno needs a local `node_modules` directory to load the native addon. For a package installed with npm or pnpm, use `deno run --node-modules-dir=manual --allow-ffi --allow-read --allow-write --allow-env --allow-net app.ts`. Scope file, environment, and network permissions to your application. Native addons run outside Deno's permission sandbox; `--allow-ffi` grants native code access to the host. See [Deno's native-addon requirements](https://docs.deno.com/runtime/fundamentals/node/#use-packages-with-native-addons). Bun loads the addon without an additional permission flag.

## Agents and sessions

`Agent` declares instructions, an optional model, tools, model settings, and an optional `outputType`. `name` is optional. Pass application `context`, a remote `environment`, or saved `state` when opening a session.

`agent.run(input)` owns a session and closes it before returning a `Completed` result. `Runner.run(agent, input)` provides the same operation. Set `returnState: true` to capture a successful result's state before closing.

```ts
import { Agent } from '@openai/agents';

const agent = new Agent({ instructions: 'Answer clearly.' });
const session = await agent.session({
  model: 'gpt-5.2',
  modelSettings: { reasoningEffort: 'low' },
});
try {
  const first = await session.submit('Remember the number 42.');
  console.log((await first.wait()).finalOutput);
  const second = await session.submit('What number did I give you?');
  console.log((await second.wait()).finalOutput);
} finally {
  await session.close();
}
```

`submit()` returns an exact `Turn` handle. Submitting while that turn is active steers it and returns the same handle. `turn.wait()` always refers to that turn. `session.wait()` follows the session's current continuation. An idle Session can update one category at a time: instructions, model and settings, or tools. A Session opened with `NativeAgents` keeps its instructions and model settings fixed, even before it creates a child. Tool updates may remove, restore, or replace opening declarations, but cannot grant new tool names. To reject active work instead of steering it, use `session.submit(input, { ifBusy: 'reject' })`. Use `session.enqueue()` for independent queued work.

`NativeProvider` uses Codex's built-in Responses client. Its options select the endpoint, key and WebSocket policy. It does not wrap an OpenAI JavaScript client. A custom endpoint must support Responses. Chat Completions compatibility alone is insufficient for this native route. The provider does not start a JavaScript model loop.

An omitted `baseUrl` uses `https://api.openai.com/v1`; `NativeProvider` does not read `OPENAI_BASE_URL` automatically. Pass `baseUrl: process.env.OPENAI_BASE_URL` explicitly when your application uses that variable. An omitted key uses `OPENAI_API_KEY` when the Session opens. Custom endpoints default to HTTP. Close the provider's sessions before calling `provider.close()`. Closing permanently prevents new sessions from acquiring the provider.

These rules describe `NativeProvider`. The [classic API and experimental Model migration route](CLASSIC.md) retain their separate client and custom-Model contracts.

Pass `provider`, `model` or `modelSettings` to `agent.session(...)` or `agent.run(...)` for one conversation. An opening provider or model overrides the Agent default. Defined model-setting keys override the corresponding Agent settings; omitted or `undefined` keys keep them. An empty settings object keeps all defaults. Set `serviceTier: null` to clear an inherited tier. Model settings select behavior and grant no tools or workspace access.

Each opening captures its effective configuration. Overrides do not change the Agent or another Session. The Session borrows a supplied provider, including one supplied through opening options. Closing a Session releases its own resources and leaves the provider available for other Sessions. The Agent keeps its default provider object across openings.

Portable `state` retains the saved model and accepted model settings. This includes state from `session.fork()`: restore it through the same Agent even if its model default differs or was omitted. Omit defined opening `model` and `modelSettings` when restoring; even `modelSettings: {}` rejects. A provider override remains available for current credentials. Restore first, then use an idle `session.update(...)` to change model settings where supported. Sessions with `NativeAgents` keep those settings fixed after opening. A checkpoint does not contain opening provider credentials or grant current tools.

Connection recovery uses the provider's configured retry limits for requests and streams, with the existing backoff. The SDK overrides `features.unbounded_connection_retries=true`; startup rejects a managed requirement that keeps this setting enabled. These limits do not set a total operation timeout or cap server-requested delays.

When a native request fails, `NativeError.retryable` reports whether Core classifies the error as eligible for retry before applying attempt limits. A terminal error can still have `retryable: true` after the request exhausts its retry budget. This field does not mean that attempts remain or that replaying a whole run is safe. An error without native retry information reports `null`.

`NativeError.retryAfterMs` reports the server-advised delay remaining when native code reports the error. `null` means no observed advice; `0` includes expired advice. The value records the delay at that moment and does not count down. It does not change retry limits or authorize replaying tool effects. Use `turn.cancel()` to stop an active turn and join its cleanup, including while it waits to retry.

`NativeError.effects` describes only the failed operation: `unknown` means its effects are unproved, `notStarted` means a validated native `not_submitted` receipt rejected that operation before admission, and `recorded` is reserved for proved recorded effects. The SDK currently produces no `recorded` value. Transport failures and invalid or mismatched receipts remain `unknown`, even for `TurnNotSubmitted`. Neither this field nor retry eligibility authorizes replaying earlier work.

For admitted WebSocket requests, the carrier checks the final JSON after schema restoration and continuation encoding. It rejects requests above 64 MiB of UTF-8 before sending them to the provider. Requests at the exact limit are allowed. Model context limits are separate. A send or disconnect failure has an unknown outcome and is not replayed. Oversized loopback messages rejected before admission can still report a generic connection failure.

`await session.compact()` asks the model to summarize its context. For an idle, memory-backed root, `await session.compact({ summary: 'The user prefers vegetarian meals.' })` instead installs application-supplied model context without a model request or a new Turn. The SDK preserves canonical history, Session identity and current bindings. The summary remains context after saving and restoring state. Retained system/developer context is selected internally.

A supplied summary must contain text. An optional `signal` belongs to that supplied operation. Abort waits for its work and cleanup but does not undo a summary already published. Close also joins publication. An incomplete cleanup retires the Session and allows another close attempt. Do not reuse the Session after that failure. Supplied summaries refuse local profiles, goal-backed engines, active or child/background work, pending effects and used or previously compacted programmatic code. Use ordinary `compact()` for model-driven compaction of supported code state. A declared but provably unused code environment can accept its first supplied summary.

`await agent.validate()` checks the Agent's default tool declarations and output schema without opening a Session, reading credentials, or connecting to services. It returns `undefined` on success and throws if a declaration is invalid. The packaged native addon must be available.

Context, environment, opening overrides, and native model requirements still need checks when a Session opens. Validation checks the defaults at the time of the call. Changes to those defaults need another check. It does not verify credentials or model availability.

## Reusable output choices

See the [typed context example](examples/typed-context.ts) for a complete agent with typed output.

`agent.withOutputType(schema)` returns an `AgentOutput` view with typed `run()` and `session()` methods. It fixes the output choice without changing `agent.outputType` or calling the Agent constructor again. Other Agent defaults remain live until each opening captures them. Each call has its own output choice, so separate views can open concurrently. Restore portable state through a view with the matching output contract.

```ts
import { Agent } from '@openai/agents';
import { z } from 'zod';

const agent = new Agent({ instructions: 'Answer clearly.' });
const counts = agent.withOutputType(z.object({ count: z.number() }));
const result = await counts.run('Count the items.', { returnState: true });
console.log(result.finalOutput.count);
const restored = await counts.session({ state: result.state! });
await restored.close();
```

A view exposes its fixed `outputType`, `run()` and `session()`. It is not an Agent instance and does not expose application subclass methods. The view captures the mode, schema and retry fields in an output-mode wrapper when it is created. Existing `session.submitWithOutput()` and typed `session.enqueue()` still select output for individual operations.

Subclasses refuse output-view execution by default, before invoking their run/session hooks or acquiring a provider. Opt in only when all hooks forward opening options and do not assume the Agent's original result type. Hooks run on the original Agent, so private fields, counters and policy references stay available. They share that application state across views. Output policies must inspect `this.outputTypeFor(options)`; `this.outputType` continues to name the Agent default. The accessor also reports the captured opening declaration during deferred reopening, even if Agent defaults have changed. It does not report a separate per-operation output override.

```ts
import { type SessionOptions } from '@openai/agents';

class PolicyAgent extends Agent {
  protected override supportsOutputVariants(): boolean {
    return true;
  }

  override async session(options: SessionOptions = {}) {
    const output = this.outputTypeFor(options);
    if (output && 'mode' in output && output.mode === 'prompted') {
      throw new Error('This application requires native output.');
    }
    return super.session({ ...options });
  }
}
```

Forward options unchanged or with object spread, including when a hook awaits application policy. Do not opt in a hook that parses final output using the old Agent type or checks only `this.outputType`. An opted-in subclass also admits its derived subclasses, whose hooks must follow the same contract. This explicit contract keeps hooks on the original receiver. It does not copy an application object or its private state.

## Live capabilities and checkpoint advice

`session.capabilities` reports the configuration admitted to that Session. Reads do not call models, invoke policies, discover tools, acquire provider leases, or grant authority. The view stays live. Each returned report is a frozen snapshot with `status`, `reason`, and `scope`. Retain the view to observe later acknowledged updates. Reads of known features reject after the Session closes or seals.

```ts
const capabilities = session.capabilities;
const support = capabilities.get('functionPolicy');
console.log(support.status, support.reason, support.scope);
capabilities.require('nativeOutput');
capabilities.require('toolSelection', { allowLimited: true });
```

`require()` throws `CapabilityError`, a `NativeError`, for unsupported features and, by default, limited features. `allowLimited: true` accepts only the latter. An unknown feature name throws `TypeError`. `websocketsAllowed` reports the captured provider policy, not whether a connection uses WebSockets.

| Feature | Report scope |
| --- | --- |
| `nativeOutput` | Supported for new root output contracts. Children remain plain text. |
| `promptedOutput` | Local final-output validation with optional bounded formatting repair for prompted roots. Children remain plain text; LocalStorage requires zero retries. |
| `manualSuspend` | Limited when current manual tools and the portable configuration allow transfer. Current root output, queue, grants and callback completion still govern readiness. |
| `nativeOutputManualRestore` | Limited to portable manual boundaries with current matching manual declarations and the active output contract. Readiness checks still apply. |
| `toolSelection` | Root operation and `beforeStep` selection narrow one native executable plan across admitted families. Idle updates remain separate; children retain their separately configured authority. |
| `functionPolicy` | Supported while the acknowledged default tool selection contains a function callback. |
| `mcpBeforePolicy` | Supported for configured before/approval callbacks on acknowledged MCP tools, for root and admitted native children. Policy updates require closed native children and released callbacks; `{ action: 'stop' }` stops the exact owning Turn; an ordinary denial does not. |
| `mcpResultPolicy` | Supported for configured result transforms on acknowledged MCP tools. Effects remain. |
| `environmentBeforePolicy` | Supported for admitted executor tools, including configured approval and argument transforms. |
| `environmentCodeResultPolicy` | Limited to admitted builtin whole results, through direct and Code Mode routes. It cannot undo effects or replace final cell output. |
| `nativeAgents` | Supported when this destination admitted NativeAgents and its required Environment. Historical children grant no authority. |
| `remoteSkills` | Supported when this destination selected nonempty remote discovery roots. Selection does not prove a skill exists or grant filesystem or command access. |
| `checklist` | Supported when this opening granted the native Checklist declaration. Saved data and a same-named application callback grant no updates. |

Function-policy support follows the acknowledged default tool selection. An acknowledged manual-to-function replacement enables it; replacing the last default callback with a manual declaration or an empty selection disables it. The prior report stays in effect until acknowledgment. Explicit operation selection does not change this report. Mutating the Agent declaration after opening does not change the acknowledged defaults.

`await session.checkpointStatus({ kind: 'idle' })` inspects portable idle capture. `{ kind: 'manualWait' }` samples the current root's pending manual boundary once. Both return a frozen `{ status, reasons }`: `ready`, definite `notReady`, or `unknown` when native readiness cannot be verified. Reasons contain fixed SDK text. LocalStorage sessions return `notReady` for both kinds.

Checkpoint advice does not return or reserve a checkpoint. It does not reply to tools, wait for a manual boundary, seal a Turn, or accept a new instruction revision. Fresh idle inspection validates a temporary snapshot without publishing its prospective instructions. Manual inspection keeps the existing reply grant usable and rechecks the exact root, output contract, grants and queue after the sample. Callback reentrancy restrictions still apply.

Readiness follows the actual root output contract, including `submitWithOutput()` overrides and owned successors. A bare `z.string()` override can create an eligible plain root in a Session opened with structured output. A settled native-schema root can transfer with its matching active output contract when current manual declarations and the portable configuration permit it. A settled prompted root supports explicit manual suspension when the portable configuration permits it. A later `saveState()` or `suspend()` performs its own checks and may fail if the boundary changes.

## Input, tools, and output

Input is a string or a Responses-shaped user message. Content can contain `input_text` and inline base64 `input_image` parts. Remote image URLs, file IDs, local paths, and nondefault image detail are unsupported.

`tool()` uses a Zod parameter schema and accepts synchronous or asynchronous callbacks. Use `z.strictObject(...)` to reject unrecognized arguments, as Python function tools do. The callback receives the application context, exact submission, original and validated arguments, and an `AbortSignal`. An optional `callbackTimeout` uses seconds. It starts after argument validation and covers callback execution. Cancellation cannot preempt synchronous JavaScript or undo external effects; callbacks should honor the signal and settle their cleanup.

Set `deferLoading: true` on `tool()`, `manualTool()`, `deferredTool()` or a native MCP declaration to let supported direct-mode models discover its selected schemas through native tool search. Models without discovery support receive those schemas directly. This option preserves manual reply authority and external work timing. It does not delay MCP connection or admit omitted tools. Discovery must be granted when the Session opens; later tool updates may use that grant, while each MCP alias must retain its opening discovery mode. On supported Code Mode models, deferred function schemas also move from the initial model request to native search; the selected functions remain callable from code. Native MCP declarations retain their existing Code Mode configuration.

`ToolOutput` explicitly returns text, image, or audio content to the model: construct it with a content-item array and an optional success flag (default `true`). The SDK returns other callback values as text or serialized JSON, including objects with `contentItems` or `success` fields.

Use `ToolOutput.image(imageDataUrl)` to return one inline image. It requires an image data URL such as `data:image/png;base64,...` with a nonempty payload; remote URLs, file IDs and local paths throw a `TypeError`. The helper checks the data URL envelope. The native engine decodes and processes the image bytes. Use the constructor to combine an image with text or other content items.

Return `new ToolOutput([{ type: 'inputText', text: 'Record unavailable' }], false)` for an expected failure that the model can handle. The failed tool reply can let the same Turn continue. Throwing an application exception or failing the tool's result schema instead fails the owning Turn after its callback cleanup. Neither path rolls back earlier effects. Repeating `turn.wait()` observes the same outcome; submitting a new prompt starts new work that may repeat effects.

SDK-issued function, collaboration, and executor callback contexts include frozen `call` metadata. Manual requests include the same field. `ToolCallInfo` records the tool, root Session, exact issuing turn, and child incarnation. It also records the direct or generated-code route and native role/model when known. Unknown values are `null`. Existing application-created context objects may omit `call`.

`call.callId` is the provider call ID. Generated function/manual calls have no provider or outer ID; their cell and nested runtime IDs remain separate. The existing non-null context or manual request `callId` still identifies its invocation and reply. Metadata never grants permission to execute or answer a call; keep using live manual requests and their `reply()` method. See [the call metadata example](./examples/call-metadata.ts).

`manualTool()` creates a declaration whose `ActionRequested` events require an application reply. Call `request.reply(value)` and submit that reply to the session. Validation occurs on submission, so an invalid reply does not consume the request. For one-shot runs, `onInteraction` supplies replies.

Use `turn.wait({ until: 'request' })` to wait for either the captured turn's completion or its current manual request batch. Check `'requests' in outcome` to distinguish the frozen batch from `Completed`. Match each request with its `manualTool` declaration, then deliver `request.reply(value)` through `session.respond()`. A later wait omits answered requests. The batch does not reserve reply authority. Another observer may reply before you do.

Every manual request pending for that exact owner at the final native snapshot must pass current declaration and argument validation before a batch returns. Malformed current input fails the owner's normal completion. The SDK does not expose valid sibling requests in that case. Requests arriving after that snapshot belong to a later scan. The SDK parses each full native grant once even when waiters and the normal event reader overlap; a callback tool still runs through its ordinary reader path.

`session.wait({ until: 'request' })` captures the current logical root at call entry, including pending admission and restored manual roots. A later independent submission cannot retarget that wait. Keep an overridden root's issued Turn, as with ordinary waits. Queued Turns retain their nullable IDs, and an exact child Turn exposes only its own current requests. Root waits exclude child requests. Waits without arguments still return only `Completed`.

An optional `signal` cancels only that caller's wait with its reason. Native work, other waiters and reply grants remain usable. Completion wins if its shared public result has already settled at the final scan. Waits inside a callback for the same Session retain the existing deadlock refusal. These request waits cover manual function tools; approval, form and startup questions remain separate capabilities.

## Select tools for one root

Use `session.submit(input, { tools, beforeStep })` to select opening-admitted tools for a new root. `enqueue(input, outputType, options)` and `submitWithOutput(input, outputType, options)` accept the same options. Omission uses current defaults. `tools: []` selects no tools across admitted families. Select an admitted declaration or use `toolRef(name, namespace?)` to resolve an exact native tool name. Omitted or null namespace means `functions`; for example, an admitted borrowed MCP leaf can use `toolRef('lookup', 'crm')`. References grant no authority beyond the native candidate set.

`beforeStep` receives the issued Turn, application context, zero-based `stepIndex` and an AbortSignal. Return a subset of the operation ceiling; `undefined` uses that ceiling for the step. Selection controls eligibility and does not force model choice. The [create-then-read application recipe](examples/operation-selection.ts) filters publication with `beforeStep`, checks its own eligibility before and after approval in `before`, and checks again synchronously at `execute` entry before calling the effect handler. It records validated `ToolOutput.success` in `after` to enable the next tool on the next preparation. These are explicit application checks for admitted function tools; the SDK does not automatically repeat a predicate. They do not provide all-family native revocation or CodeMode ordering, and an asynchronous effect handler remains responsible for any later eligibility check it needs. Cancellation joins entered preparation callbacks before releasing ownership.

The native plan filters function/manual, MCP, Environment, hosted and Code Mode tools, including generated helpers and catalog projections. A nonempty Code Mode leaf selection retains its admitted `exec` and `wait` helpers; an admitted discovery helper can also remain available for those selected leaves. Empty selections retain no helpers. A yielded cell retains its issuing plan and callback owner; a successor cannot change that cell's tools. An empty new plan does not cancel already-issued work or impose a transitive ceiling on native children. Narrowing a step does not undo earlier MCP discovery or authentication. Static operation selections can travel through the existing supported manual checkpoint boundary. Omitted selection and an explicit empty selection remain distinct: one uses defaults, while the other selects no tools. Restore validates the saved static references and managed defaults against current opening declarations before resuming model or tool execution. A stored name does not grant a tool that the destination has not admitted.

Preparation callbacks remain application-owned and cannot be captured. Keep current tool implementations, credentials and policy callbacks in destination configuration. The [manual-reply example](examples/manual-replies.ts) saves a static `tools: [lookup]` selection and answers a fresh issued request after restore; it never saves a live reply grant. Use an SDK that recognizes the saved envelope. Do not remove selection fields or change a version number to force an older reader to accept it.

## Resume external work

Use `DeferredTools` when a manual tool starts work that must survive a host restart. Import it from `@openai/agents/experimental/deferred`. The application supplies a durable journal and a fixed provider. The SDK binds them to the current manual request.

Declare the tool with `deferredTool()`, using its supplied schema builder for parameters and results. Add that exact declaration to the Agent's tools and register it with the coordinator. Use `deferredDefault()` for supported scalar defaults. The deferred route accepts a restricted, lossless JSON schema; ordinary `manualTool()` remains available for application-defined validation and replies.

`jobs.prepare(session, request)` seals the pending root and writes its exact checkpoint and request bindings through the journal. It makes no provider call. Restore that checkpoint through the Agent, find the fresh request, and call `jobs.advance(restored, request)`. A continued outcome supplies the original `Turn<unknown>`; pending siblings may still need replies. Other outcomes leave provider polling to the host.

For one scoped operation, `jobs.start(session, request, options, callback)` prepares, reopens and advances, then lends the reopened Session to the callback. It closes that Session when the callback finishes. Preparation and advancement share a deadline; the callback has its own lifetime. The operation captures the original opening configuration, including credentials and output defaults. Changed Session tools or instructions require explicit preparation and restore.

Set credentials before opening the original Session. If no API key was captured, `start` rejects before preparation and leaves the original request available for an ordinary reply.

The journal must enforce current application authority, immutable request bindings and conditional ownership before each operation. A lost creation acknowledgment requires provider reconciliation; the SDK never retries plain creation. `requireReconciliation: false` permits a provider whose uncertain creation remains unknown. Method presence alone does not establish duplicate prevention.

Keep provider keys, receipts and credentials in private host storage. The registered `project` function selects a small validated result for the model. Options use milliseconds. Caller abort waits for local work but does not cancel the external job. Remote cancellation requires an explicit authorized `cancel` operation. This route supports portable plain and prompted manual roots, not local storage, child grants, Environment sessions or native structured-output pending roots.

See [Run an external job across processes](./EXTERNAL_JOBS.md) for the complete journal, provider and recovery example.

## Choose an output mode

Set `outputType` to a Zod schema to request native structured output and validate the returned value. `Completed.finalOutput` retains the inferred output type. Omit `outputType`, or pass a bare unconstrained `z.string()`, for plain text.

Use `outputType: { mode: 'native', schema: answerSchema }` to select native structured output explicitly. Native object schemas must be closed. Primitive and array outputs use an object with one required `response` field; the SDK unwraps that field before returning the result. Explicit native `z.string()` also uses this wrapper, while bare unconstrained `z.string()` returns plain text.

The SDK removes defaults from the model-visible native schema, closes object schemas and marks every declared property as required. A Zod optional or defaulted property therefore does not let the model omit that field. Use a nullable field when the model must supply an explicit absence value. Local Zod parsing still validates the final value. Use prompted output when the provider must receive the schema's input shape without this native normalization.

Use `outputType: { mode: 'prompted', schema: answerSchema }` to ask for JSON in the prompt and validate the returned text locally. The provider does not enforce a native output schema. Prompted output parses the JSON value directly, without a `response` wrapper. It supports open maps and synchronous Zod transforms or refinements when Zod can represent the schema's input as JSON Schema. Final-output validation uses synchronous parsing. Asynchronous transforms and refinements are unsupported.

Add `maxRetries` only to an explicit prompted declaration, such as `outputType: { mode: 'prompted', schema: answerSchema, maxRetries: 1 }`. The budget counts additional formatting attempts after the original output fails local validation. Omitted, `undefined`, and `0` keep validation-only behavior. A supplied budget must be a nonnegative safe integer. An explicit native declaration rejects the presence of `maxRetries`, even with an `undefined` value. LocalStorage rejects a positive budget before a model request, both at opening and for a per-root override.

Each repair opens a fresh plain Session with fixed formatting instructions, the captured schema, and the latest invalid text. It uses the original Session's captured provider connection and credentials, plus its current accepted model settings. If no API key was captured, repair refuses before opening another Session. Configure credentials before opening the original Session. It receives none of the original task instructions, history, application context, tools, Environment, MCP, child-agent, goal, or storage grants. The original task and its effects run once. Compaction and provider, tool, policy, callback, or cleanup failures do not trigger formatting repair.

The original root keeps its FIFO position until repair, receipt collection, and cleanup settle. Repeated waits observe the same work. Force cancellation stops the active correction; graceful stop can accept a valid current result but prevents another attempt. Closing the Session joins correction cleanup, and incomplete cleanup keeps close retryable. Root-only stops leave independent children under their own lifecycle. Repair does not accept steering input.

Successful completion exposes `repairAttempts`, detached records of the actual correction turns with their IDs, status, usage, and original-parent links. Session `items()` and `turns()` also expose passive repair history. `Completed.usage` still reports the original conversation's usage separately. No attempt means an empty array; absent attempt usage remains null. If validation still fails after the budget is exhausted, `OutputValidationError.rawOutput` contains the latest invalid text. The error's fixed message excludes that text. Rejected text and repair history may contain sensitive data. Choose where to store or display them.

These options apply to the native prompted-output route. The classic API keeps its own behavior. The experimental selected Model migration route accepts text or supported Zod object output, but does not admit prompted repair. See [the adapter contract](CLASSIC.md#structured-final-output).

The [output modes example](examples/output-modes.ts) shows a native greeting and prompted greetings keyed by name. Call its `runOutputModes()` function from an async application with a built native addon and configured model credentials. The example handles validation errors without printing rejected text.

Choose a different contract for one new root with `session.submitWithOutput(input, outputType)`. Keep the returned `Turn`: its `wait()` returns the inferred value and follows the root's automatic continuations. The next ordinary `submit` uses the opening default again. `submitWithOutput` always starts a new root and rejects busy work. Use `session.enqueue(input, outputType?)` to register independent FIFO work and receive its exact Turn before native admission. Omit the second argument to capture the Session default, or supply the same output contract accepted by `submitWithOutput`. Every enqueue Turn has `turnId: string | null`; `submissionId` identifies it immediately. `turnId` becomes the actual initial native ID after admission. Ordinary submit and submitWithOutput Turns keep string IDs and their current acknowledgment behavior. Legacy submit rejects `ifBusy: 'queue'`, including through an options alias.

Enqueue captures input and output before returning. It starts the next root only after the current root's automatic/manual continuations, entered callbacks, and any formatting repair and cleanup settle. Waiting on a later entry does not change the queue order. A queued Turn's cancel withdraws only that entry; Session.interrupt discards all pending entries after validating its options, while retaining its existing acceptance-only active-stop boundary. Close also discards pending entries. Updates, compaction and state capture reject while entries are queued. Force cancellation during an unreceived native admission closes the Session and fails pending work because Core may already have started the captured operation. It does not undo effects that already ran.

Legacy `submit` rejects an `outputType` field, including one hidden by an options alias; use `submitWithOutput` to select a contract.

For an overridden root, `session.wait()` rejects even after completion. Implicit busy steering through `session.submit(input)` and result-returning `session.submit(reply)` also reject for that root. Use the returned Turn's `wait()` and `steer()` methods, and deliver manual replies through `session.respond(reply)`, which returns no final result. A later default submission restores the ordinary shortcuts. Existing default-only submissions keep their result types and steering behavior.

The [persistent output example](examples/output-overrides.ts) runs native, prompted, and manual operations in one conversation, then returns to its default. Pending suspension uses the selected root contract: plain, prompted and native structured output support explicit settled manual suspension. Restore with a current declaration that matches the saved output contract, including its repair budget. Per-operation selection makes repair requests only when the selected prompted contract has a positive budget and validation fails. It adds no implicit one-shot prompted transfer.

Usage reports native cumulative thread totals separately from the latest response.

## Remote tools and children

Add `StdioMCP` or `HttpMCP` declarations to `tools`, naming the MCP tools the session may expose. Their optional `transformResult` callback runs before the result reaches the model and history. Codex owns the connection and sends calls to the selected server. That server performs the operation in its own process or service. A stdio server runs at its declared host or Environment location. An HTTP server runs at its configured service endpoint.

`HttpMCP` defaults to `activation: 'session'`, which connects and lists tools during opening. Set `activation: 'operation'` for a fresh ordinary root/direct HTTP Session to reserve its finite raw tool names without connecting. Opening and operations that omit that server perform no connection or discovery. A selected operation connects to the server, exposes only its admitted leaves and confirms the native generation before model submission. For example, a declaration named `records` with raw leaf `find-record` can select that leaf with `toolRef('find_record', 'mcp__records')`. Server discovery never adds authority beyond the opening declaration.

Omitted operation options use current Session defaults, so the first submission may activate default-selected dormant tools. Use `tools: []` to keep them dormant. Later omission disables them again; idle updates retain reserved identities and may change their current bindings. Operation selectors cannot replace endpoints or credentials. Cancellation and unconfirmed publication fence the Session before another root can use old authority. This opt-in currently rejects child-agent, Code Mode, hosted-registration, local-storage and restore combinations before HTTP acquisition; open a separate plain Session. It is independent of schema discovery and stdio lifetime.

`StdioMCP` defaults to `location: 'host'`. For example, construct a host declaration with `new StdioMCP({ name: 'records', tools: ['lookup'], command: 'node', args: ['/application/mcp-server.mjs'], envVars: ['RECORDS_TOKEN'] })`. Import `StdioMCP` from `@openai/agents`. Install the command and script on the controller host, and provide `RECORDS_TOKEN` in that host process's environment. `envVars` lists variable names rather than secret values.

For a remote declaration, set `location: 'environment'` and use the executor's command and script path, such as `args: ['/workspace/mcp-server.mjs']`. Open the Session with its current `Environment`. The executor supplies the selected variable values; the SDK does not forward controller-host secret values. The remote MCP process can start even when `Environment.tools` is empty. Those tools control model-visible executor operations, not MCP startup. Choose a process and executor the application trusts. Session-scoped connections start during opening, before invocation approval can run.

`StdioMCP` keeps its process alive across root turns when `lifetime` is omitted or set to `'session'`. Set `lifetime: 'turn'` to start a separate process for each root turn and stop it before the next turn starts. Process state does not carry across those turns. Choose this option when a stdio server must ask the application for forms tied to the original root turn. Server prompts from a persistent process without a trusted original turn are refused. Core-generated root MCP tool approvals remain available with either lifetime.

Use `before` to inspect a selected MCP call or return `{ action: 'replaceArguments', arguments }`. Return `{ action: 'allow' }` to keep the original input. Mutating the supplied view does not change execution. `approval` receives a separate view of the effective arguments. Return `true` to continue, `false` to deny, or `{ action: 'stop' }` to stop the owning Turn. `before` also accepts that stop decision. Application approval can await input. These callbacks accept sync or Promise results and receive the original context, the root or child submission, observed call metadata and an AbortSignal. Raw server and tool names remain separate from their model-visible names.

The before callback has a 30-second deadline. Cancellation or timeout denies publication and aborts its signal, while close still joins entered callback work. Application approval is separate from `approvalMode`. Returning true does not create a native approval reply or broaden tools or an Environment. Connections and discovery can precede these callbacks. Denial does not imply zero server traffic. Callback failure denies the call without publishing its private error. Direct native denial fails that generation; generated code can catch a local denial. An explicit `{ action: 'stop' }` decision instead denies the pending effect and stops its exact owning root or child Turn. Public settlement joins native retirement and entered callbacks. The public failure uses fixed text and excludes the optional private `reason`. A revoked callback cannot stop a successor. Stopping a child leaves its parent and siblings running. Earlier effects remain. `transformResult` runs after an effect and cannot undo it. See [the MCP tool observation example](examples/mcp-observers.ts).

An idle Session can add, remove, retain or replace MCP before/approval policies. Each update stays within its opening server/tool-name ceiling. This includes Sessions that admitted `NativeAgents`. Policy publication requires no live native descendant runtime and no unreleased native policy callback. Root completion alone does not establish those conditions. Later children inherit the acknowledged roster and policy generation. Replacing policies across a live child tree is unsupported. If publication may have occurred before an update fails, the SDK retires the Session. It does not silently restore old authority. Preserve the error and close that Session. See [the MCP policy example](examples/mcp-policy.ts) for a server-side application recipe.

Pass an `Environment` to `agent.session({ environment })` for remote execution. It requires a WSS URL and explicitly selected executor tools. Approval, argument, and result callbacks run with the original agent and session context. For admitted `exec_command`, `write_stdin` and `apply_patch`, `transformResult` accepts the whole JSON result through direct or Code Mode dispatch. Only accepted output reaches the model or code. The SDK withholds raw output from observations and native output projections. A failed, timed-out or cancelled transform withholds output without repeating or undoing the effect. `write_stdin` still requires `exec_command` and its real process identity.

An application can instead supply an async `EnvironmentSource`. Acquire the resource inside that function, then return `Environment.lease(environment, dispose, sourceSignal?)` while its async-local resource scope is active. The SDK captures that scope for disposal and keeps the caller's scope unchanged. Return a fresh lease for each opening; a lease cannot be claimed twice or directly disposed while a Session owns it. Ordinary `Environment` values remain borrowed declarations.

Output views accept the same source and signal options. For example, `agent.withOutputType(schema).run(input, { environment: source, signal })` retains the selected output contract while the source and caller cancellation follow their normal lifetimes.

The factory receives `{ signal }` for acquisition cancellation. Before returning a lease, the factory owns rollback on failure. Once the SDK accepts the lease, acquisition cancellation ends and the SDK retains its resource until native use and callback cleanup finish. Dispose only from the supplied disposer after that handoff. The optional `sourceSignal` requests Session retirement if the resource owner is interrupted independently; it must not release a resource still in native use. Cleanup joins a late acquisition result even when cancellation has already won.

Session `signal` cancels opening through publication; after `agent.session(...)` returns, the caller owns the Session. One-shot `agent.run(..., { signal })` retains cancellation through run completion and joined cleanup. In both routes, close retires native transport, the engine, carrier and entered child callbacks before disposing the source; provider resources release afterward, even if the disposer rejects. Concurrent cleanup joins the same disposer promise, and retries do not call it again. A disposer cannot close, wait on, or submit to its own Session. Close Sessions before their provider.

Timeout options use seconds:

| Option | Default | Scope |
| --- | --- | --- |
| MCP `startupTimeout` | `10` | Connection readiness during opening, replacement, or turn-scoped startup. |
| MCP `executionTimeout` | `60` | The selected remote tool call. A timeout does not undo an effect. |
| MCP `transformResultTimeout` | `30` when a transform exists | The result transform, after remote execution. Requires a transform and a value greater than zero, at most `3600`. |
| Environment `policyTimeout` | `30` | Argument/result transforms; greater than zero, at most `3600`. It does not limit an application approval wait. |

MCP startup and execution timeouts must be positive and finite. The MCP `before` callback has its separate 30-second deadline. Application approval can wait for input; cancellation revokes publication, but cleanup still joins entered callbacks. A result-transform timeout occurs after the remote effect and cannot establish that nothing happened.

Set `Environment.capabilityDirectories` to absolute remote directories to discover their skills. The declaration copies the list. Later edits to the input array have no effect. Paths may use POSIX or Windows absolute spelling, or absolute file URIs. Omitted directories and `[]` both select no roots. The native request still distinguishes them. The SDK does not inherit controller-host, saved, or executor-advertised roots. Selecting directories permits discovery reads. It grants neither executor tools nor additional workspace write access.

On idle restore, supply the destination's current Environment or a fresh source and directories. Historical messages may mention old skills, but they do not authorize fresh reads of source directories. A supported Environment manual checkpoint requires the destination to supply its current Environment and explicit grants; the checkpoint restores neither resources nor permissions. Saved state never retains a source function or an application lease. Direct executor filesystem RPCs remain the executor owner's responsibility; a selected directory is not a general filesystem sandbox.

Add a `NativeAgents` declaration to `tools` to declare child roles and limits. Children require an explicit model and an environment with all executor tools. `session.subagents()` yields child snapshots; live children support `submit()`, and their issued turns support `wait()`. Application tool callbacks receive a `ChildInvocation` when invoked by a child. Add `new NativeAgents({ interactions: true })` to allow supported child approvals and forms through the same Session interaction APIs. This option defaults to `false` and does not add executor permissions.

Use the optional `NativeAgents.beforeStep` hook to select tools before a child's model step. Its result uses the existing `ToolSelector` contract or `undefined`. Its `ChildBeforeStepContext` extends `BeforeStepContext` with `child: ChildInvocation`. Use `submission` for the original child Turn, `context` for application data, `stepIndex` for its preparation index, and `signal` for cancellation. Keep application policy tied to that child incarnation rather than looking up a later child with the same ID.

Selection stays within the child's admitted tools. It does not grant new tools or replace collaboration approval. Respect the callback signal when waiting for application work. Each original child Turn starts at `stepIndex: 0` and invokes the captured hook independently, so its count is not a global ordering of the tree. Returning `undefined` preserves that child's defaults. Returning `[]` selects no tools. The [child example](examples/native-children.ts) accepts this hook and exports `oneToolStepPerChildTurn` to keep tools for the first preparation only. Narrowing later steps does not cancel already-issued work. Keep callbacks in current application configuration rather than saved checkpoint data.

Programmatic tool calling is optional and off by default. Ordinary function calls do not need model-generated code cells. Set `programmaticToolCalling: true` to let the model write JavaScript cells that coordinate admitted tool calls. Those cells run in the bundled Codex Code Mode host, which embeds V8. Application functions still execute through their registered callbacks in the Node application.

The bundled host itself grants no shell tools or workspace access. Supply an `Environment` with current tool permissions for remote file and process operations.

### Configured shell

For a command task, select `exec_command` in the [remote Environment](#remote-tools-and-children) and pass the command directly in its `cmd` argument. For example, `printf proof` is command text for a POSIX shell. Use syntax supported by the executor's shell. Calling this tool does not require a shell wrapper.

The executor supplies its shell type and executable path. The native runtime constructs the launch arguments. For Bash, Zsh and Sh, it uses that path with `-lc` for login startup or `-c` otherwise. This is why a launch such as `/bin/bash -lc ...` can appear. PowerShell and Cmd use different arguments. The native `Environment` API does not expose a shell-selection option, and this route does not promise Bash or login startup on every platform.

Putting `bash -lc ...` inside `cmd` asks the configured shell to launch a second shell. Use that nesting only when the task intentionally needs Bash and Bash is available on the executor. Direct command text still follows the selected tool's [approval limits](#native-questions). Keep the owning Session alive for its work and [await cleanup](#agents-and-sessions); changing the command wrapper grants no additional permissions.

## Inspect or change tool values

| Declared tool | Before execution | Before its result is consumed |
| --- | --- | --- |
| Application `tool()` callback | Zod validates arguments. `before(context)` can allow, deny, or replace them. Replacement arguments are validated again. | `result` validates the callback value. `after(output, context)` receives and returns normalized `ToolOutput`. |
| `HttpMCP` or `StdioMCP` | Select tools and set native `approvalMode` on the declaration. Application `before(context)` can allow, replace arguments, or return `{ action: 'stop' }`. Application `approval(context)` returns `true` to continue, `false` to deny, or `{ action: 'stop' }` to stop the owning Turn. These callbacks do not answer native approval. | `transformResult(context, result)` transforms the MCP result before the model and history receive it. |
| Environment executor tool | `approval(context, originalArguments)` runs first. Only allowance permits `transformArguments`. | `transformResult` replaces the admitted builtin whole JSON result before the model or a code cell consumes it. It also controls direct dispatch. Raw output is withheld from native output projections. |
| Native collaboration tool | `NativeAgents.approval` can allow or deny a call. It cannot replace arguments. | No general after-result callback is exposed. |

An after-result transform cannot undo an earlier effect. These callbacks apply to their declared tool routes. They do not intercept every native or hosted tool. Manual tools use the application reply flow described above.

Keep checks specific to one application function in its callback. Use `before` and `after` for shared checks, as in the [callback quota example](examples/callback-quota.ts). A local `before` denial skips the callback and `after` and returns a failed tool result so the model can continue. `callbackTimeout` covers only the callback body; argument validation, `before`, result validation, and `after` are outside that deadline.

## Observations and interruption

Each `session.events({ after })` reader independently observes retained session events. Closing a reader does not stop work. Sequence numbers support resuming a reader. A `gap` event reports records lost from the bounded buffer. Pending manual requests are also visible to each reader.

Root native warnings appear only in Session observations. A `warning` contains `message`, `sessionId`, and `sequence`, with no Turn or submission identity. Keep the reader active during work: workspace skill discovery starts on the first submission. Warnings share the bounded buffer and are diagnostics, not proof that a Turn failed.

Use `turn.events({ after })` to observe one issued Turn. A root reader follows its accepted steering continuations and output-repair attempts; a child reader follows only its captured child turn. Repair observations retain their own Session and submission IDs and identify the original submission through `parentSubmissionId`. These readers yield observations only. Use the interaction APIs to receive and answer requests.

The reader ends when its Turn finishes publishing observations, even when an older `turn_finished` record has left the buffer. Events retain each native step's identity, and a `turn_finished` event can precede a root's next owned step. Sequence numbers and gaps remain Session-wide. Read `await turn.wait()` for the final result or failure; text deltas arrive before final output validation. The [conversation example](examples/conversation.ts) shows this flow.

`session.interrupt()` requests a force stop of the root turn. Set `mode: 'graceful'` to let current work settle, or `scope: 'all'` to include descendants. The method returns when the stop is accepted. `session.close()` waits for owned cleanup. Always close retained sessions. If cleanup fails, address the reported unsettled work and retry closing.

To stop one captured root and join its cleanup, use `await turn.cancel()`; its default mode is `'force'`. `await turn.cancel({ mode: 'graceful' })` lets admitted work settle and can still wait for a manual reply. A settled or superseded root is a no-op and cannot cancel a later independent root. Canceling a queued Turn withdraws only that entry; canceling the active root preserves other queued roots. Independent native children can continue. Child Turns do not support this root-only `cancel()` or `steer()` API. When the application owns the whole Session, `close()` stops and joins its owned work. Cancellation cannot undo completed effects.

To interrupt one native child, capture it with `session.subagents()` and call `await child.tryCancel(turn)` with a Turn from that child instance. The method rejects a Turn from another Session, child, or instance. It returns `true` only after native code confirms a terminal event for that exact Turn. It returns `false` when interruption is not confirmed, including when input is pending or a successor has replaced the Turn. It does not cancel a sibling or successor. A `true` result also confirms that the Turn's SDK-owned callbacks and native cells have finished cleanup. Cleanup continues if the caller stops awaiting the Promise. A callback that ignores cancellation can delay completion. A cleanup failure rejects with `NativeError('Child cancellation cleanup failed')` without exposing private application or executor errors. Closing the Session still stops and joins all its owned work, and cancellation cannot undo completed effects.

For example, this fragment uses an existing `session` to select one captured live child. It waits for callback cleanup only after native cancellation is confirmed:

```ts
const captured = await Array.fromAsync(session.subagents());
const child = captured.find((entry) => entry.isLive && entry.turn !== null);
if (child?.turn) {
  const turn = child.turn;
  const confirmed = await child.tryCancel(turn);
  if (confirmed) {
    const [outcome] = await Promise.allSettled([turn.wait()]);
    console.log(outcome.status);
  }
}
```

A rejected wait can be the expected stopped outcome or a callback failure. Inspect it according to application policy before reporting success. If cancellation is unconfirmed, retain the captured Turn to observe it or close the owning Session to stop all owned work. See the [child example](examples/native-children.ts) for per-child preparation and snapshot waits.

## History and state

`items()`, `turns()`, and `subagents()` return asynchronous snapshot iterators. Native history remains the source of truth. The projection includes supported user and assistant content and reasoning summaries. It can omit unsupported records. A projected `function_call_output` has `status: 'completed'` and `error: null` even when its output body describes a failed tool reply. Read that body and correlate the turn/call identity with `tool_started` and `tool_finished` observations. Keep missing timestamps, usage and records missing; they are not zero or proof that no effect occurred. The Turn outcome and the application's external effect receipt answer different questions.

History projects a canonical accepted input's Responses record and native user item as one message, retaining the native ID and content. A snapshot taken before the native item is recorded can expose the Responses ID; a later snapshot replaces it with the native item. Saved checkpoints preserve native recording semantics; their raw history is not an API for authoring independent messages.

`saveState()` exports idle conversation state. `suspend()` seals a supported pending manual boundary and exports its continuation. Restore with `agent.session({ state })`, supplying current trusted declarations. Snapshots contain conversation data. They contain neither running JavaScript nor a workspace backup. Python checkpoint interchange is not supported.

Use `parseSessionState(json)` to validate the checkpoint envelope. If your application trusts the storage, `await readSessionInstructions(state)` reads the last accepted instructions from native history. Supply those instructions on restore. Older v2 and manual v3 checkpoints can lack the instruction record. In that case the reader throws and you can restore with your agent’s current trusted instructions. For idle restore, current managed-tool declarations must match the saved managed declarations. Selected checkpoints retain the full admitted catalog, including hidden tools, separately from their narrowed defaults. Matching includes names, descriptions, parameter schemas, namespaces and catalog order. Current callback implementations may differ. The check does not compare function object identity. This also applies to borrowed MCP tools materialized as managed functions. Native `HttpMCP`/`StdioMCP` declarations remain destination-selected. Restore matching managed declarations first, then use supported idle updates within the opening ceiling.

For a pending manual checkpoint, instructions and pending tool declarations/result schemas must match. Legacy v3 requires plain-text final output. Idle v4 and pending v5 envelopes also capture the effective output contract; restore requires the same mode, JSON schema and repair budget. Omitted, `undefined`, and zero budgets have the same output identity. Pending v5 can resume plain or prompted output over HTTP or WebSocket. Pending native structured output retains the active turn's schema, including a per-turn override. Supply the matching output contract on the destination Agent before restoring.

Idle v6 and pending v7 envelopes also retain settled CodeMode stored JSON, cell counters and terminal observations. Stored JSON object keys are data, including `__proto__`; restoring them does not change an object's prototype. Capture refuses active cells. Snapshots do not serialize JavaScript stacks or arbitrary globals. They do not restore old reply grants. The destination supplies current trusted declarations and callback implementations.

Idle v8 and v10 envelopes retain managed defaults. Pending v9 and v11 envelopes can also retain the paused operation’s static selection. Versions v10 and v11 additionally retain settled CodeMode state. Explicit network policies use v12/v13 for ordinary idle/manual state and v14/v15 for settled CodeMode idle/manual state, retaining the same optional selection data. These versions require the current policy identity. Omitted selection differs from an explicit empty selection. Saved defaults control later ordinary roots, but saved selections and defaults never grant tools outside the destination opening ceiling. Use a reader that recognizes the selected envelope; do not remove fields or change its version to force an older reader to accept it.

A checkpoint is not an external-effect receipt. If an application's effect outcome is unknown, check it with the application-owned service before continuing. Keep the original application effect key when the restored Session gets a new ID. Reply with the result confirmed by the service through a fresh restored manual request. Do not automatically repeat an uncertain effect.

Portable restore uses the checkpoint's latest accepted model settings. Those settings include the model, reasoning effort, reasoning summary and service tier. Fork retains those accepted settings too. A different model or setting on the destination Agent does not replace the saved settings. Current provider credentials, callbacks, context and Environment still come from the application. To change accepted settings on an ordinary Session, restore first and call `session.update({ model, modelSettings })` while idle. Finish a pending manual turn before updating. Sessions opened with `NativeAgents` keep their model settings fixed.

Checkpoint token-usage counters use numbers within JavaScript's safe integer range and canonical decimal strings outside it. This applies to response, turn, and thread usage, including retained compacted records and descendant histories. Preserve those strings in JSON storage. Restore and `readSessionInstructions()` reject older unsafe numeric counters because they may already have rounded; converting such a number to a string cannot recover the original value. Core's stored history and application tool data keep their existing formats.

Prompted output works with live manual replies and explicit `suspend()`. Supply `onInteraction` for a one-shot prompted run that uses manual tools; implicit pending transfer remains plain-only. A pending capture uses the active turn's output override, while an idle capture uses the Session default. After a successful seal, repeated `suspend()` calls return detached copies of the retained receipt, including after close or an application persistence failure. A rejected pre-commit suspension leaves existing requests live.

Output-aware envelopes retain passive repair receipts separately from native history. Save, fork, supplied-summary replacement, and later manual suspension preserve them without replaying requests or effects. They preserve exact counters and actual attempt identities across capture; a new root retargets only their parent Session identity. Restoring receipts grants no reply authority. Neither corrected text nor repair receipts enter later model context. If a possibly admitted attempt lacks a complete receipt, portable capture remains unavailable for that Session.

## Native telemetry

Await `telemetry.configure()` before opening the first session. Omitted or null signals disable their exporters, including native metrics. Defaults disable prompt text, final response text, and tool-result output. Configure owns one native process lifetime; call it once, close all sessions, then await `telemetry.shutdown()`.

```ts
import { Agent, telemetry } from '@openai/agents';

await telemetry.configure({
  logs: {
    kind: 'otlp-http',
    endpoint: 'http://127.0.0.1:4318/v1/logs',
    protocol: 'json',
  },
  environment: 'dev',
});
try {
  const agent = new Agent({ instructions: 'Answer clearly.' });
  await agent.run('Hello.');
} finally {
  await telemetry.shutdown();
}
```

Select `traces`, `logs`, and `metrics` independently. Each exporter accepts an endpoint and string headers. HTTP supports `binary` (the default) and `json`; gRPC uses `kind: 'otlp-grpc'`. `environment` labels exporter resources. `spanAttributes` adds string attributes to exported spans. Native transport libraries can also read OpenTelemetry environment settings.

TLS options accept certificate file paths in `caCertificate`, `clientCertificate`, and `clientPrivateKey`. Relative paths resolve at configure time. HTTP and gRPC accept client certificates; supply the certificate and private key together. Server certificate verification remains enabled, and native network restrictions still apply. Client authentication for telemetry does not change a session's network permissions. Malformed or incomplete identities fail during native initialization. Start a new process if initialization failed after native claimed its tracing subscriber.

`logUserPrompt` and `logAgentResponses` opt in to named native records. Response logging covers live final assistant responses with the `final_answer` phase, capped at 64 KiB. `toolResultMaxBytes` bounds the UTF-8 output prefix; native may append a truncation notice. Tool-result records can still include full tool arguments even when that limit is zero. These controls do not sanitize all telemetry. Saved session state omits configure-time destinations, headers, and TLS paths.

Attempting to construct an engine prevents later configuration, even if construction fails. A failure after native claims its Rust subscriber requires a new process. Shutdown requests a flush and retires the owner. Repeated shutdown is harmless. Shutdown before successful configure rejects. This API does not close sessions, classic trace processors, or application-owned JavaScript providers. Core does not report every individual exporter error through shutdown. A flush timeout can leave native background work running.

For workers, configure in a bootstrap isolate and keep it loaded through awaited shutdown. Load the same addon image in workers, close their sessions, and let workers exit gracefully before bootstrap shuts down. Tests cover shared admission, inherited payload controls, and continued export after a worker exits. Worker-first loading, forced termination, shutdown from another isolate, and addon unloading or reloading remain unqualified.

## Build from source

Use Node.js 24, Rust 1.95, and the pnpm version pinned in `package.json`. Install Git, a C/C++ compiler and linker, CMake, and protoc. On Linux, install pkg-config and the OpenSSL development libraries.

```sh
pnpm install --frozen-lockfile
pnpm native:prepare
pnpm native:build
pnpm build
```

Preparation downloads the exact revision in `native/CODEX_REVISION`. The build produces the Node-API addon and helper binaries for the current host. `pnpm native:audit` checks prepared source against its pin.

For the native suite, build the executor fixture with `node packages/agents/scripts/native.mjs build --test-fixture`, then run `pnpm test:native`. The regular native build can run application examples.

## Native checklists

Put `checklist()` in the opening tools to enable Core's `update_plan`. The accepted value is an ordered whole list with native thread and turn identity:

```ts
import { Agent, checklist } from '@openai/agents';

const agent = new Agent({
  instructions: 'Inspect the task.',
  tools: [checklist()],
});
await using session = await agent.session();
await (await session.submit('Inspect and record your progress.')).wait();
const accepted = await session.checklist();
console.log(accepted);
```

The reader returns a frozen readonly `ChecklistState`. Before the first accepted update, it returns `null`. An accepted empty `plan` is a non-null state. Invalid calls do not replace the previous list. Storage, graph and close failures reject instead of reporting an absent list. Reads start no model turn and may observe committed state while another turn runs.

Use `session.checklist({ subagentId })` for a descendant owned by this Session's native graph. Admitted native children inherit the opening grant and retain separate lists. Reads can inspect settled or restored descendants without loading them or granting input authority. Foreign IDs reject.

Portable state retains accepted checklist data. A destination without `checklist()` may read that data but cannot update it. Declare the capability again to permit new updates. Restoring descendants still requires current NativeAgents and its Environment. Opening `tools: []` removes inherited declarations for that new Session; ordinary `session.update({ tools: [] })` changes only managed leaves and retains the fixed native grant. Passing a Checklist declaration to `update()` rejects.

Ordinary LocalStorage profiles retain the last accepted checklist across close and fresh-process reopen. Declare `checklist()` when opening to allow new updates; a Session without that declaration can read retained data but cannot update it. Local checklist readback is root-only and makes no model request. An accepted empty list replaces the previous list.

Native history and the checklist sidecar share the profile writer. Close retains both; native thread deletion removes the sidecar. Persistence failures remain visible to reads and close. The two files do not form a single power-loss transaction. Checklist reads add no cancellation or child-recovery guarantee.

## Local native profiles

`localStorage(path)` returns a frozen readonly `{ path }` descriptor. The factory resolves relative paths once, without opening files. Session opening also accepts a structural descriptor with an absolute path. Only trusted application configuration should choose that directory.

```ts
import { Agent, localStorage } from '@openai/agents';

const storage = localStorage('/application/conversations');
const agent = new Agent({ instructions: 'Answer clearly.' });
const session = await agent.session({ storage });
const id = session.id;
try {
  await (await session.submit('Remember this conversation.')).wait();
} finally {
  await session.close();
}
// A later process supplies its current Agent/provider/tools/context.
const reopened = await agent.session({ storage, resume: id });
await reopened.close();
```

A profile uses the native local store and one native writer per conversation. Concurrent writers refuse. A clean close that completes cleanup releases that writer. The profile survives cleanup of the provider's temporary directory. Opening uses current callbacks, credentials and accepted instructions. Saved tool names do not authorize new effects. The directory is conversation storage, not a backup of workspace files, credentials, JavaScript tasks or live reply grants.

This profile supports root managed function tools, live manual tools, native checklists, declared native goals and an explicit current WebSearch grant. A current Environment and NativeAgents declaration can also admit native children. It still rejects MCP, Apps/Plugins and Code Mode. An idle local Session supports ordinary `compact()` in place, using its current native thread, local writer and goal service. Supplied-summary compaction, `saveState()` and `suspend()` still reject for a local Session. A rejected suspend leaves its live manual reply grant usable. Do not combine local storage/resume with portable `state`; use the existing memory/checkpoint route when portable state is required. `Agent.run()` and `Runner.run()` do not accept storage/resume options.

Reopen a descendant conversation through its original root Session ID. A recorded child or grandchild ID cannot open independently as a root. Opening checks the root and all recorded descendants, including closed branches, before model or callback work. An open descendant with an unfinished turn, or an unknown effect in any recorded descendant, blocks reopening even when the current Agent declares no NativeAgents. Settled descendant history remains readable through `session.subagents()` and the `subagentId` options of `session.items()` and `session.turns()`. Reading it does not start a historical child runtime. Any new work uses the destination's current declarations, credentials, callbacks and Environment; saved graph records grant no execution authority.

The native store flushes an actual managed result before acknowledging it to Core. If a process dies without a matching receipt, the effect is unknown: reopen refuses before model or callback work. The SDK does not replay the callback or invent a cancellation result. Reconcile with your external system. This API provides no profile-repair or history-editing operation. A stream terminal or final output is not a separate durability receipt, and no power-loss guarantee is implied.

Close can reject a persistence error even after physical cleanup finishes. Incomplete cleanup retains its owners and temporary files. Retry `session.close()`. If opening failed before returning a Session, close any other active Sessions, then call the captured `agent.provider.close()` or explicit provider's `close()` to finish retained cleanup. That call fences new openings and joins every started failed-opening cleanup attempt. It never makes the failed opening successful. Preserve the original opening error and any cleanup failures for diagnosis.

## Native web search

Add `webSearch()` to `Agent.tools` to allow cached standalone search. Omission disables both standalone and hosted search. Choose `mode: 'live'` to allow external web access, or `route: 'hosted'` to use the provider-hosted Responses tool. The current provider must support the chosen route.

```ts
import { Agent, webSearch } from '@openai/agents';

const researcher = new Agent({
  instructions: 'Research the question with the admitted search tool.',
  model: 'gpt-5.5',
  tools: [webSearch({ mode: 'cached', route: 'standalone' })],
});
```

A Session captures its search mode and route at opening. An explicit `update({ tools })` must retain the same search declaration; it cannot add, remove or change that grant. This declaration enables no other native tool.

Hosted search rejects models whose native Responses Lite protocol would select standalone search. Admission checks the effective restored model and declared child models before connecting an executor. A refused model update leaves the original Session usable. Saved search history grants no search access and never replays a completed search. A destination must declare search again and supplies its own provider credentials, including on LocalStorage reopen.

This native declaration exposes only the mode and route. It does not expose domain or location controls. The provider determines source freshness and search results.

## Explicit verification and personal Apps

Use `HostedVerificationMCP` for your configured verification service, with its `url`, selected `tools` and optional `bearerToken`. Use `ChatGPTAppsMCP` for personal Apps and supply its account credentials through `NativeProviderOptions.chatGPT`. The personal Apps declaration uses its supported public service. It cannot register an arbitrary host. Registration is separate from consenting to a request, and neither a discovered server nor an observed challenge selects an account for the application.

`NativeProviderOptions.chatGPT` supplies an explicit `accessToken` and `accountId` for the personal Apps connection. These credentials are separate from model credentials and saved conversation configuration. Provision them explicitly before running the application. The SDK does not discover or refresh an existing ChatGPT login from the surrounding environment. Keep credentials out of checkpoints, logs and examples committed to source control.

A `UserVerificationRequest` has type `user_verification_request`, a `title`, a `serverName`, and a defensive `Uint8Array` challenge copy. `VerificationProof` contains `credentialId` and `signature`. Obtain its proof only through the explicitly configured backend and use the issued request's `reply(proof)` or `reply(null)` to decline. Deliver that prepared reply through the owning Session. Enqueueing a syntactically valid proof does not establish service acceptance. Report only submission until the configured service establishes its outcome. Challenge data, observed IDs and copied request payloads do not recreate reply authority. Keep challenge and proof data private, and close the owned Session before disposing its provider.

## Native questions

Some native tools need an application decision before they can continue. Use `onNativeQuestion` during `agent.run()`, or read `session.interactions()` in an explicit Session. An approval accepts `allow_once` or `deny`. It cannot grant a persistent permission. A supported form accepts a JSON object or `null` to decline. URL requests have a separate explicit flow for consent and completion. `reply(null)` still declines them. A `user_verification_request` uses a proof or `null`; see the explicit verification setup above.

This handler denies approvals and declines forms and URLs:

```ts
const result = await agent.run('Use the selected tools.', {
  onNativeQuestion(request) {
    if (request.type === 'approval_request') return request.reply('deny');
    return request.reply(null);
  },
});
```

To collect form values, narrow the request to `elicitation_request`, read its `description` and `schema`, and pass them to application-owned input collection. The form-only handler declines requests whose `mode` is `url`. For a form, return `request.reply(values)` from the callback. In an explicit Session, send that opaque reply through `await session.respond(reply)`. Before exposing a form, the SDK captures and checks its schema. `request.reply(values)` validates values synchronously before delivery. Invalid values produce a fixed `TypeError` without private validation details and leave the request available for correction. `request.reply()` only constructs a response. For an owned request, `session.respond()` rejects if its original native turn has expired. A successful response does not confirm a completed tool effect or create a durable receipt.

Standard `form` requests support strings, booleans, integers, numbers, and enum-backed string multi-selects, including titled choices. Replies must use the offered field names and choice values. The SDK checks required fields, inclusive numeric and length bounds, and the supported email, URI, date, and date-time formats. Primitive forms reject unknown fields unless the schema sets `additionalProperties: true`. The SDK does not insert defaults or coerce values.

Standard forms, including requests that omit the standard form mode, also support Draft 2020-12 object schemas with nested objects, arrays, compositions, and single-hop references to root `$defs`. This includes constraints declared only at the root or inside `allOf`. The `openai/form` and `openaiForm` modes support the same general schema subset. General schemas treat formats as annotations; primitive standard forms retain the strict format checks above. The SDK rejects unknown keywords, regex keywords, resource identifiers, dynamic references, remote or chained references, and unsupported drafts. The supported subset also excludes `then`, `else`, `minContains`, and `maxContains`. It never fetches schema resources. Unsupported schemas receive no public grant. Replies must contain finite JSON values. The SDK refuses cyclic objects and values that JSON would omit or change.

Each schema read returns a detached copy. Changing that copy cannot relax validation. Keep descriptions, schemas, and answers private. They may contain credentials or other sensitive data. The wrapper omits descriptions and schemas from ordinary JSON and inspection; validation errors use fixed messages without retaining the validator's private error details.

Root and child approvals and forms belong to the native turn that originally requested them. Their `turnId` and `submissionId` identify that owner; child requests also expose `subagentId`. The native turn's captured authority controls replies. An active server, a later turn, or matching request IDs cannot grant that authority. The request's `call` remains `null`. Do not infer a tool-call identity from the server name.

A child request belongs to that child's original running instance and turn. If the child stops, restarts, or moves to a later turn, its old request and any prepared reply expire. Forms expire when their owning turn is cancelled. Approvals needed by work already in progress can remain usable during graceful cancellation. Force cancellation, root completion, or Session close expires requests owned by that root. A delayed request or reply cannot authorize a later turn or another child, even when the server reuses its request ID.

For requests with an owning turn, `turn.wait({ until: 'interaction' })` returns a pending batch with its original `turn` and current `requests`. Narrow by `type`. `action_requested` is a manual tool request. `approval_request` is a limited native approval. `elicitation_request` has a form or URL mode. `user_verification_request` carries a verification challenge. Exact-turn waits exclude Session-scoped requests. `turn.wait()` still waits for completion; `until: 'request'` returns manual tool requests only.

An observer's `signal` cancels only that observer. It does not answer questions, cancel the turn, or consume grants. Completion and terminal errors take precedence over a pending batch. An owned continuation can give a request its own submission ID while the batch retains the original public turn. A returned batch does not reserve its requests; another observer or callback can answer first.

`await session.pendingInteractions()` returns a frozen snapshot of issued requests. `session.interactions()` yields each live wrapper once per iterator. Close an iterator when you stop reading. These operations read live owners rather than replaying observations; old events, saved state, and copied JSON cannot issue replies. See [the question example](./examples/native-questions.ts) for application-owned form collection, Session reading, and a safe deny/decline handler.

URL consent and completion are explicit application actions; the SDK never visits or cryptographically verifies their URLs. A Session-scoped URL request has null turn and submission IDs and stays outside exact-turn waits. It still belongs to the issuing Session. Closing or retiring its owner expires the wrapper and declines an unanswered URL. Idle forms and Session-opening prompts before turn admission receive no application grant. Once a turn is admitted, startup of its turn-scoped stdio process can ask questions owned by that original turn. Child approvals and forms require `NativeAgents({ interactions: true })`; omitting that option preserves the default child policy. Form extensions remain unavailable with LocalStorage; this support does not bypass its native restrictions.

Root command and patch approvals require selected Environment tools. Core-generated MCP approvals require a matching turn, call, and selected raw server and tool. Child command/patch approvals require the explicit child interaction option and the original child's permission to request the operation. These replies cannot amend permission profiles, add network permissions, or approve other kinds of requests. `HttpMCP`/`StdioMCP` option `approvalMode: 'approve'` auto-approves; it does not request an application prompt. Ordinary `auto` mode follows Core's approval policy and tool annotations. A native question without an `onNativeQuestion` handler fails an owned run with `InteractionRequired`. The existing `onInteraction` callback handles manual tools.

Opening starts with an empty native MCP roster, starts the sole event reader, then publishes the captured current roster and policies. A native question during publication fails opening and joins cleanup. The cancellation evidence covers a native Thread that already exists before the public Session promise resolves; it does not establish cancellation of pre-Thread construction or same-Engine sibling isolation.

### Explicit URL consent and completion

Use the request's `mode` to distinguish a form from a URL request. Form answers still use `request.reply(values)` or `request.reply(null)`. URL decline also uses `reply(null)`. To consent to an issued URL request, collect an explicit application decision, prepare `request.replyUrlAccept()`, and deliver that exact reply with `await session.respond(reply)`. Constructing the reply alone sends nothing.

After consent delivery, await the same request's `waitForCompletion({ timeoutMs, signal })` with a required positive, finite `timeoutMs`. A timeout retires this request, so a later wait cannot resume it. Canceling one waiter through its signal leaves other waiters active. Run this explicit delivery flow from an application-owned Session reader. An `onNativeQuestion` callback returns its prepared reply for SDK delivery; it must not wait for completion before that reply can be delivered. Consent and peer-reported completion are separate outcomes. Completion is not proof of authorization. The matching completion remains available even when the peer reports it before consent, including while consent delivery is resolving. Keep the request tied to its original Session and, when present, its original Turn or child instance. Retain the issued wrapper. Copied IDs, saved state and a later child incarnation do not recreate reply authority. A failed completion wait does not establish that an external effect did not happen. Close and join the Session before disposing its provider.

The application owns any user interface or external account action. This flow does not navigate a browser, prove an external login succeeded, or cryptographically verify the URL. Keep the URL and server metadata private. Use the form-only handler when the application intends to decline every URL request; accepting URLs must be an explicit policy choice.

## Native local goals

Declare `nativeGoals()` in `Agent.tools` when opening a LocalStorage Session. Core then provides `create_goal`, `get_goal` and `update_goal`. `await session.goal()` reads current native state without starting model work. It returns null when no goal exists. Integer fields use numbers when safe and bigint otherwise; timestamps use epoch seconds.

```ts
import { Agent, localStorage, nativeGoals } from '@openai/agents';

const agent = new Agent({
  instructions: 'Manage only the requested goal.',
  tools: [nativeGoals()],
});
await using session = await agent.session({
  storage: localStorage('/application/goals'),
});
await (await session.submit('Create the requested goal.')).wait();
const goal = await session.goal();
```

A later process must declare nativeGoals again and reopen the same profile and Session ID. Saved data grants no tools. Native goal names are reserved in the `functions` namespace; a managed tool in another namespace may use the same name. Managed-roster updates retain this fixed opening capability. Goals do not enable checklist planning, child goals, autonomous turns or artifact delivery. Ordinary `compact()` retains the current goal and its native accounting; it adds no goal authority or automatic continuation. Active and paused goal status, budget and identity remain native-owned. The other local profile restrictions and export refusals still apply.

## Materialize a borrowed SDK MCP namespace

The `selectMcpTools` helper authenticates and discovers one selected application-owned SDK MCP server before a Session opens. Omit `toolNames` until discovery, or provide an exact subset. The helper applies the server's static filter too. Callable classic filters require their real classic Agent and RunContext in `filterContext`; its application context must match `context`.

```ts
import { Agent, NativeProvider, selectMcpTools } from '@openai/agents';
import { MCPServerStreamableHttp } from '@openai/agents/classic';

const context = { tenant: 'example' };
const server = new MCPServerStreamableHttp({
  url: 'http://127.0.0.1:8000/mcp',
});
const provider = new NativeProvider();
try {
  await server.connect(); // The application owns this connection.
  const tools = await selectMcpTools(
    {
      name: 'crm',
      server,
      authenticate: async (captured) => {
        // Perform trusted application authentication for captured.tenant here.
        void captured.tenant;
      },
    },
    { context, toolNames: ['lookup'] },
  );
  const agent = new Agent<typeof context>({
    instructions: 'Use the selected CRM tool.',
    provider,
  });
  const session = await agent.session({ context, tools: [...tools] });
  try {
    await (await session.submit('Look up the record.')).wait();
  } finally {
    await session.close();
  }
} finally {
  try {
    await provider.close();
  } finally {
    await server.close();
  }
}
```

Call the helper again to refresh discovery for a future Session. It invalidates only the selected server's tool cache and returns a new complete snapshot. Existing snapshots keep their schemas and bound methods; the Session's normal exact opening ceiling still limits updates. A failed selection returns no partial catalog. Authentication and cache side effects on the borrowed client cannot be rolled back.

Binding a method does not freeze its receiver's credentials. Before unsafe reauthentication, stop all activity that uses a shared mutable client, or use separate clients for separate authentication scopes. The helper never connects or closes the server. Aborting selection waits for authentication and discovery already in progress and prevents tools from being returned. A server whose `listTools` has no cancellation support may take time to settle.

The bridge preserves raw input schemas and uses the existing managed function callback path. It forwards the per-call abort signal and calls the server once. The bridge preserves structured-content preference and peer error results. It does not add private result metadata to model text. Custom tool metadata resolvers, extractors, error handlers and guardrails are currently unsupported and fail before authentication. Existing classic MCP APIs remain available for those features.

### Await observations on borrowed MCP calls

Configure `onToolStart` and `onToolEnd` in the SDK `MCPServer` options before materializing tools. `selectMcpTools` captures one callback per phase and accepts a separate per-call `approval` callback. Approval must return `true` before start or invocation. Start observes detached arguments; end observes the normalized MCP envelope before projection or serialization. Returned values never replace arguments or results.

Callbacks must settle or cooperate with their signal. Joined cleanup can remain pending for an uncooperative callback; cancellation fences later dispatch/output after the callback settles. End failure cannot undo a completed effect and does not replay the call. Core-owned `HttpMCP`/`StdioMCP` policies and passive events retain their existing timing. See the [complete observer example](examples/mcp-observers.ts).

## Managed executor network policy

Set `Environment.network` to select the SDK-managed proxy policy for native commands. The declaration requires `exec_command`; it does not select additional tools. Omit `network` to retain ordinary restricted networking. An explicit empty object enables a managed policy with no allowed domains.

The [remote execution example](examples/remote-executor.ts) accepts an application-selected Environment.

Rules accept ASCII hosts, host patterns and IP addresses. They cover all ports. Rules cannot contain URLs, ports or IPv6 zone identifiers. The SDK captures an immutable canonical copy, removes duplicates and gives denials precedence. Equivalent case, trailing-dot and IPv4-mapped IPv6 forms share checkpoint identity. DNS can resolve before a request is denied.

Admission uses the remote executor's platform and advertised managed-proxy capability. It requires Linux or macOS and a POSIX workspace. It refuses incompatible controller proxies, legacy sandbox paths and command escalation. The application must still trust its selected executor. An independently managed endpoint firewall does not replace this policy.

Linux requires `allowAllUnixSockets: true`. This permits every reachable Unix socket, including abstract and privileged sockets. Individual socket-path grants are unsupported. Use an executor isolated from privileged host sockets. `allowLocalBinding: true` permits additional local traffic outside the domain rules; on macOS this can include direct traffic to reachable IPs on port 53, including non-DNS traffic. Do not treat domain rules as stronger host isolation.

Checkpoint policy metadata stores only a versioned digest, not the policy rules or transport credentials. Ordinary conversation and tool history still retain their content. Restoring requires a fresh Environment with an equivalent canonical policy. A changed policy, or an omitted-versus-empty mismatch, rejects before reconnecting or requesting the model. Default checkpoints continue to require the default policy. The explicit-policy envelope rejects older SDK readers rather than allowing them to drop the restriction.

Platform qualification remains separate from declaration checks. Linux proxy enforcement has a dedicated native test. That test does not qualify macOS. Windows explicit-policy enforcement is unsupported.
