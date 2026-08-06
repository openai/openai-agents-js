import { UserError } from '../errors';

/**
 * Controls whether an eligible Responses API tool can be called directly by
 * the model or from a Programmatic Tool Calling program.
 */
export type ToolAllowedCaller = 'direct' | 'programmatic';

/**
 * A non-empty set of execution contexts allowed to invoke a Responses API
 * tool. Duplicate entries are rejected when tools are created.
 */
export type ToolAllowedCallers = readonly [
  ToolAllowedCaller,
  ...ToolAllowedCaller[],
];

export function normalizeToolAllowedCallers(
  allowedCallers: ToolAllowedCallers | undefined,
  toolName: string,
): ToolAllowedCallers | undefined {
  if (typeof allowedCallers === 'undefined') {
    return undefined;
  }

  const callers = allowedCallers as unknown;
  if (!Array.isArray(callers) || callers.length === 0) {
    throw new UserError(
      `Tool '${toolName}' allowedCallers must contain at least one caller.`,
    );
  }

  const invalidCallerIndex = callers.findIndex(
    (caller) => caller !== 'direct' && caller !== 'programmatic',
  );
  if (invalidCallerIndex !== -1) {
    const invalidCaller = callers[invalidCallerIndex];
    throw new UserError(
      `Tool '${toolName}' allowedCallers contains unsupported caller '${String(invalidCaller)}'.`,
    );
  }

  if (new Set(callers).size !== callers.length) {
    throw new UserError(
      `Tool '${toolName}' allowedCallers must not contain duplicate callers.`,
    );
  }

  return [...callers] as unknown as ToolAllowedCallers;
}
