import { describe, it, expect } from 'vitest';
import {
  getLastTextFromOutputMessage,
  getOutputText,
  getTextFromOutputMessage,
} from '../../src/utils/messages';
import type { ResponseOutputItem } from '../../src/types';
import { Usage } from '../../src/usage';
import type { ModelResponse } from '../../src/model';

describe('utils/messages', () => {
  it('returns undefined when item is not assistant message', () => {
    const nonMsg: ResponseOutputItem = {
      type: 'hosted_tool_call',
      name: 'x',
      status: 'completed',
    } as any;
    expect(getLastTextFromOutputMessage(nonMsg)).toBeUndefined();

    const userMsg: ResponseOutputItem = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'a' }],
    } as any;
    expect(getLastTextFromOutputMessage(userMsg)).toBeUndefined();
  });

  it('gets last text from assistant message', () => {
    const item: ResponseOutputItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: 'a' },
        { type: 'output_text', text: 'b' },
      ],
    } as any;
    expect(getLastTextFromOutputMessage(item)).toBe('b');
  });

  it('concatenates all assistant text segments', () => {
    const item: ResponseOutputItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: 'part1' },
        { type: 'refusal', refusal: 'ignored' },
        { type: 'output_text', text: 'part2' },
      ],
    } as any;

    expect(getTextFromOutputMessage(item)).toBe('part1part2');
    expect(getLastTextFromOutputMessage(item)).toBe('part2');
  });

  it('getOutputText returns all assistant text', () => {
    const response: ModelResponse = {
      usage: new Usage(),
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'first ' },
            { type: 'output_text', text: 'final' },
          ],
        } as any,
      ],
    };
    expect(getOutputText(response)).toBe('first final');
  });

  it('getOutputText returns empty string when output is empty', () => {
    const response: ModelResponse = {
      usage: new Usage(),
      output: [],
    };
    expect(getOutputText(response)).toBe('');
  });
});
