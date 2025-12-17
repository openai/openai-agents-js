import { describe, expect, it } from 'vitest';

import { RequestUsage, Usage } from '../src/usage';

describe('Usage', () => {
  it('initialises with default values', () => {
    const usage = new Usage();

    expect(usage.requests).toBe(0);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.requestUsageEntries).toBeUndefined();
  });

  it('can be constructed from a ResponseUsage-like object', () => {
    const usage = new Usage({
      requests: 3,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    expect(usage.requests).toBe(3);
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
    expect(usage.totalTokens).toBe(15);
    expect(usage.requestUsageEntries).toBeUndefined();
  });

  it('falls back to snake_case fields', () => {
    const usage = new Usage({
      requests: 2,
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
      input_tokens_details: { foo: 1 },
      output_tokens_details: { bar: 2 },
      request_usage_entries: [
        {
          input_tokens: 7,
          output_tokens: 3,
          total_tokens: 10,
          input_tokens_details: { foo: 1 },
          output_tokens_details: { bar: 2 },
        },
      ],
    });

    expect(usage.requests).toBe(2);
    expect(usage.inputTokens).toBe(7);
    expect(usage.outputTokens).toBe(3);
    expect(usage.totalTokens).toBe(10);
    expect(usage.inputTokensDetails).toEqual([{ foo: 1 }]);
    expect(usage.outputTokensDetails).toEqual([{ bar: 2 }]);
    expect(usage.requestUsageEntries).toEqual([
      new RequestUsage({
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        inputTokensDetails: { foo: 1 },
        outputTokensDetails: { bar: 2 },
      }),
    ]);
  });

  it('adds other Usage instances correctly', () => {
    const usageA = new Usage({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });
    const usageB = new Usage({
      requests: 2,
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    });

    usageA.add(usageB);

    expect(usageA.requests).toBe(3); // 1 (default) + 2
    expect(usageA.inputTokens).toBe(4); // 1 + 3
    expect(usageA.outputTokens).toBe(5); // 1 + 4
    expect(usageA.totalTokens).toBe(9); // 2 + 7
    expect(usageA.requestUsageEntries).toBeUndefined();
  });

  it('the add method accepts an empty object', () => {
    const usage = new Usage({});
    usage.add({} as Usage);
    expect(usage.inputTokensDetails).toEqual([]);
    expect(usage.outputTokensDetails).toEqual([]);
    expect(usage.requestUsageEntries).toBeUndefined();
    expect(usage.requests).toBe(1);
  });

  it('adds a request usage entry for single request usage', () => {
    const aggregated = new Usage();
    aggregated.add(
      new Usage({
        requests: 1,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokensDetails: { cached_tokens: 2 },
        outputTokensDetails: { reasoning_tokens: 3 },
      }),
    );

    expect(aggregated.requestUsageEntries).toEqual([
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokensDetails: { cached_tokens: 2 },
        outputTokensDetails: { reasoning_tokens: 3 },
      },
    ]);
  });

  it('ignores zero-token single requests when tracking request usage', () => {
    const aggregated = new Usage();
    aggregated.add(
      new Usage({
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokensDetails: { cached_tokens: 0 },
        outputTokensDetails: { reasoning_tokens: 0 },
      }),
    );

    expect(aggregated.requestUsageEntries).toBeUndefined();
  });

  it('merges existing request usage entries when present', () => {
    const aggregated = new Usage();
    const withEntries = new Usage({
      requests: 1,
      inputTokens: 5,
      outputTokens: 6,
      totalTokens: 11,
      requestUsageEntries: [
        new RequestUsage({
          inputTokens: 5,
          outputTokens: 6,
          totalTokens: 11,
        }),
      ],
    });

    aggregated.add(withEntries);

    expect(aggregated.requestUsageEntries).toEqual([
      {
        inputTokens: 5,
        outputTokens: 6,
        totalTokens: 11,
        inputTokensDetails: {},
        outputTokensDetails: {},
      },
    ]);
  });

  it('preserves endpoint metadata on request usage entries', () => {
    const aggregated = new Usage();

    aggregated.add(
      new Usage({
        requests: 1,
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
        requestUsageEntries: [
          new RequestUsage({
            inputTokens: 3,
            outputTokens: 4,
            totalTokens: 7,
            endpoint: 'responses.create',
          }),
        ],
      }),
    );

    expect(aggregated.requestUsageEntries).toEqual([
      {
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
        inputTokensDetails: {},
        outputTokensDetails: {},
        endpoint: 'responses.create',
      },
    ]);
  });
});
