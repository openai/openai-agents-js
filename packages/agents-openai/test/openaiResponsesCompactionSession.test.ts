import { describe, expect, it } from 'vitest';

import { OpenAIResponsesCompactionSession } from '../src';

describe('OpenAIResponsesCompactionSession', () => {
  it('rejects non-OpenAI model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'yet-another-model',
      });
    }).toThrow(/Unsupported model/);
  });

  it('allows unknown gpt-* model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'gpt-9999-super-new-model',
      });
    }).not.toThrow();
  });

  it('allows fine-tuned gpt-* model ids', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'ft:gpt-4.1-nano-2025-04-14:org:proj:suffix',
      });
    }).not.toThrow();
  });

  it('allows o* model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'o1-pro',
      });
    }).not.toThrow();
  });
});
