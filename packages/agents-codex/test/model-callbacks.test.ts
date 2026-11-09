import { expect, it } from 'vitest';
import { parseEvent } from '../src/runtime/events';
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

it('preserves literal JSON keys before handing retained items to an identity context transform', () => {
  const source =
    '{"id":"turn","msg":{"type":"_sdk_model_context","items":[{"type":"tool_search_output","tools":[{"type":"function","name":"literal","parameters":{"type":"object","properties":{"__proto__":{"type":"string"}}}}]}]}}';
  const event = parseEvent(source);
  const original = JSON.parse(source).msg.items;
  expect(event.msg.items).toEqual(original);
  const copied = JSON.parse(JSON.stringify(event.msg.items));
  expect(
    Object.hasOwn(copied[0].tools[0].parameters.properties, '__proto__'),
  ).toBe(true);
  expect(copied[0].tools[0].parameters.properties['__proto__']).toEqual({
    type: 'string',
  });
  expect(Object.getPrototypeOf(copied[0].tools[0].parameters.properties)).toBe(
    Object.prototype,
  );
  expect(Object.prototype).not.toHaveProperty('type');
});
