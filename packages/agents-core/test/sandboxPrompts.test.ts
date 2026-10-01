import { describe, expect, it } from 'vitest';
import { prompt } from '../src/sandbox/runtime/prompts';

describe('sandbox prompt formatting', () => {
  it.each([
    { value: '', expected: '' },
    { value: ' \t\r\n  ', expected: '' },
    {
      value: '\n  first\n    second\n  third\n',
      expected: 'first\n  second\nthird',
    },
    { value: '\r\n  first\r\n    second\r\n', expected: 'first\n  second' },
    { value: '\r\nfirst\r\n  second\r\n', expected: 'first\r\n  second' },
    { value: '\n\tfirst\n\t\tsecond\n', expected: 'first\n\tsecond' },
    { value: '\n  first\n \n  second\n', expected: 'first\n\nsecond' },
  ])('preserves formatting for $value', ({ value, expected }) => {
    expect(prompt`${value}`).toBe(expected);
  });

  it('dedents a large indented value without losing lines', () => {
    const value = `  First\n${'    Detail\n'.repeat(1_000_000)}  Last`;
    expect(prompt`${value}`).toBe(
      `First\n${'  Detail\n'.repeat(1_000_000)}Last`,
    );
  });
});
