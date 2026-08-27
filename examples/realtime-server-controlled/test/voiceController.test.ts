import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/server/sessionManager';
import {
  VoiceController,
  type ControllerSession,
  type VoiceControllerOptions,
} from '../src/server/voiceController';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createController(overrides: Partial<VoiceControllerOptions> = {}) {
  const hangup = vi.fn(async () => {});
  const sessions = new SessionManager({ hangup });
  const realtimeClose = vi.fn();
  const realtimeSession = {
    close: realtimeClose,
    connect: vi.fn(async () => {}),
    off: vi.fn(),
    on: vi.fn(),
    transport: { on: vi.fn() },
  } as unknown as ControllerSession;
  const options: VoiceControllerOptions = {
    apiKey: 'server-key',
    connectSideband: vi.fn(async () => {}),
    createCall: vi.fn(async () => ({
      answerSdp: 'answer-sdp',
      callId: 'rtc_test',
    })),
    createSession: vi.fn(() => realtimeSession),
    hangupDetachedCall: vi.fn(async () => {}),
    sessions,
    ...overrides,
  };
  return {
    controller: new VoiceController(options),
    hangup,
    options,
    realtimeClose,
    realtimeSession,
    sessions,
  };
}

const startOptions = {
  offerSdp: 'offer-sdp',
  ownerId: 'owner-1',
  safetyIdentifier: 'safe-user-id',
  sessionId: '00000000-0000-4000-8000-000000000001',
};

describe('VoiceController', () => {
  it('returns the answer only after Sideband setup completes', async () => {
    const ready = deferred<void>();
    const harness = createController({
      connectSideband: vi.fn(() => ready.promise),
    });
    let resolved = false;

    const starting = harness.controller.start(startOptions).then((result) => {
      resolved = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    ready.resolve();
    await expect(starting).resolves.toEqual({
      answerSdp: 'answer-sdp',
      sessionId: startOptions.sessionId,
    });
    expect(resolved).toBe(true);
    await harness.sessions.closeAll();
  });

  it('closes the SDK session and attached call after setup failure', async () => {
    const harness = createController({
      connectSideband: vi.fn(async () => {
        throw new Error('sideband failed');
      }),
    });

    await expect(harness.controller.start(startOptions)).rejects.toThrow(
      'sideband failed',
    );
    expect(harness.realtimeClose).toHaveBeenCalledOnce();
    expect(harness.hangup).toHaveBeenCalledOnce();
    expect(harness.hangup).toHaveBeenCalledWith('rtc_test');
  });

  it('hangs up a call returned after its local reservation closed', async () => {
    const call = deferred<{ answerSdp: string; callId: string }>();
    const harness = createController({
      createCall: vi.fn(() => call.promise),
    });
    const starting = harness.controller.start(startOptions);

    await Promise.resolve();
    await harness.sessions.closeAll();
    call.resolve({ answerSdp: 'answer-sdp', callId: 'rtc_late' });

    await expect(starting).rejects.toThrow('closed during call creation');
    expect(harness.options.hangupDetachedCall).toHaveBeenCalledOnce();
    expect(harness.options.hangupDetachedCall).toHaveBeenCalledWith('rtc_late');
    expect(harness.options.connectSideband).not.toHaveBeenCalled();
  });

  it('hangs up a call returned after the browser cancels setup', async () => {
    const call = deferred<{ answerSdp: string; callId: string }>();
    const abortController = new AbortController();
    const harness = createController({
      createCall: vi.fn(() => call.promise),
    });
    const starting = harness.controller.start({
      ...startOptions,
      signal: abortController.signal,
    });

    await Promise.resolve();
    abortController.abort(new Error('The browser cancelled setup.'));
    call.resolve({ answerSdp: 'answer-sdp', callId: 'rtc_after-abort' });

    await expect(starting).rejects.toThrow('browser cancelled setup');
    expect(harness.options.hangupDetachedCall).toHaveBeenCalledOnce();
    expect(harness.options.hangupDetachedCall).toHaveBeenCalledWith(
      'rtc_after-abort',
    );
    expect(harness.options.connectSideband).not.toHaveBeenCalled();
  });

  it('does not create a call after cancellation arrives before setup', async () => {
    const harness = createController();
    await harness.sessions.cancel(startOptions.sessionId, startOptions.ownerId);

    await expect(harness.controller.start(startOptions)).rejects.toThrow(
      'voice session setup was cancelled',
    );

    expect(harness.options.createCall).not.toHaveBeenCalled();

    const replacementSessionId = '00000000-0000-4000-8000-000000000002';
    await expect(
      harness.controller.start({
        ...startOptions,
        sessionId: replacementSessionId,
      }),
    ).resolves.toEqual({
      answerSdp: 'answer-sdp',
      sessionId: replacementSessionId,
    });
    await harness.sessions.closeAll();
  });

  it('projects transport events instead of exposing the raw payload', () => {
    const sessionListeners = new Map<string, (event: unknown) => void>();
    const transportListeners = new Map<string, () => void>();
    const session = {
      close: vi.fn(),
      connect: vi.fn(),
      off: vi.fn(),
      on: vi.fn((event: string, listener: (event: unknown) => void) => {
        sessionListeners.set(event, listener);
      }),
      transport: {
        on: vi.fn((event: string, listener: () => void) => {
          transportListeners.set(event, listener);
        }),
      },
    } as unknown as ControllerSession;
    const callbacks = {
      onDisconnected: vi.fn(),
      onError: vi.fn(),
      onPublicEvent: vi.fn(),
    };
    VoiceController.wireSessionEvents(session, callbacks);

    sessionListeners.get('transport_event')?.({
      type: 'response.output_audio.delta',
      delta: 'private-audio',
    });
    sessionListeners.get('transport_event')?.({
      type: 'session.updated',
      session: { instructions: 'private' },
    });

    expect(callbacks.onPublicEvent).toHaveBeenCalledOnce();
    expect(callbacks.onPublicEvent).toHaveBeenCalledWith({
      type: 'app.agent.state',
      state: 'speaking',
    });
    transportListeners.get('disconnected')?.();
    expect(callbacks.onDisconnected).toHaveBeenCalledOnce();
  });
});
