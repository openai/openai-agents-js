import { describe, expect, it, vi } from 'vitest';
import {
  VoiceSessionCoordinator,
  type VoiceConnection,
} from '../src/client/voiceSessionCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function connection(connect: VoiceConnection['connect']): VoiceConnection & {
  close: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
} {
  let muted = false;
  return {
    close: vi.fn(),
    connect: vi.fn(connect),
    get muted() {
      return muted;
    },
    setMuted(nextMuted) {
      muted = nextMuted;
    },
  };
}

describe('VoiceSessionCoordinator', () => {
  it('refreshes authentication immediately before exchanging the SDP offer', async () => {
    const getCsrfToken = vi.fn(async () => 'fresh-token');
    const exchangeOffer = vi.fn(async ({ onSessionCreated, token }) => {
      expect(token).toBe('fresh-token');
      await onSessionCreated('session-1');
      return 'answer';
    });
    const activeConnection = connection(async (exchangeSdp) => {
      expect(getCsrfToken).not.toHaveBeenCalled();
      await exchangeSdp('offer', new AbortController().signal);
    });
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession: vi.fn(async () => {}),
      createConnection: () => activeConnection,
      exchangeOffer,
      getCsrfToken,
      onControls: vi.fn(),
      onStatus: vi.fn(),
      openEvents: vi.fn(() => ({ close: vi.fn() })),
    });

    await coordinator.start();

    expect(getCsrfToken).toHaveBeenCalledOnce();
    expect(exchangeOffer).toHaveBeenCalledOnce();
    await coordinator.stop();
  });

  it('keeps a replacement active when a cancelled setup fails later', async () => {
    const oldSetup = deferred<void>();
    const oldConnection = connection(() => oldSetup.promise);
    const newConnection = connection(async (exchangeSdp) => {
      await exchangeSdp('new-offer', new AbortController().signal);
    });
    const connections = [oldConnection, newConnection];
    const eventStream = { close: vi.fn() };
    const statuses: string[] = [];
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession: vi.fn(async () => {}),
      createConnection: () => connections.shift()!,
      exchangeOffer: vi.fn(async ({ onSessionCreated }) => {
        await onSessionCreated('00000000-0000-4000-8000-000000000002');
        return 'new-answer';
      }),
      getCsrfToken: vi.fn(async () => 'csrf-token'),
      onControls: vi.fn(),
      onStatus: (status) => statuses.push(status),
      openEvents: vi.fn(() => eventStream),
    });

    const oldStart = coordinator.start();
    await vi.waitFor(() =>
      expect(oldConnection.connect).toHaveBeenCalledOnce(),
    );
    await coordinator.stop();
    await coordinator.start();

    oldSetup.reject(new Error('Old media acquisition failed.'));
    await oldStart;

    expect(oldConnection.close).toHaveBeenCalledOnce();
    expect(newConnection.close).not.toHaveBeenCalled();
    expect(eventStream.close).not.toHaveBeenCalled();
    expect(statuses.at(-1)).not.toBe('error');

    await coordinator.stop();
  });

  it('closes a server session when the SDP body fails after its headers', async () => {
    const activeConnection = connection(async (exchangeSdp) => {
      await exchangeSdp('offer', new AbortController().signal);
    });
    const closeRemoteSession = vi.fn(async () => {});
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession,
      createConnection: () => activeConnection,
      exchangeOffer: vi.fn(async ({ onSessionCreated }) => {
        await onSessionCreated('00000000-0000-4000-8000-000000000003');
        throw new Error('The SDP response body was interrupted.');
      }),
      getCsrfToken: vi.fn(async () => 'csrf-token'),
      onControls: vi.fn(),
      onStatus: vi.fn(),
      openEvents: vi.fn(() => ({ close: vi.fn() })),
    });

    await coordinator.start();

    expect(closeRemoteSession).toHaveBeenCalledOnce();
    expect(closeRemoteSession).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000003',
      'csrf-token',
    );
  });

  it('does not let an old stop overwrite a replacement status', async () => {
    const oldRemoteClose = deferred<void>();
    const connections = [
      connection(async (exchangeSdp) => {
        await exchangeSdp('old-offer', new AbortController().signal);
      }),
      connection(async (exchangeSdp) => {
        await exchangeSdp('new-offer', new AbortController().signal);
      }),
    ];
    let sessionNumber = 0;
    const statuses: string[] = [];
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession: vi.fn((sessionId) =>
        sessionId.endsWith('1') ? oldRemoteClose.promise : Promise.resolve(),
      ),
      createConnection: () => connections.shift()!,
      exchangeOffer: vi.fn(async ({ onSessionCreated }) => {
        sessionNumber += 1;
        await onSessionCreated(`session-${sessionNumber}`);
        return 'answer';
      }),
      getCsrfToken: vi.fn(async () => 'csrf-token'),
      onControls: vi.fn(),
      onStatus: (status) => statuses.push(status),
      openEvents: vi.fn(() => ({ close: vi.fn() })),
    });

    await coordinator.start();
    const oldStop = coordinator.stop();
    await coordinator.start();
    expect(statuses.at(-1)).toBe('connecting');

    oldRemoteClose.resolve();
    await oldStop;

    expect(statuses.at(-1)).toBe('connecting');
    await coordinator.stop();
  });
});
