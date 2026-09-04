import { describe, expect, it } from 'vitest';
import { searchParamsToAuthHeaderQuery } from '../src/responsesUtils';

describe('searchParamsToAuthHeaderQuery', () => {
  it('preserves ordinary, repeated, and prototype-sensitive keys', () => {
    const query = searchParamsToAuthHeaderQuery(
      new URLSearchParams(
        'base=1&__proto__=tenant&__proto__=partner&constructor=ctor&a=1&a=2',
      ),
    );

    expect(query).toBeDefined();
    expect(Object.getPrototypeOf(query)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(query, '__proto__')).toBe(true);
    expect(query?.base).toBe('1');
    expect(query?.['__proto__']).toEqual(['tenant', 'partner']);
    expect(query?.constructor).toBe('ctor');
    expect(query?.a).toEqual(['1', '2']);
  });

  it('returns undefined for empty parameters', () => {
    expect(
      searchParamsToAuthHeaderQuery(new URLSearchParams()),
    ).toBeUndefined();
  });
});
