import { describe, expect, it, vi } from 'vitest';
import { AudioOnlyWebRtc } from '../src/client/audioOnlyWebRtc';
import { VoiceSessionCoordinator } from '../src/client/voiceSessionCoordinator';

function createHarness(
  onError = vi.fn(),
  remoteAudio = {
    play: vi.fn(async () => {}),
    srcObject: null as MediaProvider | null,
  },
) {
  const track = {
    enabled: true,
    kind: 'audio',
    readyState: 'live',
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const localStream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const remoteStream = {} as MediaStream;
  const peerConnection = {
    connectionState: 'new',
    localDescription: null as RTCSessionDescription | null,
    ontrack: null as ((event: RTCTrackEvent) => void) | null,
    addTrack: vi.fn(),
    close: vi.fn(),
    createDataChannel: vi.fn(() => {
      throw new Error('Data channels are forbidden.');
    }),
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' })),
    setLocalDescription: vi.fn(async function (
      this: { localDescription: RTCSessionDescriptionInit | null },
      description: RTCSessionDescriptionInit,
    ) {
      this.localDescription = description;
    }),
    setRemoteDescription: vi.fn(async () => {}),
  } as unknown as RTCPeerConnection;
  const getUserMedia = vi.fn(async () => localStream);
  const connection = new AudioOnlyWebRtc({
    onError,
    remoteAudio,
    createPeerConnection: () => peerConnection,
    getUserMedia,
  });

  return {
    connection,
    onError,
    localStream,
    peerConnection,
    remoteAudio,
    remoteStream,
    track,
    getUserMedia,
  };
}

function setConnectionState(
  peer: RTCPeerConnection,
  state: RTCPeerConnectionState,
) {
  Object.defineProperty(peer, 'connectionState', {
    configurable: true,
    value: state,
  });
  peer.onconnectionstatechange?.call(peer, new Event('connectionstatechange'));
}

describe('AudioOnlyWebRtc', () => {
  it.each(['peer failure', 'microphone ended', 'playback rejection'])(
    'routes %s after signaling through coordinator cleanup',
    async (failure) => {
      let fail!: () => void;
      const harness = createHarness(vi.fn(() => fail()));
      const eventStream = { close: vi.fn() };
      const closeRemoteSession = vi.fn(async () => {});
      const onStatus = vi.fn();
      const onControls = vi.fn();
      const coordinator = new VoiceSessionCoordinator({
        closeRemoteSession,
        createConnection: ({ onError }) => {
          fail = onError;
          return harness.connection;
        },
        exchangeOffer: vi.fn(async () => 'answer'),
        getCsrfToken: vi.fn(async () => 'csrf-token'),
        onControls,
        onStatus,
        openEvents: () => eventStream,
      });
      await coordinator.start();
      const oldListener = harness.peerConnection.onconnectionstatechange;
      if (failure === 'peer failure') {
        setConnectionState(harness.peerConnection, 'failed');
      } else if (failure === 'microphone ended') {
        Object.defineProperty(harness.track, 'readyState', { value: 'ended' });
        harness.track.onended?.call(harness.track, new Event('ended'));
      } else {
        harness.remoteAudio.play.mockRejectedValueOnce(
          new Error('Playback denied.'),
        );
        harness.peerConnection.ontrack?.call(harness.peerConnection, {
          streams: [harness.remoteStream],
        } as unknown as RTCTrackEvent);
      }
      await vi.waitFor(() =>
        expect(onControls.mock.lastCall?.[0].canStart).toBe(true),
      );

      expect(closeRemoteSession).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        'csrf-token',
      );
      expect(harness.track.stop).toHaveBeenCalledOnce();
      expect(harness.peerConnection.close).toHaveBeenCalledOnce();
      expect(eventStream.close).toHaveBeenCalledOnce();
      expect(harness.peerConnection.onconnectionstatechange).toBeNull();
      expect(harness.track.onended).toBeNull();
      expect(onStatus).toHaveBeenLastCalledWith('error');
      oldListener?.call(
        harness.peerConnection,
        new Event('connectionstatechange'),
      );
      expect(harness.onError).toHaveBeenCalledOnce();
    },
  );

  it('rejects a microphone that ended before acquisition completed', async () => {
    const harness = createHarness();
    Object.defineProperty(harness.track, 'readyState', { value: 'ended' });
    const exchange = vi.fn(async () => 'answer');
    await expect(harness.connection.connect(exchange)).rejects.toThrow(
      'microphone',
    );
    expect(exchange).not.toHaveBeenCalled();
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it('allows a transient disconnect to recover and expires a sustained disconnect', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await harness.connection.connect(async () => 'answer');
      setConnectionState(harness.peerConnection, 'disconnected');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(harness.onError).not.toHaveBeenCalled();
      setConnectionState(harness.peerConnection, 'connected');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.onError).not.toHaveBeenCalled();
      expect(harness.track.stop).not.toHaveBeenCalled();

      setConnectionState(harness.peerConnection, 'disconnected');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.onError).toHaveBeenCalledOnce();
      expect(harness.peerConnection.close).toHaveBeenCalledOnce();
      expect(harness.track.stop).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the disconnect timer when explicitly closed', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await harness.connection.connect(async () => 'answer');
      setConnectionState(harness.peerConnection, 'disconnected');
      harness.connection.close();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.onError).not.toHaveBeenCalled();
      expect(harness.track.stop).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('negotiates one audio track without creating a data channel', async () => {
    const harness = createHarness();
    const exchangeSdp = vi.fn(async () => 'answer-sdp');

    await harness.connection.connect(exchangeSdp);

    expect(harness.peerConnection.addTrack).toHaveBeenCalledWith(
      harness.track,
      harness.localStream,
    );
    expect(harness.peerConnection.createDataChannel).not.toHaveBeenCalled();
    expect(exchangeSdp).toHaveBeenCalledWith(
      'offer-sdp',
      expect.any(AbortSignal),
    );
    expect(harness.peerConnection.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'answer-sdp',
    });
  });

  it('plays the remote media stream delivered by WebRTC', async () => {
    const harness = createHarness();
    await harness.connection.connect(async () => 'answer-sdp');

    const ontrack = harness.peerConnection.ontrack;
    expect(ontrack).not.toBeNull();
    ontrack?.call(harness.peerConnection, {
      streams: [harness.remoteStream],
    } as unknown as RTCTrackEvent);

    expect(harness.remoteAudio.srcObject).toBe(harness.remoteStream);
    expect(harness.remoteAudio.play).toHaveBeenCalledOnce();
  });

  it('stops owned media and closes the peer on setup failure', async () => {
    const harness = createHarness();

    await expect(
      harness.connection.connect(async () => {
        throw new Error('signaling failed');
      }),
    ).rejects.toThrow('signaling failed');

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.peerConnection.close).toHaveBeenCalledOnce();
    expect(harness.remoteAudio.srcObject).toBeNull();
  });

  it('mutes the owned microphone track and closes idempotently', async () => {
    const harness = createHarness();
    await harness.connection.connect(async () => 'answer-sdp');

    harness.connection.setMuted(true);
    expect(harness.track.enabled).toBe(false);
    expect(harness.connection.muted).toBe(true);

    harness.connection.close();
    harness.connection.close();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.peerConnection.close).toHaveBeenCalledOnce();
  });

  it('invalidates setup while microphone acquisition is pending', async () => {
    let resolveMedia!: (stream: MediaStream) => void;
    const media = new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    });
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const createPeerConnection = vi.fn();
    const exchangeSdp = vi.fn(async () => 'answer-sdp');
    const connection = new AudioOnlyWebRtc({
      onError: vi.fn(),
      remoteAudio: { play: vi.fn(async () => {}), srcObject: null },
      createPeerConnection,
      getUserMedia: vi.fn(() => media),
    });

    const connecting = connection.connect(exchangeSdp);
    await Promise.resolve();
    connection.close();
    resolveMedia(stream);

    await expect(connecting).rejects.toThrow('closed');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(createPeerConnection).not.toHaveBeenCalled();
    expect(exchangeSdp).not.toHaveBeenCalled();
  });

  it('aborts an in-flight SDP exchange during close', async () => {
    const harness = createHarness();
    let exchangeSignal: AbortSignal | undefined;
    const exchangeSdp = vi.fn(
      (_offerSdp: string, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          exchangeSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const connecting = harness.connection.connect(exchangeSdp);
    await vi.waitFor(() => expect(exchangeSdp).toHaveBeenCalledOnce());

    harness.connection.close();

    await expect(connecting).rejects.toThrow('closed');
    expect(exchangeSignal?.aborted).toBe(true);
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.peerConnection.close).toHaveBeenCalledOnce();
  });

  it('rejects repeated use before acquiring another microphone', async () => {
    const harness = createHarness();
    let resolveMedia!: (stream: MediaStream) => void;
    harness.getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMedia = resolve;
        }),
    );
    const starting = harness.connection.connect(async () => 'answer');
    await expect(
      harness.connection.connect(async () => 'answer'),
    ).rejects.toThrow('new audio connection');
    harness.connection.close();
    await expect(
      harness.connection.connect(async () => 'answer'),
    ).rejects.toThrow('new audio connection');
    resolveMedia(harness.localStream);
    await expect(starting).rejects.toThrow('closed');
    expect(harness.getUserMedia).toHaveBeenCalledOnce();
  });

  it.each(['media acquisition', 'playback rejection'])(
    'does not let late %s clear a replacement session audio element',
    async (phase) => {
      const errors: Array<() => void> = [];
      const first = createHarness(vi.fn(() => errors[0]!()));
      const second = createHarness(
        vi.fn(() => errors[1]!()),
        first.remoteAudio,
      );
      let finishOld!: () => void;
      if (phase === 'media acquisition') {
        first.getUserMedia.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishOld = () => resolve(first.localStream);
            }),
        );
      } else {
        first.remoteAudio.play.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              finishOld = () => reject(new Error('Old playback failed.'));
            }),
        );
      }
      const helpers = [first, second];
      const closeRemoteSession = vi.fn(async () => {});
      const onControls = vi.fn();
      const coordinator = new VoiceSessionCoordinator({
        closeRemoteSession,
        createConnection({ onError }) {
          errors.push(onError);
          return helpers.shift()!.connection;
        },
        exchangeOffer: async () => 'answer',
        getCsrfToken: async () => 'token',
        onControls,
        onStatus: vi.fn(),
        openEvents: () => ({ close: vi.fn() }),
      });
      const starting = coordinator.start();
      if (phase === 'playback rejection') {
        await starting;
        first.peerConnection.ontrack?.call(first.peerConnection, {
          streams: [first.remoteStream],
        } as unknown as RTCTrackEvent);
      }
      await coordinator.stop();
      const closesBeforeReplacement = closeRemoteSession.mock.calls.length;
      await coordinator.start();
      second.peerConnection.ontrack?.call(second.peerConnection, {
        streams: [second.remoteStream],
      } as unknown as RTCTrackEvent);
      finishOld();
      await starting;
      await Promise.resolve();
      first.connection.close();

      expect(first.remoteAudio.srcObject).toBe(second.remoteStream);
      expect(first.track.stop).toHaveBeenCalledOnce();
      expect(second.track.stop).not.toHaveBeenCalled();
      expect(second.peerConnection.close).not.toHaveBeenCalled();
      expect(closeRemoteSession).toHaveBeenCalledTimes(closesBeforeReplacement);
      expect(onControls.mock.lastCall?.[0].canStart).toBe(false);
      await coordinator.stop();
    },
  );
});
