# Continue after completed text

This example lets an application decide whether to finish or ask another question after a native agent answers. The chooser runs only after the current Turn finishes successfully.

Import `continueCompletedText` from `../settled-text-continuation.ts` in this checkout. Give it an application-owned Session, an initial input, an AbortSignal, and two application functions:

```ts
const results = await continueCompletedText(session, 'Draft a short answer.', {
  signal: controller.signal,
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
```

The chooser receives the completed answer from the original `Turn.wait()`. Returning `null` finishes the example. Returning text starts a new Turn in the same Session, keeping its conversation. The example submits with `ifBusy: 'reject'` so it cannot steer another active Turn.

Each Turn has its own `beforeStep` counter, which starts at zero. The separate `maxTurns` limit bounds this example's outer loop. This example does not configure `beforeStep`.

A pending native approval goes to `approve` before the chooser runs. The example replies through that original request and waits on its Turn again. Partial text, tool results and pending requests do not count as a completed answer. Applications using manual tools or MCP forms need their own request handlers; this example handles native approvals only.

Errors or cancellation stop the loop and wait for the current Turn's cleanup. Both application callbacks must respect their supplied AbortSignal. The example also checks cancellation after the chooser returns and immediately before submitting another Turn. The application owns and closes the Session, its provider and any approval UI resources.
