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

  const observer = new AbortController();
  const waiting = signal
    ? AbortSignal.any([signal, observer.signal])
    : observer.signal;
  let blocked = Promise.withResolvers<void>();
  const wakeIfBlocked = () => {
    if (signals.quota?.blocked) blocked.resolve();
  };
  signals.onChange(wakeIfBlocked, waiting);

  const native = turn.waitForAttention({ signal: waiting });
  try {
    for (;;) {
      wakeIfBlocked();
      const outcome = await Promise.race([native, blocked.promise]);
      if (outcome !== undefined) return outcome;
      waiting.throwIfAborted();
      // The account or expiry may have changed since the feed notified us.
      const quota = signals.quota;
      if (quota?.blocked) return { type: 'account_quota_blocked', quota };
      blocked = Promise.withResolvers<void>();
    }
  } finally {
    observer.abort();
    await native.catch(() => {});
  }
}
