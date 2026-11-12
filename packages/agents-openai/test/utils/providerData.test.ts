import { describe, it, expect } from 'vitest';
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
