import { describe, it, expect } from 'vitest';
import { isZodObject, isAgentToolInput } from '../../src/utils/typeGuards';
import { z } from 'zod';

describe('type guards', () => {
  it('isZodObject detects zod objects', () => {
    expect(isZodObject(z.object({}))).toBe(true);
    expect(isZodObject({})).toBe(false);
  });

  it('isAgentToolInput checks for string input property', () => {
    expect(isAgentToolInput({ input: 'x' })).toBe(true);
    expect(isAgentToolInput({ input: 42 })).toBe(false);
    expect(isAgentToolInput({ input: {} })).toBe(false);
    expect(isAgentToolInput({ other: 1 })).toBe(false);
    expect(isAgentToolInput(null)).toBe(false);
  });
});
