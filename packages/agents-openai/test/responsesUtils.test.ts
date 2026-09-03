import { describe, expect, it } from 'vitest';

import { normalizeInstructions } from '../src/responsesUtils';

describe('normalizeInstructions', () => {
  it('returns undefined for empty and whitespace-only instructions', () => {
    expect(normalizeInstructions(undefined)).toBeUndefined();
    expect(normalizeInstructions('')).toBeUndefined();
    expect(normalizeInstructions(' \t\n\r\u00a0\u2028\u2029\ufeff')).toBeUndefined();
  });

  it('preserves non-empty instructions exactly', () => {
    const instructions = '  Keep leading and trailing whitespace.  \n';
    expect(normalizeInstructions(instructions)).toBe(instructions);
  });
});
