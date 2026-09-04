import { UserError } from '../errors';

export function requireBooleanApprovalResult(
  toolName: string,
  result: unknown,
): boolean {
  if (typeof result !== 'boolean') {
    throw new UserError(
      `Tool '${toolName}' needsApproval callback must return a boolean.`,
    );
  }
  return result;
}
