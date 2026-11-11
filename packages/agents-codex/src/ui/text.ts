import type { Turn } from '../runtime/session';

type TextTurn = Pick<
  Turn<unknown, string | null>,
  'childId' | 'events' | 'submissionId' | 'turnId'
>;

const missingText = 'Native text observations were lost';

/**
 * Read a native turn's text deltas as a Web stream. Closing the reader leaves
 * execution running. A gap in this turn's observations errors the stream.
 * Use turn.wait() to observe the turn's result or execution failure.
 */
export function textStream(turn: TextTurn): ReadableStream<string> {
  const events = turn.events();
  let started = false;
  let gapBeforeStart = false;
  let closed = false;

  return new ReadableStream<string>({
    async pull(controller) {
      try {
        while (!closed) {
          const next = await events.next();
          if (closed) return;
          if (next.done) {
            if (gapBeforeStart && !started && turn.turnId !== null)
              throw new Error(missingText);
            closed = true;
            controller.close();
            return;
          }

          const event = next.value;
          if (event.type === 'gap') {
            if (started) throw new Error(missingText);
            gapBeforeStart = true;
            continue;
          }
          if (
            event.type !== 'turn_started' &&
            event.type !== 'output_text_delta'
          )
            continue;
          if (turn.childId === null && event.parentSubmissionId !== undefined)
            continue;
          if (event.type === 'turn_started') {
            if (!started && event.submissionId !== turn.submissionId)
              throw new Error(missingText);
            started = true;
            continue;
          }
          if (!started) throw new Error(missingText);
          controller.enqueue(event.delta);
          return;
        }
      } catch (error) {
        if (closed) return;
        closed = true;
        controller.error(error);
        await events.return?.();
      }
    },
    async cancel() {
      closed = true;
      await events.return?.();
    },
  });
}
