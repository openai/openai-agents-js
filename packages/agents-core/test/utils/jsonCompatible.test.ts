import { describe, expect, it } from 'vitest';
import { sanitizeJsonCompatibleValue } from '../../src/utils/jsonCompatible';

describe('sanitizeJsonCompatibleValue', () => {
  it('sanitizes circular and unsupported nested values', () => {
    const value: Record<string, unknown> = {
      text: 'kept',
      bigint: 1n,
      fn: () => undefined,
      list: [1n, 'kept'],
    };
    value.circular = value;

    expect(sanitizeJsonCompatibleValue(value)).toEqual({
      text: 'kept',
      list: [null, 'kept'],
    });
  });

  it('returns undefined for values with unreadable properties', () => {
    const value = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });

    expect(() => sanitizeJsonCompatibleValue(value)).not.toThrow();
    expect(sanitizeJsonCompatibleValue(value)).toBeUndefined();
  });

  it('returns undefined when toJSON throws or the depth limit is reached', () => {
    expect(
      sanitizeJsonCompatibleValue({
        toJSON() {
          throw new Error('unserializable');
        },
      }),
    ).toBeUndefined();
    expect(
      sanitizeJsonCompatibleValue({ nested: { value: true } }, { maxDepth: 1 }),
    ).toEqual({});
  });
});
