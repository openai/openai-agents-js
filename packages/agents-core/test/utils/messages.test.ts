import { describe, it, expect } from 'vitest';
import {
  getLastTextFromOutputMessage,
  getOutputText,
  getRefusalFromOutputMessage,
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

  it('concatenates all assistant refusal segments', () => {
    const item: ResponseOutputItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'refusal', refusal: 'part1' },
        { type: 'output_text', text: 'ignored' },
        { type: 'refusal', refusal: 'part2' },
      ],
    } as any;

    expect(getRefusalFromOutputMessage(item)).toBe('part1part2');
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

  it('getOutputText joins messages segmented by reasoning', () => {
    const response: ModelResponse = {
      usage: new Usage(),
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'first' }],
        } as any,
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'thinking' }],
        } as any,
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'second' }],
        } as any,
      ],
    };

    expect(getOutputText(response)).toBe('firstsecond');
  });

  it('getOutputText joins messages around provider-executed tool search', () => {
    const response: ModelResponse = {
      usage: new Usage(),
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'first' }],
        } as any,
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'thinking' }],
        } as any,
        {
          type: 'tool_search_call',
          callId: 'search_1',
          execution: 'server',
          arguments: { query: 'weather' },
        },
        {
          type: 'tool_search_output',
          callId: 'search_1',
          execution: 'server',
          tools: [{ type: 'tool_reference', functionName: 'get_weather' }],
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'second' }],
        } as any,
      ],
    };

    expect(getOutputText(response)).toBe('firstsecond');
  });

  it('getOutputText keeps the last message without reasoning', () => {
    const response: ModelResponse = {
      usage: new Usage(),
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'first' }],
        } as any,
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'second' }],
        } as any,
      ],
    };

    expect(getOutputText(response)).toBe('second');
  });

  it('getOutputText joins messages when reasoning is the final item', () => {
    const response: ModelResponse = {
      usage: new Usage(),
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'first' }],
        } as any,
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'thinking' }],
        } as any,
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'second' }],
        } as any,
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'checking' }],
        } as any,
      ],
    };

    expect(getOutputText(response)).toBe('firstsecond');
  });

  it('getOutputText returns empty string when output is empty', () => {
    const response: ModelResponse = {
      usage: new Usage(),
      output: [],
    };
    expect(getOutputText(response)).toBe('');
  });
});
