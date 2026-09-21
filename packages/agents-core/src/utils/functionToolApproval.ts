import { UserError } from '../errors';

/** Internal configuration failure that must not become a manual approval. */
export class FunctionToolApprovalInputError extends UserError {
  constructor() {
    super(
      'Conditional tool approval requires copyable plain normalized input. Return plain data from the schema and resolve application objects inside execute.',
    );
  }
}

/**
 * Copy plain data for approval or execution without exposing retained input.
 * Reject other schema outputs before approval; validation must not run again
 * merely to obtain a second, potentially different, approval value.
 *
 * Shared by SDK runners through the internal utilities entry point.
 */
export function getFunctionToolApprovalInput(value: unknown): unknown {
  const unsupported = Symbol('unsupported approval input');
  const copies = new Map<object, object>();
  const copy = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      if (typeof input === 'function' || typeof input === 'symbol') {
        throw unsupported;
      }
      return input;
    }
    const prototype = Object.getPrototypeOf(input);
    const array = Array.isArray(input);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      throw unsupported;
    }
    const existing = copies.get(input);
    if (existing) {
      return existing;
    }
    const result = array ? [] : Object.create(prototype);
    copies.set(input, result);
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!('value' in descriptor)) {
        throw unsupported;
      }
      Object.defineProperty(result, key, {
        ...descriptor,
        value: copy(descriptor.value),
      });
    }
    if (!Object.isExtensible(input)) Object.preventExtensions(result);
    return result;
  };
  try {
    return copy(value);
  } catch {
    throw new FunctionToolApprovalInputError();
  }
}
