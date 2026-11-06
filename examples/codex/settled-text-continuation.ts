import type { ApprovalRequest, Completed, Session } from '@openai/agents';

/** Application-owned choices; this helper is not an SDK callback. */
export interface TextContinuationOptions {
  signal: AbortSignal;
  choose: (
    completed: Completed<string>,
    signal: AbortSignal,
  ) => Promise<string | null>;
  approve: (
    request: ApprovalRequest,
    signal: AbortSignal,
  ) => Promise<Parameters<ApprovalRequest['reply']>[0]>;
  maxTurns?: number;
}

/** Continue completed text with a new root Turn in the caller-owned Session. */
export async function continueCompletedText(
  session: Session,
  initialInput: string,
  { signal, choose, approve, maxTurns = 3 }: TextContinuationOptions,
): Promise<Completed<string>[]> {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new RangeError('maxTurns must be a positive safe integer');
  }
  const results: Completed<string>[] = [];
  let input = initialInput;
  for (;;) {
    signal.throwIfAborted();
    const turn = await session.submit(input, { ifBusy: 'reject' });
    try {
      for (;;) {
        const outcome = await turn.wait({ until: 'interaction', signal });
        if (!('requests' in outcome)) break;
        for (const request of outcome.requests) {
          if (request.type !== 'approval_request') {
            throw new Error('This example handles native approvals only');
          }
          const decision = await approve(request, signal);
          signal.throwIfAborted();
          await session.respond(request.reply(decision));
        }
      }
      // Accept completion from the original issued Turn, never from an event.
      const completed = await turn.wait();
      signal.throwIfAborted();
      results.push(completed);
      const nextInput = await choose(completed, signal);
      // The chooser may have awaited user input while cancellation arrived.
      signal.throwIfAborted();
      if (nextInput === null) return results;
      if (results.length === maxTurns) {
        throw new Error('Application turn limit reached');
      }
      input = nextInput;
    } catch (error) {
      // Cancelling only a wait does not stop its Turn. Join that exact owner.
      const [cancelled] = await Promise.allSettled([
        turn.cancel(),
        turn.wait(),
      ]);
      if (cancelled.status === 'rejected') {
        throw new AggregateError(
          [error, cancelled.reason],
          'Text continuation and Turn cleanup failed',
        );
      }
      throw error;
    }
  }
}
