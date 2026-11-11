import { expect, it } from 'vitest';
import type { Observation } from '../src/runtime/observation';
import { textStream } from '../src/ui';

const start = {
  type: 'turn_started',
  sessionId: 'session',
  sequence: 2,
  submissionId: 'root',
  turnId: 'turn',
} as const;
const delta = {
  ...start,
  type: 'output_text_delta',
  itemId: 'message',
  delta: 'hello',
} as const;
const gap = {
  type: 'gap',
  sessionId: 'session',
  sequence: 1,
  firstSequence: 1,
} as const;

function turn(events: AsyncIterableIterator<Observation>) {
  return {
    childId: null,
    submissionId: start.submissionId,
    turnId: start.turnId,
    events: () => events,
  };
}

async function* observations(...values: Observation[]) {
  yield* values;
}

it('projects text from its root and continuations', async () => {
  const child = { submissionId: 'child', parentSubmissionId: 'root' };
  const continuation = { submissionId: 'continuation', turnId: 'next' };
  const reader = textStream(
    turn(
      observations(
        gap,
        start,
        { ...start, ...child },
        { ...delta, ...child, delta: 'child text' },
        delta,
        { ...start, ...continuation },
        { ...delta, ...continuation, delta: ' world' },
      ),
    ),
  ).getReader();

  expect(await reader.read()).toEqual({ value: 'hello', done: false });
  expect(await reader.read()).toEqual({ value: ' world', done: false });
  expect((await reader.read()).done).toBe(true);
});

it.each([
  [start, gap],
  [gap, delta],
  [gap, { ...start, submissionId: 'continuation' }],
] satisfies Observation[][])(
  'errors after losing owned observations (%j)',
  async (...events) => {
    const reader = textStream(turn(observations(...events))).getReader();
    await expect(reader.read()).rejects.toThrow(
      'Native text observations were lost',
    );
  },
);

it('cancels a pending observation read', async () => {
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<IteratorResult<Observation>>();
  let released = false;
  const events: AsyncIterableIterator<Observation> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      entered.resolve();
      return pending.promise;
    },
    async return() {
      released = true;
      pending.resolve({ done: true, value: undefined });
      return { done: true, value: undefined };
    },
  };
  const reader = textStream(turn(events)).getReader();
  const read = reader.read();
  await entered.promise;
  await reader.cancel();
  expect(released).toBe(true);
  expect((await read).done).toBe(true);
});
