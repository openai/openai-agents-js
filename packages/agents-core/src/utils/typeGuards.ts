import type { ZodObject } from 'zod';

/**
 * Verifies that an input is a ZodObject without needing to have Zod at runtime since it's an
 * optional dependency.
 * @param input
 * @returns
 */

export function isZodObject(input: unknown): input is ZodObject<any> {
  return (
    typeof input === 'object' &&
    input !== null &&
    '_def' in input &&
    typeof input._def === 'object' &&
    input._def !== null &&
    'typeName' in input._def &&
    input._def.typeName === 'ZodObject'
  );
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
