import type { JsonObjectSchema } from '../types';
import {
  assertOpenAIStrictToolSchemaPreservesOpenObjects,
  isJsonSchemaDepthError,
  prepareOpenAIStrictToolSchema,
} from './strictToolSchema';

export { isZodObject } from './typeGuards';
export { getSchemaAndParserFromInputType } from './tools';
export { stripStrictNullsForZodSchema } from './strictToolSchema';

/** Preserve unsupported schemas during opt-in batch conversion; depth errors remain fatal. */
export function tryPrepareOpenAIStrictToolSchema<
  T extends JsonObjectSchema<any>,
>(
  schema: T,
): { schema: T; normalizeInput: (value: unknown) => unknown } | undefined {
  try {
    assertOpenAIStrictToolSchemaPreservesOpenObjects(schema);
    return prepareOpenAIStrictToolSchema(schema);
  } catch (error) {
    if (isJsonSchemaDepthError(error)) throw error;
    return undefined;
  }
}
