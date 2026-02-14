type CombineAbortSignalsResult = {
  signal?: AbortSignal;
  cleanup: () => void;
};

type CombineAbortSignalsOptions = {
  onAbortSignalAnyError?: (error: unknown) => void;
};

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
