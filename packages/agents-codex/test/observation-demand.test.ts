import { expect, it, vi } from 'vitest';
import { ObservationBuffer } from '../src/runtime/observation';

it('validates a public cursor before signalling demand and keeps JS publication sequence', async () => {
  const onDemand = vi.fn();
  const buffer = new ObservationBuffer('session', { onDemand });
  buffer.append({ type: 'warning', message: 'published' });
  expect(() => buffer.events({ after: 2 })).toThrow(RangeError);
  expect(onDemand).not.toHaveBeenCalled();
  const reader = buffer.events({ after: 1 });
  expect(onDemand).toHaveBeenCalledOnce();
  const next = reader.next();
  // This simulates a previously native-held row reaching the SAME reducer.
  buffer.append({ type: 'warning', message: 'late prefix' });
  expect(await next).toEqual({
    done: false,
    value: {
      type: 'warning',
      message: 'late prefix',
      sessionId: 'session',
      sequence: 2,
    },
  });
  await reader.return?.();
  buffer.append({ type: 'warning', message: 'still executing' });
  buffer.finish('closed');
  const replay = await Array.fromAsync(buffer.events());
  expect(
    replay.map((event) => {
      if (event.type === 'action_requested')
        throw new Error('Unexpected manual request');
      return event.sequence;
    }),
  ).toEqual([1, 2, 3, 4]);
});
