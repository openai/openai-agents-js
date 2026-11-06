import { describe, it, expect } from 'vitest';
import type { Observation } from '@openai/agents';
import { vercelResponse } from '../../../../examples/codex/native-ui/vercel';
import { agUiResponse } from '../../../../examples/codex/native-ui/ag-ui';
import {
  responseStream,
  type ViewTurn,
  type ViewSession,
} from '../../../../examples/codex/native-ui/projection';

function readerFixture() {
  const pending = Promise.withResolvers<IteratorResult<Observation>>();
  const entered = Promise.withResolvers<void>();
  let reads = 0;
  let returns = 0;
  const events: AsyncIterableIterator<Observation> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      reads++;
      entered.resolve();
      return pending.promise;
    },
    async return() {
      returns++;
      pending.resolve({ done: true, value: undefined });
      return { done: true, value: undefined };
    },
  };
  return {
    events,
    entered,
    get reads() {
      return reads;
    },
    get returns() {
      return returns;
    },
  };
}
const start: Observation = {
  type: 'turn_started',
  sessionId: 's',
  sequence: 1,
  turnId: 't',
  submissionId: 'submission',
};
function turn(
  events: AsyncIterableIterator<Observation>,
  wait: ViewTurn<string>['wait'],
): ViewTurn<string> {
  return {
    sessionId: 's',
    submissionId: 'submission',
    turnId: 't',
    childId: null,
    events: () => events,
    wait,
  };
}
const session: ViewSession = { id: 's', async *items() {} };

describe('passive UI response ownership', () => {
  it.each(['vercel', 'ag-ui'] as const)(
    'cancel releases a pending %s observation without stopping work',
    async (protocol) => {
      const fixture = readerFixture();
      const completion = Promise.withResolvers<{ finalOutput: string }>();
      const work = turn(fixture.events, () => completion.promise);
      const response =
        protocol === 'vercel'
          ? vercelResponse(work, session)
          : agUiResponse(work, session, undefined);
      const reader = response.body!.getReader();
      await reader.read();
      await fixture.entered.promise;
      await reader.cancel();
      expect(fixture.returns).toBeGreaterThan(0);
      const reads = fixture.reads;
      completion.resolve({ finalOutput: 'external result' });
      expect(await work.wait()).toEqual({ finalOutput: 'external result' });
      expect((await reader.read()).done).toBe(true);
      expect(fixture.reads).toBe(reads);
    },
  );

  it.each(['settlement', 'history'] as const)(
    'cancel detaches while awaiting %s, handling later rejection',
    async (phase) => {
      const entered = Promise.withResolvers<void>();
      const blocked = Promise.withResolvers<{ finalOutput: string }>();
      const history = Promise.withResolvers<void>();
      const events = (async function* () {
        yield start;
        if (phase === 'history')
          yield {
            ...start,
            type: 'output_text_delta' as const,
            itemId: 'i',
            delta: 'text',
          };
      })();
      const work = turn(events, async () => {
        if (phase === 'settlement') {
          entered.resolve();
          return blocked.promise;
        }
        return { finalOutput: 'text' };
      });
      const owned: ViewSession = {
        id: 's',
        async *items() {
          entered.resolve();
          await history.promise;
          yield* [];
        },
      };
      const reader = vercelResponse(work, owned).body!.getReader();
      const draining = (async () => {
        while (!(await reader.read()).done) {
          /* Drain until local detach. */
        }
      })();
      await entered.promise;
      await reader.cancel();
      await draining;
      blocked.reject(new Error('late settlement rejection'));
      // When history owns the blocked wait, this rejection remains locally observed.
      if (phase === 'history')
        history.reject(new Error('late history rejection'));
      else history.resolve();
      // The unused fixture promise is not owned by the projection.
      if (phase === 'history')
        void blocked.promise.catch(() => {
          /* This unused fixture promise is not owned by the projection. */
        });
    },
  );

  it('owned cleanup starts before generator return and cancel joins it', async () => {
    const fixture = readerFixture();
    const closing = Promise.withResolvers<void>();
    const enteredClose = Promise.withResolvers<void>();
    const response = responseStream(
      fixture.events,
      async function* (signal) {
        yield { type: 'start' };
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
      {},
      () => {
        enteredClose.resolve();
        return closing.promise;
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    let detached = false;
    const cancel = reader.cancel().then(() => {
      detached = true;
    });
    try {
      await enteredClose.promise;
      expect(detached).toBe(false);
      expect(fixture.returns).toBeGreaterThan(0);
      closing.resolve();
      await cancel;
      expect(detached).toBe(true);
    } finally {
      closing.resolve();
      await cancel;
    }
  });
});
