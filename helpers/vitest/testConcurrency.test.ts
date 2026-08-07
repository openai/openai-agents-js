import { describe, expect, it } from 'vitest';
import { recommendedTestWorkers } from './testConcurrency';

describe('test concurrency', () => {
  it.each([
    { available: 1, expected: 1 },
    { available: 2, expected: 1 },
    { available: 4, expected: 3 },
    { available: 8, expected: 7 },
    { available: 14, expected: 8 },
    { available: 32, expected: 8 },
  ])(
    'uses $expected workers when $available are available',
    ({ available, expected }) => {
      expect(recommendedTestWorkers(available)).toBe(expected);
    },
  );
});
