import { describe, expect, it } from 'vitest';
import { captureInitialMessages } from '../src/runtime/initial-messages';

describe('initial messages capture', () => {
  it('detaches ordered empty, duplicate and media content', () => {
    const messages = [
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'same' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'same' },
          { type: 'input_image', file_id: 'file-image', detail: 'original' },
          {
            type: 'input_file',
            file_data: 'data:application/pdf;base64,YQ==',
            filename: 'a.pdf',
          },
        ],
      },
    ] as any;
    const expected = structuredClone(messages);
    const captured = captureInitialMessages(messages);
    expect(captured).toEqual(expected);
    messages[2].content[0].text = 'mutated';
    expect(captured).toEqual(expected);
    expect(captureInitialMessages(captured)).toEqual(expected);
  });
  it.each([
    'bad',
    [{ role: 'system', content: 'x' }],
    [{ role: 'assistant', content: '\ud800' }],
    [{ role: 'assistant', content: [] }],
    [{ role: 'assistant', content: 'x', id: 'caller' }],
    [{ role: 'assistant', content: 'x', receipts: [] }],
    [
      {
        role: 'user',
        content: [{ type: 'function_call_output', output: 'x' }],
      },
    ],
  ])('rejects unsettled or authoritative data %j', (messages) => {
    expect(() => captureInitialMessages(messages as any)).toThrow();
  });
  it('rejects empty but present seeds on restore', () => {
    expect(captureInitialMessages(undefined, {})).toBeUndefined();
    expect(() => captureInitialMessages([], {})).toThrow(/fresh/);
    expect(() => captureInitialMessages([], undefined, 'existing')).toThrow(
      /fresh/,
    );
  });
});
