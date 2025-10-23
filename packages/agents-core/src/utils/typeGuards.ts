import type { ZodObject } from 'zod';

/**
 * Verifies that an input is a ZodObject without needing to have Zod at runtime since it's an
 * optional dependency.
 * @param input
 * @returns
 */
export function isZodObject(input: unknown): input is ZodObject<any> {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('_def' in input) ||
    typeof input._def !== 'object' ||
    input._def === null
  ) {
    return false;
  }

  const def = input._def as Record<string, unknown>;
  const typeName = typeof def.typeName === 'string' ? def.typeName : undefined;
  const type = typeof def.type === 'string' ? def.type : undefined;
  return typeName === 'ZodObject' || type === 'object';
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
