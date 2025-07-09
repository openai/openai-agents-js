import { describe, it, expect } from 'vitest';

import { Usage } from '../src/usage';

describe('Usage', () => {
  it('initialises with default values', () => {
    const usage = new Usage();

    expect(usage.requests).toBe(0);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
  });

  it('can be constructed from a ResponseUsage‑like object', () => {
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
  });

  it('the add method accepts an empty object', () => {
    const usage = new Usage({});
    usage.add({} as Usage);
    expect(usage.inputTokensDetails).toEqual([]);
    expect(usage.outputTokensDetails).toEqual([]);
  });
});
