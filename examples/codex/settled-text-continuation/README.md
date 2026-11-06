# Continue after completed text

This example lets an application decide whether to finish or ask another question after a native agent answers. The chooser runs only after the current Turn finishes successfully.

## Integrate the continuation helper

Copy [settled-text-continuation.ts](../settled-text-continuation.ts) into your application and save the function below beside it. Compile the helper and its caller in the same TypeScript project so they use the same SDK types.

Your application opens the Session, supplies an abort signal and an approval handler, and closes the Session after the chooser finishes.

```ts
import type { Session } from '@openai/agents';
import { continueCompletedText } from './settled-text-continuation.js';

export async function draftAndRevise(session: Session, signal: AbortSignal) {
  return continueCompletedText(session, 'Draft a short answer.', {
    signal,
    maxTurns: 3,
    approve: async () => 'deny',
    choose: async (completed, signal) => {
      signal.throwIfAborted();
      console.log(completed.finalOutput);
      return completed.finalOutput.includes('Needs revision')
        ? 'Revise the answer, then finish.'
        : null;
    },
  });
}
```

The returned array contains the completed answers in turn order. This excerpt denies every approval request; replace that callback with your application's approval UI when a user needs to decide.

## Choose the next turn

The chooser receives the completed answer from the original `Turn.wait()`. Returning `null` finishes the example. Returning text starts a new Turn in the same Session, keeping its conversation. The example submits with `ifBusy: 'reject'` so it cannot steer another active Turn.

Each Turn has its own `beforeStep` counter, which starts at zero. The separate `maxTurns` limit bounds this example's outer loop. If the chooser requests another answer after that many completed turns, the helper throws instead of starting another turn. This example does not configure `beforeStep`. To bound model requests within each Turn, see the source-build [`maxModelSteps` option](../guides/tools.md#select-tools-before-a-model-step).

A pending native approval goes to `approve` before the chooser runs. The example replies through that original request and waits on its Turn again. Partial text, tool results, and pending requests do not count as a completed answer. Applications using manual tools or MCP forms need their own request handlers. This example handles native approvals only.

Errors or cancellation stop the loop and wait for the current Turn's cleanup. Both application callbacks must respect the AbortSignal they receive. The example also checks cancellation after the chooser returns and immediately before submitting another Turn. The application owns and closes the Session, its provider, and any approval UI resources.

## Verify the helper

The maintained test uses the native runtime with synthetic model responses to check continuation, approvals, cancellation, and turn ownership. From a built source checkout, use the [native test setup](../guides/building.md) before running:

```sh
pnpm test:native packages/agents-codex/test/native/settled-text-continuation.test.ts
```

The test needs the native addon and its supported host environment. It does not require a live model service. The integration excerpt above still needs the Session and provider setup from your own application.
