import { UserError } from '../errors';
import type { RunStreamEvent } from '../events';

export type AgentToolStreamBuffer = {
  maxPendingEvents: number;
  overflow: () => never;
};

const runnerStreamBuffers = new WeakMap<object, AgentToolStreamBuffer>();

export function setAgentToolStreamBuffer(
  runner: object,
  buffer: AgentToolStreamBuffer,
): void {
  runnerStreamBuffers.set(runner, buffer);
}

export function getAgentToolStreamBuffer(
  runner: object,
): AgentToolStreamBuffer | undefined {
  return runnerStreamBuffers.get(runner);
}

export function createAgentToolStreamBuffer(
  maxPendingEvents: number,
  controller: AbortController,
): AgentToolStreamBuffer {
  return {
    maxPendingEvents,
    overflow() {
      const error = new UserError(
        `Agent tool stream backlog exceeded onStreamMaxPendingEvents=${maxPendingEvents}. ` +
          'Use faster handlers, increase the limit, or set it to null.',
      );
      controller.abort(error);
      throw error;
    },
  };
}

// Remove the abort listener after each dispatch rather than accumulating races
// against a single promise for the lifetime of a potentially long stream.
async function waitForHandlers(
  handlers: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    await Promise.race([handlers, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function drainAgentToolStream(
  result: AsyncIterable<RunStreamEvent> & { completed: Promise<void> },
  emit: (event: RunStreamEvent) => Promise<void>,
  signal: AbortSignal,
  controller: AbortController,
): Promise<void> {
  // A failed producer must also release a dispatch blocked on an observer.
  void result.completed.catch((error) => controller.abort(error));
  const iterator = result[Symbol.asyncIterator]();
  let failed = false;
  let failure: unknown;
  const recordFailure = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  };
  try {
    while (!signal.aborted) {
      const next = await iterator.next();
      if (next.done || signal.aborted) {
        break;
      }
      await waitForHandlers(emit(next.value), signal);
    }
  } catch (error) {
    recordFailure(error);
  } finally {
    // Explicitly close even when next() rejected, and wait for producer cleanup
    // without waiting for an application callback that cannot be cancelled.
    try {
      await iterator.return?.();
    } catch (error) {
      recordFailure(error);
    }
    try {
      await result.completed;
    } catch (error) {
      recordFailure(error);
    }
  }
  // Internal failure is recorded before aborting. Cleanup cannot replace it.
  if (controller.signal.aborted && signal.reason === controller.signal.reason) {
    throw controller.signal.reason;
  }
  if (failed) {
    signal.throwIfAborted();
    throw failure;
  }
}
