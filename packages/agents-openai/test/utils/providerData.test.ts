import { describe, it, expect } from 'vitest';
import {
  camelOrSnakeToSnakeCase,
  snakeToCamelCase,
} from '../../src/utils/providerData';

describe('camelToSnakeCase', () => {
  it('converts flat camelCase keys to snake_case', () => {
    expect(camelOrSnakeToSnakeCase({ fooBar: 1, bazQux: 2 })).toEqual({
      foo_bar: 1,
      baz_qux: 2,
    });
  });
  it('converts snake_case keys to snake_case', () => {
    expect(
      camelOrSnakeToSnakeCase({ foo_bar_buz: 1, baz_qux: 2, foo_bar: 3 }),
    ).toEqual({
      foo_bar_buz: 1,
      baz_qux: 2,
      foo_bar: 3,
    });
  });
  it('converts mixed keys to snake_case', () => {
    expect(
      camelOrSnakeToSnakeCase({ foo_barBuz: 1, bazQux: 2, foo_bar: 3 }),
    ).toEqual({
      foo_bar_buz: 1,
      baz_qux: 2,
      foo_bar: 3,
    });
  });

  it('handles nested objects', () => {
    expect(
      camelOrSnakeToSnakeCase({
        outerKey: { innerKey: 42, anotherInner: { deepKey: 'x' } },
      }),
    ).toEqual({
      outer_key: { inner_key: 42, another_inner: { deep_key: 'x' } },
    });
  });

  it('handles nested objects with mixed keys', () => {
    expect(
      camelOrSnakeToSnakeCase({
        outerKey: { innerKey: 42, anotherInner: { deep_key: 'x' } },
      }),
    ).toEqual({
      outer_key: { inner_key: 42, another_inner: { deep_key: 'x' } },
    });
  });

  it('handles arrays and primitives', () => {
    expect(camelOrSnakeToSnakeCase([1, 2, 3])).toEqual([1, 2, 3]);
    expect(camelOrSnakeToSnakeCase(undefined)).toBe(undefined);
  });

  it('leaves already snake_case keys as is', () => {
    expect(
      camelOrSnakeToSnakeCase({ already_snake: 1, also_snake_case: 2 }),
    ).toEqual({
      already_snake: 1,
      also_snake_case: 2,
    });
  });

  it('handles mixed keys', () => {
    expect(camelOrSnakeToSnakeCase({ fooBar: 1, already_snake: 2 })).toEqual({
      foo_bar: 1,
      already_snake: 2,
    });
  });
});

describe('snakeToCamelCase', () => {
  it('converts flat snake_case keys to camelCase', () => {
    expect(snakeToCamelCase({ foo_bar: 1, baz_qux: [2, 3, 4] })).toEqual({
      fooBar: 1,
      bazQux: [2, 3, 4],
    });
  });

  it('handles nested objects', () => {
    expect(
      snakeToCamelCase({
        outer_key: { inner_key: 42, another_inner: { deep_key: 'x' } },
      }),
    ).toEqual({ outerKey: { innerKey: 42, anotherInner: { deepKey: 'x' } } });
  });

  it('handles arrays and primitives', () => {
    expect(snakeToCamelCase([1, 2, 3])).toEqual([1, 2, 3]);
    expect(snakeToCamelCase(undefined)).toBe(undefined);
  });

  it('leaves already camelCase keys as is', () => {
    expect(snakeToCamelCase({ alreadyCamel: 1, alsoCamelCase: 2 })).toEqual({
      alreadyCamel: 1,
      alsoCamelCase: 2,
    });
  });

  it('handles mixed keys', () => {
    expect(snakeToCamelCase({ foo_bar: 1, alreadyCamel: 2 })).toEqual({
      fooBar: 1,
      alreadyCamel: 2,
    });
  });
});
