import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  camelOrSnakeToSnakeCase,
  getProviderDataWithoutReservedKeys,
  getSnakeCasedProviderDataWithoutReservedKeys,
  snakeOrCamelToCamelCase,
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

  it('preserves object keys inside arrays', () => {
    expect(
      camelOrSnakeToSnakeCase({
        toolResults: [
          {
            inputSchema: {
              properties: {
                customerId: { type: 'string' },
              },
            },
          },
        ],
      }),
    ).toEqual({
      tool_results: [
        {
          inputSchema: {
            properties: {
              customerId: { type: 'string' },
            },
          },
        },
      ],
    });
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

  it('preserves a typed snake_cased object shape', () => {
    const result = camelOrSnakeToSnakeCase({
      fooBar: 1,
      nestedValue: { deepKey: 'x' },
    });

    expectTypeOf(result).toEqualTypeOf<{
      foo_bar: number;
      nested_value: { deep_key: string };
    }>();
  });

  it('preserves array entry types when arrays are passed through', () => {
    const result = camelOrSnakeToSnakeCase({
      toolResults: [{ inputSchema: { customerId: { type: 'string' } } }],
    });

    expectTypeOf(result.tool_results).toEqualTypeOf<
      Array<{ inputSchema: { customerId: { type: string } } }>
    >();
  });
});

describe('snakeOrCamelToCamelCase', () => {
  it('converts snake_case keys recursively', () => {
    expect(
      snakeOrCamelToCamelCase({
        outer_key: {
          nested_tools: [{ defer_loading: true, function_name: 'lookup' }],
        },
      }),
    ).toEqual({
      outerKey: {
        nestedTools: [{ deferLoading: true, functionName: 'lookup' }],
      },
    });
  });

  it('preserves arrays and primitives', () => {
    expect(snakeOrCamelToCamelCase([1, 2, 3])).toEqual([1, 2, 3]);
    expect(snakeOrCamelToCamelCase(undefined)).toBe(undefined);
  });

  it('preserves a typed camelCased object shape', () => {
    const result = snakeOrCamelToCamelCase({
      outer_key: { nested_tools: [{ function_name: 'lookup' }] },
    });

    expectTypeOf(result).toEqualTypeOf<{
      outerKey: { nestedTools: Array<{ functionName: string }> };
    }>();
  });
});

describe('reserved providerData filtering', () => {
  it('removes reserved keys without touching other values', () => {
    expect(
      getProviderDataWithoutReservedKeys(
        {
          role: 'assistant',
          content: 'override',
          customFlag: true,
          nested: { role: 'keep nested values' },
        },
        ['role', 'content'],
      ),
    ).toEqual({
      customFlag: true,
      nested: { role: 'keep nested values' },
    });
  });

  it('normalizes keys to snake_case before removing reserved keys', () => {
    expect(
      getSnakeCasedProviderDataWithoutReservedKeys(
        {
          callId: 'override',
          toolCallId: 'override-too',
          customFlag: true,
        },
        ['call_id', 'tool_call_id'],
      ),
    ).toEqual({
      custom_flag: true,
    });
  });
});
