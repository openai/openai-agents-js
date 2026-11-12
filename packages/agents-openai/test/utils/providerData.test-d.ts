import { expectTypeOf } from 'vitest';
import {
  camelOrSnakeToSnakeCase,
  snakeOrCamelToCamelCase,
} from '../../src/utils/providerData';

{
  const result = camelOrSnakeToSnakeCase({
    fooBar: 1,
    nestedValue: { deepKey: 'x' },
  });

  expectTypeOf(result).toEqualTypeOf<{
    foo_bar: number;
    nested_value: { deep_key: string };
  }>();
}

{
  const result = camelOrSnakeToSnakeCase({
    toolResults: [{ inputSchema: { customerId: { type: 'string' } } }],
  });

  expectTypeOf(result.tool_results).toEqualTypeOf<
    Array<{ inputSchema: { customerId: { type: string } } }>
  >();
}

{
  const result = snakeOrCamelToCamelCase({
    outer_key: { nested_tools: [{ function_name: 'lookup' }] },
  });

  expectTypeOf(result).toEqualTypeOf<{
    outerKey: { nestedTools: Array<{ functionName: string }> };
  }>();
}
