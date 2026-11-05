import { ReadableStream } from 'node:stream/web';
import { RunRawModelStreamEvent, type StreamEvent } from '@openai/agents-core';
import { MAX_MODEL_BYTES } from './model';
import type { MigrationSemanticEvent } from './result';

/** Own delivery without replacing the native producer's outcome or physical joins. */
export function migrationStream<
  Result extends AsyncIterable<MigrationSemanticEvent>,
>(
  produce: (
    signal: AbortSignal,
    publish: (event: StreamEvent) => void,
  ) => Promise<Result>,
  callerSignal?: AbortSignal,
  maxBufferedBytes = MAX_MODEL_BYTES,
) {
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0)
    throw new RangeError('Stream byte budget must be a positive safe integer');
  const execution = new AbortController();
  let settled = false;
  let publicationFailure: { error: unknown } | undefined;
  let rawController!: ReadableStreamDefaultController<RunRawModelStreamEvent>;
  const size = (event: RunRawModelStreamEvent) =>
    Buffer.byteLength(JSON.stringify(event));
  const requestCancellation = (reason?: unknown) => {
    if (settled || execution.signal.aborted) return;
    execution.abort(reason);
    rawController.error(execution.signal.reason);
  };
  const unvalidatedRaw = new ReadableStream<RunRawModelStreamEvent>(
    {
      start(controller) {
        rawController = controller;
      },
      cancel(reason) {
        requestCancellation(reason);
      },
    },
    { highWaterMark: maxBufferedBytes, size: (event) => size(event!) },
  );
  const abort = () => requestCancellation(callerSignal!.reason);
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener('abort', abort, { once: true });
  const completed = Promise.resolve().then(async () => {
    try {
      execution.signal.throwIfAborted();
      const result = await produce(execution.signal, (event) => {
        execution.signal.throwIfAborted();
        try {
          const snapshot = new RunRawModelStreamEvent(structuredClone(event));
          if (size(snapshot) > (rawController.desiredSize ?? 0))
            throw new RangeError(
              `Migration raw stream backlog exceeds ${maxBufferedBytes} bytes`,
            );
          rawController.enqueue(snapshot);
        } catch (error) {
          publicationFailure ??= { error };
          rawController.error(error);
          requestCancellation(error);
          throw error;
        }
      });
      if (publicationFailure) throw publicationFailure.error;
      // The producer owns cancellation races. A late request cannot rewrite an
      // already successful native outcome after its guards and cleanup finish.
      if (!execution.signal.aborted) rawController.close();
      return result;
    } catch (error) {
      rawController.error(error);
      requestCancellation(error);
      throw error;
    } finally {
      settled = true;
      callerSignal?.removeEventListener('abort', abort);
    }
  });
  void completed.catch(() => {});

  // Accepted semantics come from the existing guarded facade, not raw deltas.
  // Cancellation can close a pending reader without claiming a physical join.
  const toStream = () => {
    let cancelled = false;
    let events: AsyncIterator<MigrationSemanticEvent> | undefined;
    return new ReadableStream<MigrationSemanticEvent>(
      {
        async pull(controller) {
          try {
            const result = await completed;
            if (cancelled) return;
            events ??= result[Symbol.asyncIterator]();
            const event = await events.next();
            if (cancelled) return;
            if (event.done) controller.close();
            else controller.enqueue(event.value);
          } catch (error) {
            if (!cancelled) controller.error(error);
          }
        },
        async cancel(reason) {
          cancelled = true;
          requestCancellation(reason);
          await events?.return?.();
        },
      },
      { highWaterMark: 0 },
    );
  };
  return Object.freeze({
    unvalidatedRaw,
    completed,
    toStream,
    [Symbol.asyncIterator]() {
      return toStream()[Symbol.asyncIterator]();
    },
  });
}
