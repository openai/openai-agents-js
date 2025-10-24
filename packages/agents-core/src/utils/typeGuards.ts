import type { ZodObjectLike } from './zodCompat';
import { readZodDefinition, readZodType } from './zodCompat';

/**
 * Verifies that an input is a ZodObject without needing to have Zod at runtime since it's an
 * optional dependency.
 * @param input
 * @returns
 */
export function isZodObject(input: unknown): input is ZodObjectLike {
  const definition = readZodDefinition(input);
  if (!definition) {
    return false;
  }

  const type = readZodType(input);
  return type === 'object';
}

/**
 * Verifies that an input is an object with an `input` property.
 * @param input
 * @returns
 */
export function isAgentToolInput(input: unknown): input is {
  input: string;
} {
  return (
    typeof input === 'object' &&
    input !== null &&
    'input' in input &&
    typeof (input as any).input === 'string'
  );
}
