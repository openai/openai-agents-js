import type { ModelRequest } from './models';
import type { TokenUsage } from './run-events';

export type ProviderRequestAccounting =
  | { readonly operation: 'manage' | 'create' }
  | { readonly operation: 'dispatch'; readonly lineage: string }
  | {
      readonly operation: 'terminal';
      readonly lineage: string;
      readonly usage?: TokenUsage;
    };

type Account = (operation: ProviderRequestAccounting) => string | null;
const accounts = new WeakMap<ModelRequest, Account>();

export function bindProviderRequestAccounting(
  request: ModelRequest,
  account: Account,
): void {
  accounts.set(request, account);
}

export function accountProviderRequest(
  request: ModelRequest,
  operation: ProviderRequestAccounting,
): string | null {
  const account = accounts.get(request);
  if (!account)
    throw new TypeError('Hosted transport requires native request accounting');
  return account(operation);
}
