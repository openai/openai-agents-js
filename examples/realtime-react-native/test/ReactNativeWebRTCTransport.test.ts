import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webrtc = vi.hoisted(() => {
  type Listener = (event: { data?: unknown }) => void;
  const failures = {
    createDataChannel: null as Error | null,
  };

  class FakeTrack {
    enabled = true;
    stop = vi.fn();
  }

  class FakeMediaStream {
    readonly track = new FakeTrack();

    getAudioTracks() {
      return [this.track];
    }

    getTracks() {
      return [this.track];
    }
  }

  class FakeDataChannel {
    readyState: 'connecting' | 'open' | 'closed' = 'connecting';
    readonly sent: string[] = [];
    #listeners = new Map<string, Listener[]>();

    addEventListener(type: string, listener: Listener) {
      const listeners = this.#listeners.get(type) ?? [];
      listeners.push(listener);
      this.#listeners.set(type, listeners);
    }

    send(data: string) {
      this.sent.push(data);
    }

    open() {
      this.readyState = 'open';
      this.emit('open');
    }

    message(value: unknown) {
      this.emit('message', { data: JSON.stringify(value) });
    }

    close() {
      this.readyState = 'closed';
      this.emit('close');
    }

    emit(type: string, event: { data?: unknown } = {}) {
      for (const listener of this.#listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  class FakePeerConnection {
    connectionState = 'new';
    readonly dataChannel = new FakeDataChannel();
    readonly addTrack = vi.fn();
    readonly addTransceiver = vi.fn();
    readonly createOffer = vi.fn(async () => ({
      type: 'offer' as const,
      sdp: 'offer-sdp',
    }));
    readonly setLocalDescription = vi.fn(async () => {});
    readonly setRemoteDescription = vi.fn(async () => {});
    #listeners = new Map<string, Listener[]>();

    constructor() {
      peers.push(this);
    }

    createDataChannel() {
      if (failures.createDataChannel) {
        throw failures.createDataChannel;
      }
      return this.dataChannel;
    }

    addEventListener(type: string, listener: Listener) {
      const listeners = this.#listeners.get(type) ?? [];
      listeners.push(listener);
      this.#listeners.set(type, listeners);
    }

    close() {
      this.connectionState = 'closed';
      this.emit('connectionstatechange');
    }

    emit(type: string) {
      for (const listener of this.#listeners.get(type) ?? []) {
        listener({});
      }
    }
  }

  const peers: FakePeerConnection[] = [];
  const getUserMedia = vi.fn<() => Promise<FakeMediaStream>>();

  return {
    FakeMediaStream,
    FakePeerConnection,
    failures,
    getUserMedia,
    peers,
  };
});

vi.mock('react-native-webrtc', () => ({
  MediaStream: webrtc.FakeMediaStream,
  RTCPeerConnection: webrtc.FakePeerConnection,
  mediaDevices: { getUserMedia: webrtc.getUserMedia },
}));

import { ReactNativeWebRTCTransport } from '../src/ReactNativeWebRTCTransport';

describe('ReactNativeWebRTCTransport connection ownership', () => {
  beforeEach(() => {
    webrtc.peers.length = 0;
    webrtc.failures.createDataChannel = null;
    webrtc.getUserMedia.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('answer-sdp', { status: 200 })),
    );
  });

  it('closes the peer when data channel creation fails', async () => {
    webrtc.failures.createDataChannel = new Error(
      'Data channel creation failed.',
    );
    const transport = new ReactNativeWebRTCTransport();

    await expect(transport.connect({ apiKey: 'ek_test' })).rejects.toThrow(
      'Data channel creation failed.',
    );

    expect(webrtc.peers).toHaveLength(1);
    expect(webrtc.peers[0]?.connectionState).toBe('closed');
    expect(transport.status).toBe('disconnected');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('allows reconnect while an earlier API key request is still pending', async () => {
    const firstKey = deferred<string>();
    const transport = new ReactNativeWebRTCTransport();
    const firstConnect = transport.connect({ apiKey: () => firstKey.promise });

    transport.close();
    const secondMedia = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(secondMedia.promise);
    const secondConnect = transport.connect({ apiKey: 'ek_second' });
    await expect(firstConnect).rejects.toThrow(
      'The WebRTC connection was closed.',
    );
    const repeatedConnect = transport.connect({ apiKey: 'ek_unused' });
    const secondPeer = await nextPeer(0);

    await flushMicrotasks();
    expect(webrtc.peers).toHaveLength(1);
    const secondStream = await completeConnection(
      secondConnect,
      secondPeer,
      secondMedia,
    );
    await repeatedConnect;
    firstKey.resolve('ek_first');
    await flushMicrotasks();

    transport.sendEvent({ type: 'input_audio_buffer.clear' });
    expect(webrtc.peers).toHaveLength(1);
    expect(transport.status).toBe('connected');
    expect(secondPeer.connectionState).not.toBe('closed');
    expect(secondPeer.dataChannel.sent.at(-1)).toContain(
      '"type":"input_audio_buffer.clear"',
    );
    expect(secondStream.track.stop).not.toHaveBeenCalled();
  });

  it('allows reconnect when a connecting listener closes the first attempt', async () => {
    const firstKey = deferred<string>();
    let closeFirstAttempt = true;
    const transport = new ReactNativeWebRTCTransport();
    transport.on('connection_change', (status) => {
      if (status === 'connecting' && closeFirstAttempt) {
        closeFirstAttempt = false;
        transport.close();
      }
    });

    const firstConnect = transport.connect({ apiKey: () => firstKey.promise });
    await expect(firstConnect).rejects.toThrow(
      'The WebRTC connection was closed.',
    );

    const secondMedia = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(secondMedia.promise);
    const secondConnect = transport.connect({ apiKey: 'ek_second' });
    const secondPeer = await nextPeer(0);
    await completeConnection(secondConnect, secondPeer, secondMedia);

    firstKey.resolve('ek_first');
    await flushMicrotasks();
    expect(transport.status).toBe('connected');
    expect(webrtc.peers).toHaveLength(1);
  });

  it('does not let a stale media completion close a newer connection', async () => {
    const firstMedia = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    const secondMedia = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia
      .mockReturnValueOnce(firstMedia.promise)
      .mockReturnValueOnce(secondMedia.promise);

    const transport = new ReactNativeWebRTCTransport();
    const firstConnect = transport.connect({ apiKey: 'ek_first' });
    const firstPeer = await nextPeer(0);

    transport.close();
    await expect(firstConnect).rejects.toThrow(
      'The WebRTC connection was closed.',
    );
    expect(firstPeer.connectionState).toBe('closed');
    expect(firstPeer.dataChannel.readyState).toBe('closed');

    const secondConnect = transport.connect({ apiKey: 'ek_second' });
    const secondPeer = await nextPeer(1);
    const secondStream = await completeConnection(
      secondConnect,
      secondPeer,
      secondMedia,
    );

    const staleStream = new webrtc.FakeMediaStream();
    firstMedia.resolve(staleStream);
    await flushMicrotasks();
    firstPeer.connectionState = 'failed';
    firstPeer.emit('connectionstatechange');
    firstPeer.dataChannel.emit('error');

    transport.sendEvent({ type: 'input_audio_buffer.clear' });
    expect(staleStream.track.stop).toHaveBeenCalledOnce();
    expect(firstPeer.dataChannel.readyState).toBe('closed');
    expect(transport.status).toBe('connected');
    expect(secondPeer.connectionState).not.toBe('closed');
    expect(secondPeer.dataChannel.sent.at(-1)).toContain(
      '"type":"input_audio_buffer.clear"',
    );
    expect(secondStream.track.stop).not.toHaveBeenCalled();
  });

  it('keeps a newer failure disconnected after a stale attempt completes', async () => {
    const firstMedia = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    const secondMedia = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia
      .mockReturnValueOnce(firstMedia.promise)
      .mockReturnValueOnce(secondMedia.promise);

    const transport = new ReactNativeWebRTCTransport();
    const firstConnect = transport.connect({ apiKey: 'ek_first' });
    const firstPeer = await nextPeer(0);
    transport.close();
    await expect(firstConnect).rejects.toThrow();

    const secondConnect = transport.connect({ apiKey: 'ek_second' });
    const secondPeer = await nextPeer(1);
    secondMedia.reject(new Error('Microphone unavailable.'));
    await expect(secondConnect).rejects.toThrow('Microphone unavailable.');

    const staleStream = new webrtc.FakeMediaStream();
    firstMedia.resolve(staleStream);
    await flushMicrotasks();

    expect(staleStream.track.stop).toHaveBeenCalledOnce();
    expect(firstPeer.connectionState).toBe('closed');
    expect(firstPeer.dataChannel.readyState).toBe('closed');
    expect(secondPeer.connectionState).toBe('closed');
    expect(secondPeer.dataChannel.readyState).toBe('closed');
    expect(transport.status).toBe('disconnected');
  });

  it('does not set a local description after close during offer creation', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    const offer = deferred<{ type: 'offer'; sdp: string }>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    peer.createOffer.mockReturnValueOnce(offer.promise);
    media.resolve(new webrtc.FakeMediaStream());
    await waitFor(() => peer.createOffer.mock.calls.length === 1);

    transport.close();
    offer.resolve({ type: 'offer', sdp: 'offer-sdp' });

    await expect(connection).rejects.toThrow(
      'The WebRTC connection was closed.',
    );
    expect(peer.setLocalDescription).not.toHaveBeenCalled();
    expect(peer.connectionState).toBe('closed');
  });

  it('rejects connection when a status listener closes the transport', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connectedListener = vi.fn();
    transport.on('connected', connectedListener);
    transport.on('connection_change', (status) => {
      if (status === 'connected') {
        transport.close();
      }
    });
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    peer.dataChannel.open();
    media.resolve(new webrtc.FakeMediaStream());
    await waitFor(() =>
      peer.dataChannel.sent.some((event) =>
        event.includes('"type":"session.update"'),
      ),
    );
    peer.dataChannel.message({
      type: 'session.updated',
      session: { id: 'session_1' },
    });

    await expect(connection).rejects.toThrow(
      'The WebRTC connection was closed.',
    );
    expect(connectedListener).not.toHaveBeenCalled();
    expect(transport.status).toBe('disconnected');
    expect(peer.connectionState).toBe('closed');
  });

  it('does not update tracing after a raw-event listener closes', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    await completeConnection(connection, peer, media);
    transport.on('*', (event) => {
      if (event.type === 'session.created') {
        transport.close();
      }
    });

    expect(() =>
      peer.dataChannel.message({
        type: 'session.created',
        session: { id: 'session_1', tracing: 'auto' },
      }),
    ).not.toThrow();
    expect(transport.status).toBe('disconnected');
  });

  it('does not carry stale response state into a reconnect', async () => {
    const firstMedia = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    const secondMedia = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia
      .mockReturnValueOnce(firstMedia.promise)
      .mockReturnValueOnce(secondMedia.promise);

    const transport = new ReactNativeWebRTCTransport();
    const firstConnect = transport.connect({ apiKey: 'ek_first' });
    const firstPeer = await nextPeer(0);
    await completeConnection(firstConnect, firstPeer, firstMedia);
    transport.on('*', (event) => {
      if (event.type === 'response.created') {
        transport.close();
      }
    });
    firstPeer.dataChannel.message({
      type: 'response.created',
      response: { id: 'response_1' },
    });

    const secondConnect = transport.connect({ apiKey: 'ek_second' });
    const secondPeer = await nextPeer(1);
    await completeConnection(secondConnect, secondPeer, secondMedia);
    const sentBeforeInterrupt = secondPeer.dataChannel.sent.length;
    transport.interrupt();

    expect(
      secondPeer.dataChannel.sent
        .slice(sentBeforeInterrupt)
        .map((event) => JSON.parse(event).type),
    ).toEqual(['output_audio_buffer.clear']);
  });

  it('defers a follow-up response until cancellation completes', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    await completeConnection(connection, peer, media);
    peer.dataChannel.sent.length = 0;

    peer.dataChannel.message({
      type: 'response.created',
      response: { id: 'response_1' },
    });
    transport.interrupt();
    transport.sendMessage('Follow up', {});
    await flushMicrotasks();

    expect(
      peer.dataChannel.sent.map((event) => JSON.parse(event).type),
    ).toEqual([
      'response.cancel',
      'output_audio_buffer.clear',
      'conversation.item.create',
    ]);

    peer.dataChannel.message({
      type: 'response.done',
      response: { id: 'response_1' },
    });
    await flushMicrotasks();

    expect(
      peer.dataChannel.sent.map((event) => JSON.parse(event).type),
    ).toEqual([
      'response.cancel',
      'output_audio_buffer.clear',
      'conversation.item.create',
      'response.create',
    ]);
  });

  it('queues a second immediate message behind the transmitted create', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    await completeConnection(connection, peer, media);
    peer.dataChannel.sent.length = 0;

    transport.sendMessage('First message', {});
    transport.sendMessage('Second message', {});
    await flushMicrotasks();

    expect(
      peer.dataChannel.sent.map((event) => JSON.parse(event).type),
    ).toEqual([
      'conversation.item.create',
      'response.create',
      'conversation.item.create',
    ]);

    peer.dataChannel.message({
      type: 'response.created',
      response: { id: 'response_1' },
    });
    peer.dataChannel.message({
      type: 'response.done',
      response: { id: 'response_1' },
    });
    await flushMicrotasks();

    expect(
      peer.dataChannel.sent.map((event) => JSON.parse(event).type),
    ).toEqual([
      'conversation.item.create',
      'response.create',
      'conversation.item.create',
      'response.create',
    ]);
  });

  it('retries later automatic requests after a coalesced create fails', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    transport.on('error', () => {});
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    await completeConnection(connection, peer, media);
    peer.dataChannel.sent.length = 0;

    peer.dataChannel.message({
      type: 'response.created',
      response: { id: 'response_1' },
    });
    transport.sendMessage('First follow-up', {});
    transport.sendMessage('Second follow-up', {});
    peer.dataChannel.message({
      type: 'response.done',
      response: { id: 'response_1' },
    });
    await flushMicrotasks();

    const firstCreate = peer.dataChannel.sent
      .map((event) => JSON.parse(event))
      .find((event) => event.type === 'response.create');
    expect(firstCreate).toEqual({
      type: 'response.create',
      event_id: expect.any(String),
    });

    peer.dataChannel.message({
      type: 'error',
      error: {
        event_id: firstCreate.event_id,
        message: 'The response.create request failed.',
      },
    });
    await flushMicrotasks();

    const responseCreates = peer.dataChannel.sent
      .map((event) => JSON.parse(event))
      .filter((event) => event.type === 'response.create');
    expect(responseCreates).toHaveLength(2);
    expect(responseCreates[1]).toEqual({
      type: 'response.create',
      event_id: expect.any(String),
    });
    expect(responseCreates[1].event_id).not.toBe(firstCreate.event_id);
  });

  it('advances queued creates after a synchronous send failure', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const errors: unknown[] = [];
    transport.on('error', (event) => {
      errors.push(event.error);
      transport.requestResponse({ instructions: 'Observer override' });
    });
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    await completeConnection(connection, peer, media);
    peer.dataChannel.sent.length = 0;

    peer.dataChannel.message({
      type: 'response.created',
      response: { id: 'response_1' },
    });
    transport.requestResponse({ instructions: 'First override' });
    transport.requestResponse({ instructions: 'Second override' });
    vi.spyOn(peer.dataChannel, 'send').mockImplementationOnce(() => {
      throw new Error('Data channel send failed.');
    });

    peer.dataChannel.message({
      type: 'response.done',
      response: { id: 'response_1' },
    });
    await flushMicrotasks();

    expect(errors).toEqual([
      expect.objectContaining({ message: 'Data channel send failed.' }),
    ]);
    expect(
      peer.dataChannel.sent
        .map((event) => JSON.parse(event))
        .filter((event) => event.type === 'response.create'),
    ).toEqual([
      {
        type: 'response.create',
        event_id: expect.any(String),
        response: { instructions: 'Second override' },
      },
    ]);

    peer.dataChannel.message({
      type: 'response.created',
      response: { id: 'response_2' },
    });
    peer.dataChannel.message({
      type: 'response.done',
      response: { id: 'response_2' },
    });
    await flushMicrotasks();

    expect(
      peer.dataChannel.sent
        .map((event) => JSON.parse(event))
        .filter((event) => event.type === 'response.create'),
    ).toEqual([
      {
        type: 'response.create',
        event_id: expect.any(String),
        response: { instructions: 'Second override' },
      },
      {
        type: 'response.create',
        event_id: expect.any(String),
        response: { instructions: 'Observer override' },
      },
    ]);
  });

  it('keeps the connection open when a transient disconnection recovers', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    const stream = await completeConnection(connection, peer, media);
    vi.useFakeTimers();

    peer.connectionState = 'disconnected';
    peer.emit('connectionstatechange');
    await vi.advanceTimersByTimeAsync(4_999);
    peer.connectionState = 'connected';
    peer.emit('connectionstatechange');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(transport.status).toBe('connected');
    expect(peer.dataChannel.readyState).toBe('open');
    expect(peer.connectionState).toBe('connected');
    expect(stream.track.stop).not.toHaveBeenCalled();
  });

  it('closes when a disconnection exceeds the recovery grace period', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    const stream = await completeConnection(connection, peer, media);
    vi.useFakeTimers();

    peer.connectionState = 'disconnected';
    peer.emit('connectionstatechange');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(transport.status).toBe('disconnected');
    expect(peer.dataChannel.readyState).toBe('closed');
    expect(peer.connectionState).toBe('closed');
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('cleans up when an error observer throws', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    const stream = await completeConnection(connection, peer, media);
    transport.on('error', () => {
      throw new Error('Observer failed.');
    });

    expect(() => peer.dataChannel.emit('error')).not.toThrow();
    expect(transport.status).toBe('disconnected');
    expect(peer.dataChannel.readyState).toBe('closed');
    expect(peer.connectionState).toBe('closed');
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('cleans up before a disconnected observer throws', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    const stream = await completeConnection(connection, peer, media);
    transport.on('connection_change', (status) => {
      if (status === 'disconnected') {
        throw new Error('Observer failed.');
      }
    });

    expect(() => transport.close()).toThrow('Observer failed.');
    expect(transport.status).toBe('disconnected');
    expect(peer.dataChannel.readyState).toBe('closed');
    expect(peer.connectionState).toBe('closed');
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('continues cleanup when a resource close throws', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    const stream = await completeConnection(connection, peer, media);
    vi.spyOn(peer.dataChannel, 'close').mockImplementationOnce(() => {
      peer.dataChannel.readyState = 'closed';
      throw new Error('Data channel close failed.');
    });

    expect(() => transport.close()).toThrow('Data channel close failed.');
    expect(transport.status).toBe('disconnected');
    expect(peer.connectionState).toBe('closed');
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('guards cleanup errors raised by a terminal peer callback', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    const stream = await completeConnection(connection, peer, media);
    const errors: unknown[] = [];
    transport.on('error', (event) => errors.push(event.error));
    transport.on('connection_change', (status) => {
      if (status === 'disconnected') {
        throw new Error('Observer failed.');
      }
    });

    peer.connectionState = 'failed';
    expect(() => peer.emit('connectionstatechange')).not.toThrow();

    expect(transport.status).toBe('disconnected');
    expect(peer.dataChannel.readyState).toBe('closed');
    expect(peer.connectionState).toBe('closed');
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      expect.objectContaining({
        message: 'The WebRTC peer connection failed.',
      }),
      expect.objectContaining({ message: 'Observer failed.' }),
    ]);
  });

  it('guards cleanup errors raised by a terminal data-channel callback', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    const stream = await completeConnection(connection, peer, media);
    const errors: unknown[] = [];
    transport.on('error', (event) => errors.push(event.error));
    transport.on('connection_change', (status) => {
      if (status === 'disconnected') {
        throw new Error('Observer failed.');
      }
    });

    expect(() => peer.dataChannel.close()).not.toThrow();

    expect(transport.status).toBe('disconnected');
    expect(peer.connectionState).toBe('closed');
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      expect.objectContaining({ message: 'Observer failed.' }),
    ]);
  });

  it('reconnects while a stale remote description is still pending', async () => {
    const firstMedia = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    const secondMedia = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    const firstRemoteDescription = deferred<void>();
    webrtc.getUserMedia
      .mockReturnValueOnce(firstMedia.promise)
      .mockReturnValueOnce(secondMedia.promise);

    const transport = new ReactNativeWebRTCTransport();
    const firstConnect = transport.connect({ apiKey: 'ek_first' });
    const firstPeer = await nextPeer(0);
    firstPeer.setRemoteDescription.mockReturnValueOnce(
      firstRemoteDescription.promise,
    );
    firstPeer.dataChannel.open();
    const firstStream = new webrtc.FakeMediaStream();
    firstMedia.resolve(firstStream);
    await waitFor(() => firstPeer.setRemoteDescription.mock.calls.length === 1);

    firstPeer.dataChannel.emit('error');
    await expect(firstConnect).rejects.toThrow(
      'The WebRTC connection was closed.',
    );
    expect(firstPeer.connectionState).toBe('closed');
    expect(firstPeer.dataChannel.readyState).toBe('closed');
    expect(firstStream.track.stop).toHaveBeenCalledOnce();

    const secondConnect = transport.connect({ apiKey: 'ek_second' });
    const secondPeer = await nextPeer(1);
    const secondStream = await completeConnection(
      secondConnect,
      secondPeer,
      secondMedia,
    );

    firstRemoteDescription.resolve();
    await flushMicrotasks();
    transport.sendEvent({ type: 'input_audio_buffer.clear' });
    expect(transport.status).toBe('connected');
    expect(secondPeer.connectionState).not.toBe('closed');
    expect(secondPeer.dataChannel.sent.at(-1)).toContain(
      '"type":"input_audio_buffer.clear"',
    );
    expect(secondStream.track.stop).not.toHaveBeenCalled();
  });

  it('does not initialize media for a text-only connection', async () => {
    const transport = new ReactNativeWebRTCTransport({
      enableAudio: false,
    });
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    peer.dataChannel.open();
    await waitFor(() =>
      peer.dataChannel.sent.some((event) =>
        event.includes('"type":"session.update"'),
      ),
    );
    peer.dataChannel.message({
      type: 'session.updated',
      session: { id: 'session_1' },
    });
    await connection;

    expect(webrtc.getUserMedia).not.toHaveBeenCalled();
    expect(peer.addTrack).not.toHaveBeenCalled();
    expect(peer.addTransceiver).toHaveBeenCalledWith('audio', {
      direction: 'inactive',
    });
    expect(transport.status).toBe('connected');
  });

  it('captures and attaches microphone audio by default', async () => {
    const media = deferred<InstanceType<typeof webrtc.FakeMediaStream>>();
    webrtc.getUserMedia.mockReturnValueOnce(media.promise);

    const transport = new ReactNativeWebRTCTransport();
    const connection = transport.connect({ apiKey: 'ek_test' });
    const peer = await nextPeer(0);
    const stream = await completeConnection(connection, peer, media);

    expect(webrtc.getUserMedia).toHaveBeenCalledWith({
      audio: true,
      video: false,
    });
    expect(peer.addTrack).toHaveBeenCalledWith(stream.track, stream);
    expect(peer.addTransceiver).not.toHaveBeenCalled();
  });
});

async function completeConnection(
  connection: Promise<void>,
  peer: InstanceType<typeof webrtc.FakePeerConnection>,
  media: ReturnType<
    typeof deferred<InstanceType<typeof webrtc.FakeMediaStream>>
  >,
): Promise<InstanceType<typeof webrtc.FakeMediaStream>> {
  const stream = new webrtc.FakeMediaStream();
  peer.dataChannel.open();
  media.resolve(stream);
  await waitFor(() =>
    peer.dataChannel.sent.some((event) =>
      event.includes('"type":"session.update"'),
    ),
  );
  peer.dataChannel.message({
    type: 'session.updated',
    session: { id: 'session_1' },
  });
  await connection;
  return stream;
}

async function nextPeer(
  index: number,
): Promise<InstanceType<typeof webrtc.FakePeerConnection>> {
  await waitFor(() => webrtc.peers.length > index);
  return webrtc.peers[index];
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Condition did not become true.');
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
