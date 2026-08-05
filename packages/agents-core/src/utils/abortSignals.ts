type CombineAbortSignalsResult = {
  signal?: AbortSignal;
  cleanup: () => void;
};

type CombineAbortSignalsOptions = {
  onAbortSignalAnyError?: (error: unknown) => void;
};

class SiblingCancellationError extends Error {}

export function createSiblingCancellationError(): Error {
  return new SiblingCancellationError(
    'Cancelled because a sibling task failed.',
  );
}

export function isSiblingCancellationSignal(
  signal: AbortSignal | undefined,
): boolean {
  return signal?.reason instanceof SiblingCancellationError;
}

export function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  const DomExceptionCtor =
    typeof DOMException !== 'undefined' ? DOMException : undefined;
  return Boolean(
    DomExceptionCtor &&
    error instanceof DomExceptionCtor &&
    error.name === 'AbortError',
  );
}

export function combineAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): CombineAbortSignalsResult {
  return combineAbortSignalsWithOptions(signals);
}

export function combineAbortSignalsWithOptions(
  signals: (AbortSignal | undefined)[],
  options?: CombineAbortSignalsOptions,
): CombineAbortSignalsResult {
  const activeSignals = signals.filter(Boolean) as AbortSignal[];
  if (activeSignals.length === 0) {
    return {
      cleanup: () => {},
    };
  }

  const anyFn = (AbortSignal as any).any;
  if (typeof anyFn === 'function') {
    try {
      return {
        signal: anyFn(activeSignals),
        cleanup: () => {},
      };
    } catch (error) {
      options?.onAbortSignalAnyError?.(error);
      // Fall back to manual signal composition for runtimes without AbortSignal.any support.
    }
  }

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; handler: () => void }> = [];
  const abortCombined = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abortCombined(signal.reason);
      break;
    }
    const handler = () => abortCombined(signal.reason);
    signal.addEventListener('abort', handler, { once: true });
    listeners.push({ signal, handler });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const listener of listeners) {
        listener.signal.removeEventListener('abort', listener.handler);
      }
    },
  };
}
