# Stream a fresh native answer to a UI client

The matching [source build](../guides/building.md) has been exposing the packaged `vercelResponse` adapter from `@openai/agents/ui` for Vercel UI Message Stream v1. The local recipes below have been supporting helper-owned responses and the demonstrated AG-UI subset.

## Choose an entrypoint

| Goal | Start here |
| --- | --- |
| Inspect native-to-UI protocol frames in the terminal | Run this example with `vercel` or `ag-ui` below. |
| Try a browser task, approval, and download without model credentials | Use the [scripted web starter](../web-starter/README.md). |
| Connect a browser to a worker making live model calls | Use the [HTTP report service](../http-report-service.md). |

## Use the packaged Vercel adapter

This fragment has been assuming an asynchronous HTTP handler with an application-owned open `session`, default plain-text output, and matching built packages:

```ts
import { vercelResponse } from '@openai/agents/ui';

const turn = await session.submit('Summarize the results.');
return vercelResponse(turn, session);
```

The application has been owning the Session and provider. Reader cancellation has been releasing only the response reader while the Turn has been continuing. The application has been keeping the worker and Session alive until completion and closing the Session before its provider. Each response has been representing a fresh view; it has not been resuming an existing transcript or spanning steering boundaries.

The adapter has been omitting sensitive tool data by default. Explicit `{ includeToolData: true }` as the third argument has been enabling complete retained function/MCP arguments and results at settlement, keyed by canonical call ID. The application has been authorizing disclosure before opting in; remote bytes omitted by native retention limits have been remaining unavailable. Missing observations have been producing `resync_required`, with authorized history recovery remaining application-owned.

The copyable owning-response and AG-UI recipes below have been remaining available for their separate ownership and protocol contracts.

## Run the example

Use Node.js 24 and complete the [source setup](../guides/building.md) with matching native products and built workspace packages. Set `OPENAI_API_KEY` privately, then run from the checkout root:

```sh
pnpm exec tsx examples/codex/native-ui/run.ts vercel
pnpm exec tsx examples/codex/native-ui/run.ts ag-ui
```

Choose one command for the protocol your client consumes. Both commands make live model calls. They print SSE to the terminal, without starting an HTTP server or opening a browser. Output wording and native IDs vary. Vercel emits text parts followed by `finish` and `[DONE]` for a complete view. AG-UI emits text messages followed by `RUN_FINISHED`. The example closes each Session before its provider.

## Choose who owns the work

Copy [projection.ts](projection.ts) and your protocol helper, [vercel.ts](vercel.ts) or [ag-ui.ts](ag-ui.ts), into the same directory as your application handler. Compile them together so they use your application's SDK types.

Choose ownership before attaching a response reader:

| Helper | Session owner | What reader cancellation does |
| --- | --- | --- |
| `vercelResponse(turn, session)` or `agUiResponse(turn, session, outputType)` | Your application | Releases the reader and its local waits; work continues. |
| `ownedVercelResponse(agent, input)` | The helper | Closes and joins its Session when the response closes; the provider remains caller-owned. |

For work that should survive a response-reader disconnect, keep its worker and Session alive. Pass the actual issued Turn and owning Session to a passive helper. Keep the import at module scope and run the calls inside an asynchronous handler that already holds an open `session`:

```ts
import { vercelResponse } from './vercel.js';

const turn = await session.submit('Summarize the results.');
const response = vercelResponse(turn, session);
```

This Vercel helper requires plain default output. A `Turn<string>` alone does not prove that the output is plain default text. A prompted string declaration is still outside this recipe. `ownedVercelResponse(agent, input)` checks the Agent's actual declaration before opening its own Session. That convenience wrapper closes and joins its Session when the response closes. It borrows the caller's provider. The passive helper never closes a Session or cancels a Turn.

For AG-UI, pass the actual selected declaration as the third argument. This excerpt assumes `session` was opened from `agent` without an output override. Retain a Session or submission override instead when one was selected:

```ts
import { agUiResponse } from './ag-ui.js';

const outputType = agent.outputType;
const turn = await session.submit('Summarize the results.');
const response = agUiResponse(turn, session, outputType);
```

Typed and prompted AG-UI output can settle successfully without a fabricated text result. This is not a general structured-output UI protocol. Keep provider and Session ownership in the application. When the work ends, close the owning Session before its provider.

## Treat incomplete views as incomplete

Each response starts a fresh view. A sequence cursor cannot resume an already rendered transcript. On relevant loss, missing native identity or a canonical text mismatch, the helpers emit `resync_required` without a successful finish. The application chooses a separate authorized history view. These helpers compare history only; they never fill missing text from it.

Vercel rejects a second native start in the same view. AG-UI follows the original logical Turn through its owned continuations and checks final identity in its last observed native turn. Equal text from an earlier commentary item does not establish final-answer identity. The helpers preserve exact nonblank whitespace.

Canceling a passive response releases its reader and local pending waits. It does not stop the underlying work. A response may report a neutral stop-related error after settlement; that does not establish which caller requested a stop. Entered callback cleanup remains joined when an owned Session closes.

## Protocol and host limits

The local recipes in this guide have been remaining copyable application examples. The packaged Vercel adapter above has been providing the SDK entrypoint. The local Vercel recipe has been using `Content-Type: text/event-stream` and `x-vercel-ai-ui-message-stream: v1` without implementing the older data-stream protocol, tool input/output frames, or approvals. AG-UI follows the Python recipe's 0.1.9 subset and has no Vercel header or `[DONE]` marker. Empty AG-UI content deltas are omitted. Progress is passive metadata. It grants no authority.

Views retain at most 256 text parts and 1,048,576 UTF-16 code units before requiring resynchronization. Raw errors and causes are not serialized into protocol frames. Authentication, transport, rendering, authorized history selection and durable UI persistence belong to your application. Local frame tests alone do not prove compatibility with an official client, browser rendering or real network transport. Optional official decoder/client availability must be reported separately.
