import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeVoiceWebRTC } from '@openai/agents/voice/react-native';
import { connectReactNativeVoice } from '../../../examples/codex/react-native-voice';

function microphone() {
  const track = Object.assign(new EventTarget(), {
    enabled: true,
    readyState: 'live',
    stop: vi.fn(),
  });
  return {
    track,
    stream: { getAudioTracks: () => [track], getTracks: () => [track] },
  };
}
class MobilePeer {
  localDescription: { type: 'offer'; sdp: string } | null = null;
  connectionState = 'new';
  ontrack:
    | ((event: { streams: ReturnType<typeof microphone>['stream'][] }) => void)
    | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channel = {
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as (() => void) | null,
    onclose: null as (() => void) | null,
    close: vi.fn(),
  };
  createDataChannel = vi.fn(() => this.channel);
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({
    type: 'offer' as const,
    sdp: 'mobile-offer',
  }));
  setLocalDescription = vi.fn(async (offer: { type: 'offer'; sdp: string }) => {
    this.localDescription = offer;
  });
  setRemoteDescription = vi.fn(
    async (_answer: { type: 'answer'; sdp: string }) => {},
  );
  close = vi.fn();
}
function setup() {
  const mic = microphone();
  const peer = new MobilePeer();
  const remote = vi.fn();
  const events = vi.fn();
  const errors = vi.fn();
  const media = new NativeVoiceWebRTC({
    mediaStream: mic.stream,
    createPeerConnection: () => peer,
    onRemoteStream: remote,
    onTransportEvent: events,
    onError: errors,
  });
  return { mic, peer, media, remote, events, errors };
}
describe('app-owned React Native media', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['close', 'setup failure', 'media error'])(
    'releases the example-owned microphone once after %s',
    async (ending) => {
      const mic = microphone();
      const release = vi.fn();
      const stream = Object.assign(mic.stream, { release });
      const peers: MobilePeer[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('answer', {
              status: ending === 'setup failure' ? 500 : 200,
            }),
        ),
      );
      const opening = connectReactNativeVoice({
        webRTC: {
          RTCPeerConnection: class extends MobilePeer {
            constructor() {
              super();
              peers.push(this);
            }
          },
          mediaDevices: { getUserMedia: async () => stream },
        },
        endpoint: 'https://application.example/voice/sdp',
        appToken: 'synthetic-application-token',
        onRemoteStream: () => {},
      });
      if (ending === 'setup failure') {
        await expect(opening).rejects.toThrow('500');
      } else {
        const call = await opening;
        if (ending === 'media error') {
          peers[0]!.channel.onerror!();
          expect(release).toHaveBeenCalledOnce();
        }
        call.close();
        call.close();
      }
      expect(release).toHaveBeenCalledOnce();
      expect(peers).toHaveLength(1);
      expect(peers[0]!.close).toHaveBeenCalledOnce();
    },
  );
  it('uses injected WebRTC without DOM globals and waits for the server exchange', async () => {
    const { mic, peer, media, remote, events } = setup();
    let ready!: (sdp: string) => void;
    const exchange = vi.fn(
      (_sdp: string, _signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          ready = resolve;
        }),
    );
    const connected = media.connect({ exchangeSdp: exchange });
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    ready('native-sideband-ready-answer');
    await connected;
    expect(peer.addTrack).toHaveBeenCalledWith(mic.track, mic.stream);
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'native-sideband-ready-answer',
    });
    const speaker = microphone().stream;
    peer.ontrack!({ streams: [speaker] });
    expect(remote).toHaveBeenCalledWith(speaker);
    peer.channel.onmessage!({ data: '{"type":"session.updated"}' });
    expect(events).toHaveBeenCalledWith({ type: 'session.updated' });
    media.setMuted(true);
    expect(media.muted).toBe(true);
    media.setMuted(false);
    expect(media.muted).toBe(false);
    media.close();
    media.close();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
    expect(mic.track.stop).not.toHaveBeenCalled();
    expect(peer.ontrack).toBeNull();
    expect(peer.channel.onmessage).toBeNull();
  });
  it('aborts the server request and ignores an answer arriving after close', async () => {
    const { media, peer, mic } = setup();
    let answer!: (sdp: string) => void;
    let signal!: AbortSignal;
    const connected = media.connect({
      exchangeSdp: (_sdp, current) => {
        signal = current;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    const rejection = expect(connected).rejects.toThrow('closed');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    media.close();
    expect(signal.aborted).toBe(true);
    answer('late');
    await rejection;
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(mic.track.stop).not.toHaveBeenCalled();
  });
  it('cleans a failed exchange and keeps application microphone ownership', async () => {
    const { media, peer, mic } = setup();
    await expect(
      media.connect({
        exchangeSdp: async () => {
          throw new Error('server failed');
        },
      }),
    ).rejects.toThrow('server failed');
    expect(media.status).toBe('closed');
    expect(peer.close).toHaveBeenCalledOnce();
    expect(mic.track.stop).not.toHaveBeenCalled();
  });
  it('closes on remote sink failure without taking ownership of the microphone', async () => {
    const mic = microphone();
    const peer = new MobilePeer();
    const errors = vi.fn();
    const media = new NativeVoiceWebRTC({
      mediaStream: mic.stream,
      createPeerConnection: () => peer,
      onRemoteStream: () => {
        throw new Error('routing failed');
      },
      onError: errors,
    });
    await media.connect({ exchangeSdp: async () => 'answer' });
    peer.ontrack!({ streams: [mic.stream] });
    expect(media.status).toBe('closed');
    expect(errors).toHaveBeenCalledOnce();
    expect(mic.track.stop).not.toHaveBeenCalled();
  });
  it('closes when the microphone ends and leaves local track cleanup to the app', async () => {
    const { media, peer, mic } = setup();
    await media.connect({ exchangeSdp: async () => 'answer' });
    mic.track.dispatchEvent(new Event('ended'));
    expect(media.status).toBe('closed');
    expect(peer.close).toHaveBeenCalledOnce();
    expect(mic.track.stop).not.toHaveBeenCalled();
  });
  it('connects and preserves cancellation errors with a legacy mobile AbortSignal', async () => {
    class LegacyController {
      signal = Object.assign(new EventTarget(), { aborted: false });
      abort() {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        this.signal.dispatchEvent(new Event('abort'));
      }
    }
    vi.stubGlobal('AbortController', LegacyController);
    const first = setup();
    await first.media.connect({
      exchangeSdp: async (_sdp, signal) => {
        expect('throwIfAborted' in signal).toBe(false);
        expect('reason' in signal).toBe(false);
        return 'answer';
      },
    });
    first.media.close();
    const pending = setup();
    const connected = pending.media.connect({
      exchangeSdp: async () => new Promise<string>(() => {}),
    });
    const rejected = expect(connected).rejects.toThrow(
      'Voice media was closed',
    );
    await vi.waitFor(() =>
      expect(pending.peer.setLocalDescription).toHaveBeenCalled(),
    );
    pending.media.close();
    await rejected;
    expect(pending.mic.track.stop).not.toHaveBeenCalled();
  });
});
