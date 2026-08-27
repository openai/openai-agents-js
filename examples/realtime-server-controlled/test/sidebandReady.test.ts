import { describe, expect, it, vi } from 'vitest';
import {
  connectSidebandAndWaitForReady,
  type SidebandSession,
} from '../src/server/sidebandReady';

function createSession() {
  const listeners = new Set<(event: unknown) => void>();
  const session: SidebandSession = {
    connect: vi.fn(async () => {}),
    on: vi.fn((_event, listener) => listeners.add(listener)),
    off: vi.fn((_event, listener) => listeners.delete(listener)),
  };
  return {
    emit(event: unknown) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    listeners,
    session,
  };
}

describe('connectSidebandAndWaitForReady', () => {
  it('does not resolve until the initial session.updated acknowledgement', async () => {
    const harness = createSession();
    let resolved = false;
    const connecting = connectSidebandAndWaitForReady(harness.session, {
      apiKey: 'server-key',
      callId: 'rtc_test',
    }).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(harness.session.connect).toHaveBeenCalledWith({
      apiKey: 'server-key',
      callId: 'rtc_test',
    });

    harness.emit({ type: 'session.updated' });
    await connecting;
    expect(resolved).toBe(true);
    expect(harness.listeners.size).toBe(0);
  });

  it('times out and removes the temporary listener', async () => {
    vi.useFakeTimers();
    try {
      const harness = createSession();
      const connecting = connectSidebandAndWaitForReady(harness.session, {
        apiKey: 'server-key',
        callId: 'rtc_test',
        timeoutMs: 10,
      });
      const rejection = expect(connecting).rejects.toThrow('Timed out');

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(harness.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
