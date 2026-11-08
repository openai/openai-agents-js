import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeVoiceWebRTC } from '@openai/agents/voice/browser';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function microphone() {
  const track = Object.assign(new EventTarget(), {
    enabled: true,
    readyState: 'live',
    stop: vi.fn(),
  });
  return {
    track,
    stream: {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream,
  };
}
class Peer {
  static latest: Peer;
  localDescription: RTCSessionDescriptionInit | null = null;
  connectionState = 'new';
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channel = {
    onmessage: null as ((event: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    close: vi.fn(),
  };
  createDataChannel = vi.fn(() => this.channel);
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer' }));
  setLocalDescription = vi.fn(async (offer: RTCSessionDescriptionInit) => {
    this.localDescription = offer;
  });
  setRemoteDescription = vi.fn(
    async (_answer: RTCSessionDescriptionInit) => {},
  );
  close = vi.fn();
  constructor() {
    Peer.latest = this;
  }
}

describe('native-backed browser voice media', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', Peer);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exchanges SDP, observes data and preserves caller media after close', async () => {
    const mic = microphone();
    const audio = {
      srcObject: null as MediaStream | null,
      play: vi.fn(async () => {}),
    };
    const events = vi.fn();
    const exchange = vi.fn(async () => 'answer');
    const media = new NativeVoiceWebRTC({
      mediaStream: mic.stream,
      audioElement: audio,
      onTransportEvent: events,
    });
    await media.connect({ exchangeSdp: exchange });
    expect(exchange).toHaveBeenCalledWith('offer', expect.any(AbortSignal));
    expect(Peer.latest.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'answer',
    });
    expect(Peer.latest.createDataChannel).toHaveBeenCalledWith('oai-events');
    Peer.latest.channel.onmessage!({
      data: '{"type":"session.updated","unknown":7}',
    });
    expect(events).toHaveBeenCalledWith({
      type: 'session.updated',
      unknown: 7,
    });
    Peer.latest.ontrack!({ streams: [mic.stream] });
    expect(audio.play).toHaveBeenCalledOnce();
    media.setMuted(true);
    expect(media.muted).toBe(true);
    expect(mic.track.enabled).toBe(false);
    media.setMuted(false);
    expect(mic.track.enabled).toBe(true);
    media.close();
    media.close();
    expect(mic.track.stop).not.toHaveBeenCalled();
    expect(Peer.latest.close).toHaveBeenCalledOnce();
    expect(Peer.latest.channel.close).toHaveBeenCalledOnce();
    expect(audio.srcObject).toBeNull();
    await expect(media.connect({ exchangeSdp: exchange })).rejects.toThrow(
      'new NativeVoiceWebRTC',
    );
  });

  it('stops its acquired microphone on a failed exchange', async () => {
    const mic = microphone();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => mic.stream) },
    });
    const media = new NativeVoiceWebRTC({
      audioElement: { srcObject: null, play: async () => {} },
    });
    const failure = new Error('Native sideband was not ready');
    await expect(
      media.connect({
        exchangeSdp: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(mic.track.stop).toHaveBeenCalledOnce();
    expect(Peer.latest.close).toHaveBeenCalledOnce();
    expect(media.status).toBe('closed');
  });

  it('aborts pending exchange promptly and never applies a late answer', async () => {
    const mic = microphone();
    const answer = deferred<string>();
    let signal!: AbortSignal;
    const exchange = vi.fn((_sdp: string, input: AbortSignal) => {
      signal = input;
      return answer.promise;
    });
    const media = new NativeVoiceWebRTC({
      mediaStream: mic.stream,
      audioElement: { srcObject: null, play: async () => {} },
    });
    const connecting = media.connect({ exchangeSdp: exchange });
    const rejected = expect(connecting).rejects.toThrow('closed');
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    media.close();
    await rejected;
    expect(signal.aborted).toBe(true);
    answer.resolve('late');
    await answer.promise;
    await Promise.resolve();
    expect(Peer.latest.setRemoteDescription).not.toHaveBeenCalled();
    expect(mic.track.stop).not.toHaveBeenCalled();
  });

  it('stops an owned microphone acquired after close', async () => {
    const mic = microphone();
    const acquisition = deferred<MediaStream>();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => acquisition.promise },
    });
    const media = new NativeVoiceWebRTC({
      audioElement: { srcObject: null, play: async () => {} },
    });
    const connecting = media.connect({ exchangeSdp: async () => 'answer' });
    const rejected = expect(connecting).rejects.toThrow('closed');
    media.close();
    await rejected;
    acquisition.resolve(mic.stream);
    await vi.waitFor(() => expect(mic.track.stop).toHaveBeenCalledOnce());
  });

  it('closes on microphone end without taking caller track ownership', async () => {
    const mic = microphone();
    const onError = vi.fn();
    const media = new NativeVoiceWebRTC({
      mediaStream: mic.stream,
      audioElement: { srcObject: null, play: async () => {} },
      onError,
    });
    await media.connect({ exchangeSdp: async () => 'answer' });
    mic.track.dispatchEvent(new Event('ended'));
    expect(media.status).toBe('closed');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Voice microphone ended.' }),
    );
    expect(mic.track.stop).not.toHaveBeenCalled();
  });

  it('keeps transient disconnection alive and closes a terminal media failure', async () => {
    vi.useFakeTimers();
    const mic = microphone();
    const error = vi.fn();
    const media = new NativeVoiceWebRTC({
      mediaStream: mic.stream,
      audioElement: { srcObject: null, play: async () => {} },
      onError: error,
    });
    await media.connect({ exchangeSdp: async () => 'answer' });
    Peer.latest.connectionState = 'disconnected';
    Peer.latest.onconnectionstatechange!();
    expect(media.status).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(1000);
    Peer.latest.connectionState = 'connected';
    Peer.latest.onconnectionstatechange!();
    await vi.advanceTimersByTimeAsync(10000);
    expect(media.status).toBe('connected');
    expect(error).not.toHaveBeenCalled();
    Peer.latest.connectionState = 'failed';
    Peer.latest.onconnectionstatechange!();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Voice peer connection failed.' }),
    );
    expect(media.status).toBe('closed');
    expect(mic.track.stop).not.toHaveBeenCalled();
  });
});
