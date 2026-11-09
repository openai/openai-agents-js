# Tools and input

Pass text, images, or files to the agent. Use this guide to declare tools, choose which tools a turn can call, and inspect tool arguments and results.

## Input, tools, and output

Input is a string or a Responses-shaped user message. The current [source build](building.md) accepts `input_image` with exactly one `image_url` (HTTPS or an inline data URL) or `file_id`, plus optional `detail: 'auto' | 'low' | 'high' | 'original'`. An `input_file` has exactly one `file_id`, `file_data` (base64), or `file_url` (HTTPS), plus optional `filename`.

The current provider route and issuing model must support the reference. Unsupported references and known lossy inline image-detail combinations reject before publication. Capture copies the descriptors without reading a local file or uploading it. Use provider file IDs, URLs, or bytes that your application supplies; a host path is not a file reference. Saved history preserves these descriptors and IDs.

Tools can return `ToolOutput.image({ fileId: 'file-example', detail: 'high' })` or `ToolOutput.file({ file_id: 'file-example', filename: 'report.pdf' })`. Mixed results use the existing `new ToolOutput([...])` constructor with `inputText`, `inputImage`, and `inputFile` content items.

### Function tools

`tool()` uses a Zod parameter schema and accepts synchronous or asynchronous callbacks. Use `z.strictObject(...)` to reject unrecognized arguments, as Python function tools do. The callback receives the application context, exact submission, original and validated arguments, and an `AbortSignal`. An optional `callbackTimeout` uses seconds and must be in `(0, 2147483.647]`, the supported timer range. The deadline covers only `execute`; argument validation and the `before` hook run first. Result validation, the `after` hook, and timeout formatting are outside the deadline. Cancellation cannot preempt synchronous JavaScript or undo external effects; callbacks should honor the signal and settle their cleanup.

The default `timeoutBehavior: 'raise_exception'` fails the owning turn with `ToolTimeoutError`. The error exposes `toolName` and `timeoutSeconds`. Set `timeoutBehavior: 'error_as_result'` to let the model receive a failed textual tool result and continue. An optional `timeoutErrorFunction(context, error)` returns a string or a promise of a string. Without a formatter, the failure text names the tool and reports its callback timeout.

Both modes abort the callback signal at the deadline and wait for entered callback work and cleanup to settle. A callback that ignores cancellation can therefore delay completion. Result mode runs its formatter after cleanup, using the parent tool context. Timeout results bypass the normal `result` schema and `after` hook, as local tool denial does. Formatter errors propagate normally. Parent cancellation or expired invocation authority prevents publication. With no `callbackTimeout`, the policy and formatter are inactive. A timeout never rolls back effects or makes a retry safe. See [the scripted callback timeout example](../tool-timeout-policy.ts).

### Finish a turn from a function tool

Set `finishTurn: true` when declaring an automatic function tool:

```ts
import { Agent, NativeProvider, tool } from '@openai/agents';
import { z } from 'zod';

await using provider = new NativeProvider();
const finish = tool({
  name: 'finish',
  parameters: z.object({ summary: z.string() }),
  finishTurn: true,
  execute: ({ summary }) => summary,
});
const agent = new Agent({
  provider,
  instructions: 'Call finish with the final summary.',
  tools: [finish],
});
const result = await agent.run('Report that the task is ready.');
console.log(result.finalOutput, result.toolCall);
```

The flag defaults to false and is captured with the declaration. Only a successful direct function call can finish this way; a call from code-mode remains ordinary tool output. After sibling direct calls settle, native completion uses call order and publishes only after strict persistence succeeds. `Completed.toolCall` identifies the call that supplied the result. Child results remain plain text with optional call details.

Terminal output must contain exactly one text item. A structured Agent output schema parses that text as JSON through the existing validation path, once. Invalid output fails the turn without a model repair request; media and multiple content items reject rather than being dropped or joined. `manualTool()` has no `finishTurn` option. See [manual tool requests](#manual-tool-requests) for its reply flow.

### Function namespaces

With the current [source build](building.md), set `namespace` and optional `namespaceDescription` on `tool()`:

```ts
import { tool } from '@openai/agents';
import { z } from 'zod';

const lookup = tool({
  name: 'lookup',
  namespace: 'crm',
  namespaceDescription: 'Customer records',
  parameters: z.object({ id: z.string() }),
  execute: ({ id }) => ({ id, source: 'crm' }),
});
```

Add `lookup` to the Agent's tools. Two namespaces can contain functions with the same short name. The SDK rejects duplicate namespace/name pairs when opening a Session and captures each declaration for dispatch. Use `toolRef('lookup', 'crm')` to select this function in `beforeStep`. Omit `namespace` for the default function namespace. These fields do not namespace `manualTool()` declarations.

When `NativeAgents` is enabled, its native tools reserve the `collaboration` namespace; choose another namespace for application functions. Without `NativeAgents`, that namespace remains available to application functions.

### Function admission

Pass `maxFunctionConcurrency` to `agent.session()` or `agent.run()` to limit automatic managed functions per root or child turn. For example, `await agent.session({ maxFunctionConcurrency: 2 })` admits at most two at a time. The value must be a positive integer; omission adds no host admission limit.

The slot covers argument validation, `before`, `execute`, result validation, `after`, callback cleanup and native reply settlement. Queued calls have not started their body timeout. Cancellation removes queued work, and a fatal callback failure prevents queued functions from starting. A failed `ToolOutput` remains ordinary output. Each child turn has its own limit, so a parent function can await a child's work. Borrowed SDK MCP functions consume slots; native MCP calls, manual replies and builtins do not.

This source build admits automatic calls independently even when no manual tools are declared. Earlier JS native builds serialized automatic-only catalogs but allowed parallel dispatch when a manual tool was present. Set `maxFunctionConcurrency: 1` for explicit serialization. The cap does not promise model call order, roll back effects or provide a cross-Session quota. Classic execution is unchanged.

### Tool discovery

Set `deferLoading: true` on `tool()`, `manualTool()`, `deferredTool()`, or a native MCP declaration. Direct-mode models with native tool search can discover the selected schemas. Other models receive the schemas directly.

Grant discovery at Session opening. Later updates can use the grant, but each MCP alias keeps its opening discovery mode. Discovery leaves MCP connection timing, admitted tools, manual reply authority, and external work timing unchanged.

On supported Code Mode models, native search replaces the initial request's deferred function schemas. The selected functions remain callable from code. Native MCP declarations keep their existing Code Mode configuration.

### Tool results

`ToolOutput` explicitly returns text, image, or audio content to the model: construct it with a content-item array and an optional success flag (default `true`). The SDK returns other callback values as text or serialized JSON, including objects with `contentItems` or `success` fields.

Use `ToolOutput.image(imageDataUrl)` to return one inline image. It requires an image data URL such as `data:image/png;base64,...` with a nonempty payload; remote URLs, file IDs and local paths throw a `TypeError`. The helper checks the data URL envelope. The native engine decodes and processes the image bytes. Use the constructor to combine an image with text or other content items.

Choose how to report a tool failure:

- For an expected failure that the model can handle, return `new ToolOutput([{ type: 'inputText', text: 'Record unavailable' }], false)`. The failed tool reply can let the same Turn continue.
- Throwing an application exception or failing the tool's result schema fails the owning Turn after its callback cleanup.

Neither path rolls back earlier effects. Repeating `turn.wait()` observes the same outcome. Submitting a new prompt starts new work that may repeat effects.

### Tool call identity

SDK-issued function, collaboration, and executor callback contexts include frozen `call` metadata. Manual requests include the same field. `ToolCallInfo` records the tool, root Session, exact issuing turn, and child incarnation. It also records the direct or generated-code route and native role/model when known. Unknown values are `null`. Existing application-created context objects may omit `call`.

`call.callId` is the provider call ID. Generated function/manual calls have no provider or outer ID; their cell and nested runtime IDs remain separate. The existing non-null context or manual request `callId` still identifies its invocation and reply. Metadata never grants permission to execute or answer a call; keep using live manual requests and their `reply()` method. See [the call metadata example](../call-metadata.ts).

### Manual tool requests

`manualTool()` creates a declaration whose `ActionRequested` events require an application reply. Call `request.reply(value)` and deliver that reply with `session.respond()`. Validation occurs on submission, so an invalid reply does not consume the request. An `onInteraction` handler supplied to `run()` or `session()` can supply replies instead.

To answer manual tools in an explicit Session:

1. Await `turn.wait({ until: 'manual_tool' })` for the captured turn's completion or current request batch.
2. Check `'requests' in outcome` to distinguish the frozen batch from `Completed`.
3. Match each request with its `manualTool` declaration, construct `request.reply(value)`, and deliver it through `session.respond()`.
4. Wait again to observe the next batch or final result. Answered requests leave later batches.

A batch does not reserve reply authority. Another observer may answer a request before you do.

Before returning a batch, the SDK validates every manual request pending for that exact owner at the final native snapshot:

- Each request must pass current declaration and argument validation.
- Malformed current input fails the owner's normal completion. The SDK does not expose valid sibling requests in that case.
- Requests arriving after that snapshot belong to a later scan.

The SDK parses each full native grant once even when waiters and the normal event reader overlap. A callback tool still runs through its ordinary reader path.

`session.wait({ until: 'manual_tool' })` captures the current logical root at call entry, including pending admission and restored manual roots. A later independent submission cannot retarget that wait. Keep an overridden root's issued Turn, as with ordinary waits. Queued Turns retain their nullable IDs, and an exact child Turn exposes only its own current requests. Root waits exclude child requests. Waits without arguments still return only `Completed`.

An optional `signal` cancels only that caller's wait with its reason. Native work, other waiters and reply grants remain usable. Completion wins if its shared public result has already settled at the final scan. Waits inside a callback for the same Session retain the existing deadlock refusal. These request waits cover manual function tools; approval, form and startup questions remain separate capabilities.

## Select tools for one root

Use `session.submit(input, { tools, beforeStep })` to select tools for one new root from the tools admitted at opening. `enqueue(input, options)` accepts the same selection and output options, but always queues work; use `submit(input, { ifBusy: 'reject' })` to reject a new submission when the Session is busy. Both methods accept `outputType` in that object.

Omit `tools` to use the current defaults. Pass `tools: []` to select none. To select one tool, pass an array containing its declaration, such as `tools: [lookup]`, or its exact reference, such as `tools: [toolRef('lookup', 'crm')]` for an admitted MCP tool. An omitted or null namespace means `functions`.

### Limit model steps

In `0.22.0-alpha.2`, pass `{ maxModelSteps: 4 }` to `agent.run` or to a new Session submission to allow up to four root model preparations. A value of zero blocks the first preparation in `0.22.0-alpha.2`. The published JavaScript `0.22.0-alpha.1` release does not enforce this option: zero still sends a model request. Upgrade to `0.22.0-alpha.2` before relying on the limit. When the budget runs out, the run rejects with `NativeError.code === 'max_model_steps_exceeded'` before the next provider request. A preparation can include transport retries. Child agents and structured-output repairs run separately.

A pending manual checkpoint stores the remaining steps. Resume with `agent.run(null, { state, onInteraction })` on an SDK version that supports `maxModelSteps` to enforce that allowance. Earlier alpha versions ignore the saved limit. Each independent submission starts with its own budget. If you also supply a `beforeStep` callback, the usual callback checkpoint restrictions apply.

### Select tools before a model step

`beforeStep` receives the issued Turn, application context, zero-based `stepIndex`, and an AbortSignal. Return a subset of the tools selected for the root. Return `undefined` to allow that full set for the step. Selection limits eligibility and leaves tool choice to the model.

The [create-then-read application recipe](../operation-selection.ts) uses four checks.

1. `beforeStep` filters the tools published to the model.
2. `before` checks eligibility before and after approval.
3. `execute` checks again synchronously before it calls the effect handler.
4. `after` records validated `ToolOutput.success` to enable the next tool on the next preparation.

The application owns these checks for admitted function tools. The SDK does not repeat the predicate automatically. These checks do not revoke other tool families or order Code Mode calls. An asynchronous effect handler owns any later eligibility check. Cancellation waits for entered preparation callbacks before it releases ownership.

### Selection limits and restore

The plan filters function, manual, MCP, Environment, hosted, and Code Mode tools, including generated helpers and catalog projections. Nonempty Code Mode leaf selections retain their admitted `exec` and `wait` helpers and can retain an admitted discovery helper. Empty selections retain no helpers.

A yielded cell keeps its original plan and callback owner. A successor's selection leaves already-issued work, native children's own limits, and earlier MCP discovery or authentication in place.

Supported manual checkpoints retain static selections, including the difference between default and empty. On restore, the SDK checks saved references and managed defaults against current opening declarations before model or tool execution. Saved names grant no additional tools.

Preparation callbacks remain application-owned and cannot be captured. Keep current tool implementations, credentials and policy callbacks in destination configuration. The [manual-reply example](../manual-replies.ts) saves a static `tools: [lookup]` selection and answers a fresh issued request after restore; it never saves a live reply grant. Use an SDK that recognizes the saved envelope. Do not remove selection fields or change a version number to force an older reader to accept it.

## Inspect or change tool values

| Declared tool | Before execution | Before its result is consumed |
| --- | --- | --- |
| Application `tool()` callback | Zod validates arguments. `before(context)` can allow, deny, or replace them. Replacement arguments are validated again. | `result` validates the callback value. `after(output, context)` receives and returns normalized `ToolOutput`. |
| `HttpMCP` or `StdioMCP` | Select tools and set native `approvalMode` on the declaration. Application `before(context)` can allow, replace arguments, or return `{ action: 'stop' }`. Application `approval(context)` returns `true` to continue, `false` to deny, or `{ action: 'stop' }` to stop the owning Turn. These callbacks do not answer native approval. | `transformResult(context, result)` transforms the MCP result before the model and history receive it. |
| Environment executor tool | `approval(context, originalArguments)` runs first. Only allowance permits `transformArguments`. | `transformResult` replaces the admitted builtin whole JSON result before the model or a code cell consumes it. It also controls direct dispatch. Raw output is withheld from native output projections. |
| Native collaboration tool | `NativeAgents.approval` can allow or deny a call. It cannot replace arguments. | No general after-result callback is exposed. |

An after-result transform cannot undo an earlier effect. These callbacks apply to their declared tool routes. They do not intercept every native or hosted tool. Manual tools use the application reply flow described above.

Keep checks specific to one application function in its callback. Use `before` and `after` for shared checks, as in the [callback quota example](../callback-quota.ts). A local `before` denial skips the callback and `after` and returns a failed tool result so the model can continue. `callbackTimeout` covers only the callback body; argument validation, `before`, result validation, and `after` are outside that deadline.

## Decide an executor call

Executor callbacks use the issued decisions imported from `@openai/agents`. They have a different contract from the object decisions used by function and MCP tools:

- `approval` returns `true`, `false`, or `stopExecutorTurn(reason?)`. Only `true` allows the argument transform to run. Approval sees the original arguments, so the transform must preserve the policy your application approved.
- `transformArguments` returns `allowExecutorCall()` to keep the arguments, `replaceExecutorArguments(value)` to replace them, or `stopExecutorTurn()` to stop the issuing Turn before dispatch. Raw JSON also replaces arguments. Commands and stdin take objects; `apply_patch` takes a patch string.
- `transformResult` returns JSON data. It cannot issue a stop decision or undo an effect.

Use the factories themselves. A copied or serialized decision loses its authority. An object such as `{ action: 'stop' }` is replacement data in an argument transform, and ordinary result data in a result transform. See the [executor policy example](../executor-decisions.ts).

A direct `false` approval denies that call through the native tool path. In Code Mode, `false` stops the owning Turn so generated code cannot catch the denial and continue dispatching. An issued stop also targets that exact owner: stopping a child leaves its parent and siblings running. Settlement joins entered callbacks and native cleanup. Earlier effects remain, and the optional reason stays private. Open or submit later work only after observing the stopped Turn's outcome.

## Programmatic tool calling

Programmatic tool calling is optional and off by default. Ordinary function calls do not need model-generated code cells. Set `programmaticToolCalling: true` to let the model write JavaScript cells that coordinate admitted tool calls. Those cells run in the bundled Codex Code Mode host, which embeds V8. Application functions still execute through their registered callbacks in the Node application.

The tools selected for each model step must have unique generated JavaScript names. Distinct qualified identities can flatten to the same generated name, and names such as `foo-bar` and `foo_bar` both become `foo_bar`. Select only one colliding declaration, or use direct function calls with Code Mode disabled. The admitted catalog may contain both when each effective selection is unambiguous.

The bundled host itself grants no shell tools or workspace access. Supply an [Environment](executors.md#remote-executor-tools) with current tool permissions for remote file and process operations.

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

A Session captures the search declaration at opening. An explicit `update({ tools })` must retain that declaration, including filters and location. Use tool selection to omit the granted search tool for a step.

Hosted search rejects models whose native Responses Lite protocol would select standalone search. Admission checks the effective restored model and declared child models before connecting an executor. A refused model update leaves the original Session usable. Saved search history grants no search access and never replays a completed search. A destination must declare search again and supplies its own provider credentials, including on LocalStorage reopen.

With `route: 'hosted'`, pass `allowedDomains` or `blockedDomains` to filter by domain and its subdomains. Use domain names such as `nodejs.org` without a URL scheme. Pass `location` to give the provider an approximate user location. The optional fields are `country`, `region`, `city`, and `timezone`. Use a two-letter ISO country code and an IANA time zone such as `America/Chicago`. These controls require a provider and model that support the Responses `web_search` tool. The SDK rejects the controls on the standalone route. The provider determines the results and their freshness.

Set `modelSettings.toolChoice` on the Agent, when opening a Session, or in an idle `session.update()`. The default, `'auto'`, lets the model answer directly. Use `'none'` to ask the model to skip tools or `'required'` to require a tool call. With several admitted tools, the model can choose any of them.

Run the [hosted search example](../native-web-search.ts) with credentials for a compatible Responses model.

```sh
pnpm exec tsx examples/codex/native-web-search.ts
```

Read hosted search calls and annotated messages from `session.items()`, including after restoring a Session. For live updates, consume `search_item_completed` events from `turn.events()`.

A search action includes `sources` when the provider returns URLs. An output-text part includes `annotations` when the provider returns them. URL citations carry a title, a URL, and offsets into that part's original text. Render inline citations as prominent links. Use `finalOutput` for the visible answer, or use a message's `displayText` when present. The SDK preserves original text parts and their annotation offsets when it removes markup from the visible text. The SDK keeps annotations it does not recognize as JSON. Treat missing evidence as unknown.
