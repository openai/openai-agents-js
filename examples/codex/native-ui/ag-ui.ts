import { NativeError, type OutputSpec } from '@openai/agents';
import {
  stopped,
  completeDisplay,
  localWait,
  progress,
  remember,
  responseStream,
  type Frame,
  type ViewSession,
  type ViewTurn,
} from './projection.js';

/** Pass the actual opening/submit output declaration; never infer it from deltas. */
export function agUiResponse<T>(
  turn: ViewTurn<T>,
  session: ViewSession,
  outputType: OutputSpec<T> | undefined,
): Response {
  if (session.id !== turn.sessionId)
    throw new TypeError('Pass the owning Session');
  const events = turn.events();
  const identity = {
    threadId: turn.childId ?? turn.sessionId,
    runId: turn.submissionId,
  };
  return responseStream(
    events,
    async function* (signal) {
      const shown = new Map<string, string>();
      const turns = new Set<string>();
      let started: string | undefined;
      let gap = false;
      let lost = false;
      let childCancelled = false;
      let terminal: Frame = {
        type: 'RUN_ERROR',
        message:
          'Observations are incomplete. Reload the authorized history view.',
        code: 'resync_required',
      };
      try {
        yield { type: 'RUN_STARTED', ...identity };
        for (;;) {
          const next = await localWait(events.next(), signal);
          if (next.done) break;
          const event = next.value;
          if (
            event.type === 'turn_started' &&
            (started || event.submissionId === turn.submissionId)
          ) {
            started = event.turnId;
            turns.add(started);
            continue;
          }
          if (event.type === 'gap' && !started) {
            gap = true;
            continue;
          }
          if (!started || event.type === 'gap') {
            lost = true;
            break;
          }
          if (event.type === 'output_text_delta') {
            if (!event.delta) continue;
            const opened = shown.has(event.itemId);
            if (!remember(shown, event.itemId, event.delta)) {
              lost = true;
              break;
            }
            if (!opened)
              yield {
                type: 'TEXT_MESSAGE_START',
                messageId: event.itemId,
                role: 'assistant',
              };
            yield {
              type: 'TEXT_MESSAGE_CONTENT',
              messageId: event.itemId,
              delta: event.delta,
            };
          } else if (event.type === 'turn_finished' && turn.childId !== null)
            childCancelled = event.status === 'cancelled';
          else if (
            event.type === 'tool_started' ||
            event.type === 'tool_finished'
          )
            yield {
              type: 'CUSTOM',
              name: 'sdk.tool_progress',
              value: progress(event),
            };
        }
        if (!lost && (started || !gap || turn.turnId === null)) {
          try {
            const result = await localWait(turn.wait(), signal);
            if (
              started &&
              (await completeDisplay(
                session,
                turn.childId,
                turns,
                started,
                shown,
                outputType === undefined,
                result.finalOutput,
                signal,
              ))
            )
              terminal = { type: 'RUN_FINISHED', ...identity };
          } catch (error) {
            signal.throwIfAborted();
            terminal =
              stopped(error) || (childCancelled && error instanceof NativeError)
                ? {
                    type: 'RUN_ERROR',
                    message: 'The turn ended with a stop-related error.',
                    code: 'turn_cancelled',
                  }
                : {
                    type: 'RUN_ERROR',
                    message: 'The turn failed.',
                    code: 'turn_failed',
                  };
          }
        }
        for (const id of shown.keys())
          yield { type: 'TEXT_MESSAGE_END', messageId: id };
        yield terminal;
      } finally {
        await events.return?.();
      }
    },
    {},
  );
}
