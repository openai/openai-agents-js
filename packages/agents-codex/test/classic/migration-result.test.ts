import { describe, expect, it } from 'vitest';
import type { AgentInputItem } from '@openai/agents-core/types';
import {
  captureInput,
  sdkInput,
  sdkInputItems,
} from '../../src/migration/input';

const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

describe('SDK views of captured migration input', () => {
  it.each(['', 'Hello.'])(
    'keeps string guard input and provides lifecycle items: %j',
    (text) => {
      const captured = captureInput(text);
      expect(sdkInput(captured)).toBe(text);
      const items: AgentInputItem[] = sdkInputItems(captured);
      expect(items).toEqual([{ type: 'message', role: 'user', content: text }]);
    },
  );

  it('keeps a captured user message as an SDK item array', () => {
    const captured = captureInput([{ role: 'user', content: 'Message.' }]);
    const expected = [{ type: 'message', role: 'user', content: 'Message.' }];
    expect(sdkInput(captured)).toEqual(expected);
    expect(sdkInputItems(captured)).toEqual(expected);
  });

  it('derives ordered text/image parts from the snapshot after caller mutation', () => {
    const before = { type: 'input_text' as const, text: 'Before.' };
    const picture = { type: 'input_image' as const, image, detail: 'auto' };
    const parts = [
      before,
      picture,
      { type: 'input_text' as const, text: 'After.' },
    ];
    const input: AgentInputItem[] = [{ role: 'user', content: parts }];
    const captured = captureInput(input);
    before.text = 'Changed.';
    picture.image = 'https://invalid.example/image.png';
    parts.length = 0;
    input.length = 0;
    expect(sdkInput(captured)).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Before.' },
          { type: 'input_image', image, detail: 'auto' },
          { type: 'input_text', text: 'After.' },
        ],
      },
    ]);
  });

  it('isolates guard and lifecycle edits from the validated snapshot', () => {
    const captured = captureInput([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Original.' },
          { type: 'input_image', image },
        ],
      },
    ]);
    const items = sdkInputItems(captured);
    const message = items[0]!;
    if (
      !('role' in message) ||
      message.role !== 'user' ||
      !Array.isArray(message.content)
    )
      throw new Error('Expected SDK user parts');
    const text = message.content[0]!;
    if (text.type !== 'input_text') throw new Error('Expected SDK text');
    text.text = 'Guard changed it.';
    message.content.length = 0;
    items.length = 0;
    expect(sdkInputItems(captured)).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Original.' },
          { type: 'input_image', image },
        ],
      },
    ]);
  });
});
