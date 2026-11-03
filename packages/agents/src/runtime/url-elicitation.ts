/** Options for observing one issued URL request's matched completion. */
export interface NativeUrlCompletionOptions {
  /** A positive finite deadline for this wait, in milliseconds. */
  readonly timeoutMs: number;
  /** Cancels this observer without canceling other observers or the request. */
  readonly signal?: AbortSignal;
}

/** @internal Completion state does not confer permission to send a reply. */
export function createUrlCompletion(
  cancel: () => Promise<void>,
  probe?: () => Promise<boolean | null>,
) {
  let outcome: boolean | undefined;
  let resolve!: (completed: boolean) => void;
  const completion = new Promise<boolean>((done) => {
    resolve = done;
  });
  let cancelOwner: (() => Promise<void>) | undefined = cancel;
  let probeOwner = probe;
  let probing: Promise<void> | undefined;
  let retirement: Promise<void> | undefined;

  function settle(completed: boolean) {
    if (outcome !== undefined) return;
    outcome = completed;
    cancelOwner = undefined;
    probeOwner = undefined;
    resolve(completed);
  }

  function refresh(): Promise<void> {
    if (!probeOwner || outcome !== undefined) return Promise.resolve();
    const read = probeOwner;
    return (probing ??= Promise.resolve()
      .then(read)
      .then((status) => {
        if (status !== null) settle(status);
      })
      .finally(() => {
        probing = undefined;
      }));
  }

  function retire(): Promise<void> {
    if (retirement) return retirement;
    if (outcome !== undefined) return Promise.resolve();
    const stop = cancelOwner;
    settle(false);
    retirement = Promise.resolve().then(stop);
    return retirement;
  }

  async function wait({ timeoutMs, signal }: NativeUrlCompletionOptions) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new TypeError('timeoutMs must be a positive finite number');
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const started = performance.now();
    const deadline = new Promise<'deadline'>((done) => {
      const schedule = () => {
        const remaining = timeoutMs - (performance.now() - started);
        if (remaining <= 0) done('deadline');
        else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
      };
      schedule();
    });
    const aborted = new Promise<never>((_, reject) => {
      if (signal) {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      const selected = await Promise.race([
        completion,
        refresh().then(() => completion),
        deadline,
        aborted,
      ]);
      // A completion that won the same deadline turn remains authoritative.
      if (outcome === true) return;
      if (selected === 'deadline' && outcome === undefined) {
        const error = new DOMException(
          'URL completion timed out',
          'TimeoutError',
        );
        try {
          await retire();
        } catch (cause) {
          throw new AggregateError(
            [error, cause],
            'URL completion cleanup failed',
            {
              cause: error,
            },
          );
        }
        throw error;
      }
      await retirement;
      throw new TypeError('Native URL request is expired');
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    settle,
    retire,
    wait,
    refresh,
    pending: () => outcome === undefined,
    expired: () => outcome === false,
  };
}
