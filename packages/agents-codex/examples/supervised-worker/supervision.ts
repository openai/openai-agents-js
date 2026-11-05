import type { Turn } from '@openai/agents';

import type { AccountQuota, WorkerSignals } from './signals.js';

type WaitOptions = {
  signal?: AbortSignal;
  signals?: WorkerSignals;
};

type AccountQuotaBlocked = {
  type: 'account_quota_blocked';
  quota: AccountQuota;
};

/** Wait for the owned turn or for a current account block. Aborting leaves the turn running. */
export async function waitForWorkerAttention<
  Output,
  NativeId extends string | null,
>(
  turn: Turn<Output, NativeId>,
  { signal, signals }: WaitOptions = {},
): Promise<
  | Awaited<ReturnType<Turn<Output, NativeId>['waitForAttention']>>
  | AccountQuotaBlocked
> {
  if (!signals) return turn.waitForAttention({ signal });
  signal?.throwIfAborted();

  for (;;) {
    const observer = new AbortController();
    const waiting = signal
      ? AbortSignal.any([signal, observer.signal])
      : observer.signal;
    const blocked = Promise.withResolvers<void>();
    const wakeIfBlocked = () => {
      if (signals.quota?.blocked) blocked.resolve();
    };
    signals.onChange(wakeIfBlocked, waiting);

    const native = turn.waitForAttention({ signal: waiting }).catch((error) => {
      if (!observer.signal.aborted || error !== observer.signal.reason)
        throw error;
    });
    wakeIfBlocked();
    const outcome = await Promise.race([native, blocked.promise]).finally(() =>
      observer.abort(),
    );
    const settled = outcome ?? (await native);
    if (settled !== undefined) return settled;
    signal?.throwIfAborted();

    // This example pairs with the matching SDK build. Its owner hook is
    // internal and does not appear in the package's public declarations.
    const root = turn as typeof turn & { _rootResultReady(): boolean };
    if (root._rootResultReady()) return turn.waitForAttention({ signal });

    // The account or expiry may have changed while the passive waiter closed.
    const quota = signals.quota;
    if (quota?.blocked) return { type: 'account_quota_blocked', quota };
  }
}
