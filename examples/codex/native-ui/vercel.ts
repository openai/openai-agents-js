import { type Agent, type UserInput } from '@openai/agents';
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

/** Fresh plain-text view; caller must retain its actual plain output declaration. */
function createVercelResponse(
  turn: ViewTurn<string>,
  session: ViewSession,
  closeOwned?: () => Promise<void>,
): Response {
  if (session.id !== turn.sessionId)
    throw new TypeError('Pass the owning Session');
  const events = turn.events();
  return responseStream(
    events,
    async function* (signal) {
      const shown = new Map<string, string>();
      let started: string | undefined;
      let gap = false;
      let lost = false;
      try {
        yield { type: 'start' };
        for (;;) {
          const next = await localWait(events.next(), signal);
          if (next.done) break;
          const event = next.value;
          if (
            event.type === 'turn_started' &&
            !started &&
            event.submissionId === turn.submissionId
          ) {
            started = event.turnId;
            continue;
          }
          if (event.type === 'gap' && !started) {
            gap = true;
            continue;
          }
          if (
            !started ||
            event.type === 'gap' ||
            event.type === 'turn_started'
          ) {
            lost = true;
            break;
          }
          if (event.type === 'output_text_delta') {
            const opened = shown.has(event.itemId);
            if (!remember(shown, event.itemId, event.delta)) {
              lost = true;
              break;
            }
            if (!opened) yield { type: 'text-start', id: event.itemId };
            yield { type: 'text-delta', id: event.itemId, delta: event.delta };
          } else if (
            event.type === 'tool_started' ||
            event.type === 'tool_finished'
          )
            yield {
              type: 'data-tool-progress',
              data: progress(event),
              transient: true,
            };
        }
        for (const id of shown.keys()) yield { type: 'text-end', id };
        let terminal: Frame = { type: 'error', errorText: 'resync_required' };
        if (!lost && !(!started && gap && turn.turnId !== null)) {
          try {
            const result = await localWait(turn.wait(), signal);
            if (
              started &&
              (await completeDisplay(
                session,
                turn.childId,
                new Set([started]),
                started,
                shown,
                true,
                result.finalOutput,
                signal,
              ))
            )
              terminal = { type: 'finish' };
          } catch (error) {
            signal.throwIfAborted();
            terminal = stopped(error)
              ? { type: 'abort' }
              : { type: 'error', errorText: 'turn_failed' };
          }
        }
        yield terminal;
        yield '[DONE]';
      } finally {
        await events.return?.();
      }
    },
    { 'x-vercel-ai-ui-message-stream': 'v1' },
    closeOwned,
  );
}

/** A passive view: closing this response never closes its caller's Session. */
export function vercelResponse(
  turn: ViewTurn<string>,
  session: ViewSession,
): Response {
  return createVercelResponse(turn, session);
}

/** Own this Session only; the caller retains provider ownership. */
export async function ownedVercelResponse(
  agent: Agent<undefined>,
  input: UserInput,
): Promise<Response> {
  if (agent.outputType !== undefined)
    throw new TypeError('Plain default Agent output required');
  const session = await agent.session();
  try {
    const turn = await session.submit(input);
    return createVercelResponse(turn, session, () => session.close());
  } catch (error) {
    await session.close();
    throw error;
  }
}
