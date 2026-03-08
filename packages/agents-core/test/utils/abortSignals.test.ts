import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  combineAbortSignals,
  combineAbortSignalsWithOptions,
} from '../../src/utils/abortSignals';

describe('utils/abortSignals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns no signal when no signals are provided', () => {
    const result = combineAbortSignals(undefined, undefined);
    expect(result.signal).toBeUndefined();
    expect(() => result.cleanup()).not.toThrow();
  });

  it('uses AbortSignal.any when it succeeds', () => {
    const controller = new AbortController();
    const combinedSignal = new AbortController().signal;
    const anySpy = vi
      .spyOn(
        AbortSignal as typeof AbortSignal & { any: typeof AbortSignal.any },
        'any',
      )
      .mockReturnValue(combinedSignal);

    const result = combineAbortSignals(controller.signal);

    expect(anySpy).toHaveBeenCalledWith([controller.signal]);
    expect(result.signal).toBe(combinedSignal);
    expect(() => result.cleanup()).not.toThrow();
  });

  it('falls back when AbortSignal.any throws and propagates abort reasons', () => {
    const first = new AbortController();
    const second = new AbortController();
    const onAbortSignalAnyError = vi.fn();

    vi.spyOn(
      AbortSignal as typeof AbortSignal & { any: typeof AbortSignal.any },
      'any',
    ).mockImplementation(() => {
      throw new Error('AbortSignal.any failed');
    });

    const result = combineAbortSignalsWithOptions(
      [first.signal, second.signal],
      { onAbortSignalAnyError },
    );

    second.abort('manual-fallback');

    expect(onAbortSignalAnyError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'AbortSignal.any failed' }),
    );
    expect(result.signal?.aborted).toBe(true);
    expect(result.signal?.reason).toBe('manual-fallback');
  });

  it('aborts immediately when an input signal is already aborted', () => {
    const aborted = new AbortController();
    const active = new AbortController();
    aborted.abort('already-aborted');

    vi.spyOn(
      AbortSignal as typeof AbortSignal & { any: typeof AbortSignal.any },
      'any',
    ).mockImplementation(() => {
      throw new Error('AbortSignal.any failed');
    });

    const result = combineAbortSignalsWithOptions([
      aborted.signal,
      active.signal,
    ]);

    expect(result.signal?.aborted).toBe(true);
    expect(result.signal?.reason).toBe('already-aborted');
  });

  it('removes registered listeners during cleanup', () => {
    const makeSignal = (reason: string) => {
      const signal = {
        aborted: false,
        reason,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      return signal as unknown as AbortSignal;
    };

    const signal = makeSignal('unused');
    const otherSignal = makeSignal('other');

    vi.spyOn(
      AbortSignal as typeof AbortSignal & { any: typeof AbortSignal.any },
      'any',
    ).mockImplementation(() => {
      throw new Error('AbortSignal.any failed');
    });

    const result = combineAbortSignalsWithOptions([signal, otherSignal]);

    result.cleanup();

    expect((signal as any).removeEventListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    );
    expect((otherSignal as any).removeEventListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    );
  });
});
