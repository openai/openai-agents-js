import { expect, it } from 'vitest';
import { Agent } from '../src/runtime/public-agent';
import { captureCompletionDecision } from '../src/runtime/model-callbacks';

it('captures only closed completion decisions without trimming feedback', () => {
  expect(captureCompletionDecision(undefined)).toBeUndefined();
  expect(captureCompletionDecision({ action: 'stop' })).toEqual({
    action: 'stop',
  });
  const source = { action: 'continue', instructions: '  revise  ' };
  const captured = captureCompletionDecision(source);
  source.instructions = 'changed';
  expect(captured).toEqual({ action: 'continue', instructions: '  revise  ' });
  expect(Object.isFrozen(captured)).toBe(true);
});

it.each([
  null,
  false,
  'stop',
  {},
  { action: 'continue', instructions: ' ' },
  { action: 'stop', instructions: 'extra' },
  { action: 'continue', instructions: 'valid', extra: true },
])('rejects malformed completion decision %j', (value) => {
  expect(() => captureCompletionDecision(value)).toThrow(TypeError);
});

it('rejects malformed callbacks at public Agent construction', () => {
  expect(
    () =>
      new Agent({
        instructions: 'Test native callbacks.',
        beforeComplete: 1 as never,
      }),
  ).toThrow(TypeError);
  expect(
    () =>
      new Agent({
        instructions: 'Test native callbacks.',
        transformContext: {} as never,
      }),
  ).toThrow(TypeError);
});

// Public callback contexts retain application typing and expose no mutable Agent.
new Agent<{ account: string }>({
  instructions: 'Test native callbacks.',
  beforeComplete: (context) => {
    const account: string = context.context.account;
    void account;
    // @ts-expect-error An application account is not a number.
    const wrong: number = context.context.account;
    void wrong;
    // @ts-expect-error Native hooks do not expose a mutable Agent.
    void context.agent;
  },
  transformContext: (context) => {
    const account: string = context.context.account;
    void account;
    return context.items;
  },
});
