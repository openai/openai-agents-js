import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { toRequestUsageEntry } from '../src/responsesUtils';

describe('response usage details', () => {
  it('preserves nested cache details without sharing provider state', () => {
    const usage: OpenAI.Responses.ResponseUsage = {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: {
        cached_tokens: 3,
        cache_write_tokens: 5,
        cache_write_tokens_details: { ttl_30m_tokens: 4, ttl_12h_tokens: 1 },
      },
      output_tokens_details: { reasoning_tokens: 1 },
    };
    const result = toRequestUsageEntry(usage, 'responses.create');
    expect(result.inputTokensDetails).toEqual(usage.input_tokens_details);
    expect(result.inputTokensDetails).not.toBe(usage.input_tokens_details);
    expect(result.inputTokensDetails.cache_write_tokens_details).not.toBe(
      usage.input_tokens_details.cache_write_tokens_details,
    );
    expect(result.totalTokens).toBe(12);
    expect(result.endpoint).toBe('responses.create');
  });
  it('preserves empty usage defaults', () => {
    expect(
      toRequestUsageEntry(undefined, 'responses.compact').inputTokensDetails,
    ).toEqual({});
  });
});
