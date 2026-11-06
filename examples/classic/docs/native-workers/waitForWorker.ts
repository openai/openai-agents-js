import type { Turn } from '@openai/agents';

export async function waitForWorker<Output>(turn: Turn<Output>) {
  const signal = AbortSignal.timeout(30_000);
  try {
    return await turn.waitForAttention({ signal });
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      try {
        await turn.cancel();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Turn cancellation failed.',
          {
            cause: error,
          },
        );
      }
    }
    throw error;
  }
}
