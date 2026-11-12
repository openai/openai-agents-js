import { expect, it } from 'vitest';
import type { InputGuardrail, UserInput } from '../src';
import { stagedGuardrailInput } from '../src/runtime/input';
import type { JsonObject } from '../src/runtime/binding';

it('keeps the existing root callback type and detaches ordered staged user content', () => {
  const check: InputGuardrail = {
    name: 'existing-root-type',
    callback: ({ input }: { input: UserInput }) => ({
      tripwireTriggered: typeof input === 'string',
    }),
  };
  expect(check.name).toBe('existing-root-type');
  const part = { type: 'input_text', text: 'duplicate' };
  const items: JsonObject[] = [
    { type: 'message', role: 'user', content: [part] },
    { type: 'message', role: 'user', content: [part] },
  ];
  const before = JSON.stringify(items);
  const projected = stagedGuardrailInput(items);
  expect(projected).toEqual({
    type: 'message',
    role: 'user',
    content: [part, part],
  });
  part.text = 'later mutation';
  expect(JSON.stringify(projected)).not.toContain('later mutation');
  expect(before).toContain('duplicate');
});

const rawCases: JsonObject[] = [
  { type: 'function_call_output', call_id: 'external', output: 'value' },
  {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'reply' }],
  },
  { type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }] },
];

it.each(rawCases)(
  'preserves the whole mixed Responses batch in root JSON input ($type)',
  (raw) => {
    const items: JsonObject[] = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'staged' }],
      },
      raw,
    ];
    const before = JSON.stringify(items);
    const projected = stagedGuardrailInput(items);
    expect(typeof projected).toBe('string');
    expect(JSON.parse(projected as string)).toEqual(items);
    expect(JSON.stringify(items)).toBe(before);
  },
);
