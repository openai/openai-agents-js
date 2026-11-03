# Stream a fresh native answer to a UI client

Use these application helpers when your UI consumes Vercel UI Message Stream v1 or the demonstrated AG-UI event subset. They convert native text IDs and safe tool progress into UI events. They do not expose tool arguments, results or approval controls.

## Run the example

Use Node.js 24 and complete the [source setup](../../NATIVE.md#build-from-source) with matching native products and built workspace packages. Set `OPENAI_API_KEY` privately, then run from the checkout root:

```sh
pnpm exec tsx packages/agents/examples/native-ui/run.ts vercel
pnpm exec tsx packages/agents/examples/native-ui/run.ts ag-ui
```

Both commands make live model calls. They print SSE to the terminal, without starting an HTTP server or opening a browser. Output wording and native IDs vary. Vercel emits text parts followed by `finish` and `[DONE]` for a complete view. AG-UI emits text messages followed by `RUN_FINISHED`. The example closes each Session before its provider.

## Choose who owns the work

For work that should survive a response-reader disconnect, keep its worker and Session alive. Pass the actual issued Turn and owning Session to a passive helper:

```ts
import { vercelResponse } from './vercel';

const turn = await session.submit('Summarize the results.');
const response = vercelResponse(turn, session);
```

This Vercel helper requires plain default output. A `Turn<string>` alone does not prove that the output is plain default text. A prompted string declaration is still outside this recipe. `ownedVercelResponse(agent, input)` checks the Agent's actual declaration before opening its own Session. That convenience wrapper closes and joins its Session when the response closes. It borrows the caller's provider. The passive helper never closes a Session or cancels a Turn.

For AG-UI, pass the actual selected declaration as the third argument. Retain a submission override instead when one was selected:

```ts
import { agUiResponse } from './ag-ui';

const outputType = agent.outputType;
const turn = await session.submit('Summarize the results.');
const response = agUiResponse(turn, session, outputType);
```

Typed and prompted AG-UI output can settle successfully without a fabricated text result. This is not a general structured-output UI protocol. Keep provider and Session ownership in the application.

## Treat incomplete views as incomplete

Each response starts a fresh view. A sequence cursor cannot resume an already rendered transcript. On relevant loss, missing native identity or a canonical text mismatch, the helpers emit `resync_required` without a successful finish. The application chooses a separate authorized history view. These helpers compare history only; they never fill missing text from it.

Vercel rejects a second native start in the same view. AG-UI follows the original logical Turn through its owned continuations and checks final identity in its last observed native turn. Equal text from an earlier commentary item does not establish final-answer identity. The helpers preserve exact nonblank whitespace.

Canceling a passive response releases its reader and local pending waits. It does not stop the underlying work. A response may report a neutral stop-related error after settlement; that does not establish which caller requested a stop. Entered callback cleanup remains joined when an owned Session closes.

## Protocol and host limits

These are copyable application examples, not public SDK adapter classes. Vercel uses `Content-Type: text/event-stream` and `x-vercel-ai-ui-message-stream: v1`. It does not implement the older data-stream protocol, tool input/output frames or approvals. AG-UI follows the Python recipe's 0.1.9 subset and has no Vercel header or `[DONE]` marker. Empty AG-UI content deltas are omitted. Progress is passive metadata. It grants no authority.

Views retain at most 256 text parts and 1,048,576 UTF-16 code units before requiring resynchronization. Raw errors and causes are not serialized into protocol frames. Authentication, transport, rendering, authorized history selection and durable UI persistence belong to your application. Local frame tests alone do not prove compatibility with an official client, browser rendering or real network transport. Optional official decoder/client availability must be reported separately.
