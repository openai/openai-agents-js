import { describe, expect, it } from 'vitest';
import { RunRawModelStreamEvent } from '../src/events';

describe('RunRawModelStreamEvent', () => {
  it('derives source from raw model event providerData', () => {
    const event = new RunRawModelStreamEvent({
      type: 'model',
      event: { type: 'response.created' } as any,
      providerData: {
        rawModelEventSource: 'openai-responses',
      },
    });

    expect(event.source).toBe('openai-responses');
  });

  it('leaves source undefined for non-model protocol events', () => {
    const event = new RunRawModelStreamEvent({
      type: 'output_text_delta',
      delta: 'hello',
    });

    expect(event.source).toBeUndefined();
  });
});
