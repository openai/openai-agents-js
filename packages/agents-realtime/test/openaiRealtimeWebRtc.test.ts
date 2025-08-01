import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { FakeRTCDataChannel, FakeRTCPeerConnection, lastChannelRef } =
  vi.hoisted(() => {
    let lastChannel: any = null;

    class FakeRTCDataChannel extends EventTarget {
      sent: string[] = [];
      readyState: RTCDataChannelState = 'open';
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 'closed';
      }
    }

    class FakeRTCPeerConnection {
      ontrack: ((ev: any) => void) | null = null;
      createDataChannel(_name: string) {
        lastChannel = new FakeRTCDataChannel();
        // simulate async open event
        setTimeout(() => lastChannel?.dispatchEvent(new Event('open')));
        return lastChannel as unknown as RTCDataChannel;
      }
      addTrack() {}
      async createOffer() {
        return { sdp: 'offer', type: 'offer' };
      }
      async setLocalDescription(_desc: any) {}
      async setRemoteDescription(_desc: any) {}
      close() {}
      getSenders() {
        return [] as any;
      }
    }

    return {
      FakeRTCDataChannel,
      FakeRTCPeerConnection,
      lastChannelRef: {
        get: () => lastChannel,
        set: (value: any) => {
          lastChannel = value;
        },
      },
    };
  });

vi.mock('@openai/agents-realtime/_shims', () => ({
  isBrowserEnvironment: () => false,
  RTCPeerConnection: FakeRTCPeerConnection,
  mediaDevices: {
    getUserMedia: async () => ({
      getAudioTracks: () => [{ enabled: true }],
    }),
  },
}));

import { OpenAIRealtimeWebRTC } from '../src';

describe('OpenAIRealtimeWebRTC', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ text: () => 'answer' });
    lastChannelRef.set(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    lastChannelRef.set(null);
  });

  it('sends response.cancel when interrupting during a response', async () => {
    const rtc = new OpenAIRealtimeWebRTC();
    await rtc.connect({ apiKey: 'ek_test' });

    const channel = lastChannelRef.get()!;
    channel.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'response.created',
          event_id: '1',
          response: {},
        }),
      }),
    );

    rtc.interrupt();

    expect(channel.sent).toHaveLength(3);
    expect(JSON.parse(channel.sent[0]).type).toBe('session.update');
    expect(JSON.parse(channel.sent[1])).toEqual({ type: 'response.cancel' });
    expect(JSON.parse(channel.sent[2])).toEqual({
      type: 'output_audio_buffer.clear',
    });
  });

  it('updates currentModel on connect', async () => {
    const rtc = new OpenAIRealtimeWebRTC();
    await rtc.connect({ apiKey: 'ek_test', model: 'rtc-model' });
    expect(rtc.currentModel).toBe('rtc-model');
  });

  it('resets state on connection failure', async () => {
    class FailingRTCPeerConnection extends FakeRTCPeerConnection {
      createDataChannel(_name: string) {
        // do not open the channel automatically
        lastChannelRef.set(new FakeRTCDataChannel());
        return lastChannelRef.get() as unknown as RTCDataChannel;
      }
    }

    global.fetch = vi.fn().mockRejectedValue(new Error('connect failed'));

    const rtc = new OpenAIRealtimeWebRTC({
      changePeerConnection: async () => new FailingRTCPeerConnection() as any,
    });

    const events: string[] = [];
    rtc.on('connection_change', (s) => events.push(s));
    rtc.on('error', () => {});

    await expect(rtc.connect({ apiKey: 'ek_test' })).rejects.toThrow();
    expect(rtc.status).toBe('disconnected');
    expect(events).toEqual(['connecting', 'disconnected']);
  });

  it('closes mic on connection failure', async () => {
    const stop = vi.fn();
    class StopTrackPeerConnection extends FakeRTCPeerConnection {
      getSenders() {
        return [{ track: { stop } }] as any;
      }
    }

    global.fetch = vi.fn().mockRejectedValue(new Error('connect failed'));

    const rtc = new OpenAIRealtimeWebRTC({
      changePeerConnection: async () => new StopTrackPeerConnection() as any,
    });
    rtc.on('error', () => {});
    await expect(rtc.connect({ apiKey: 'ek_test' })).rejects.toThrow();

    expect(stop).toHaveBeenCalled();
    expect(rtc.status).toBe('disconnected');
  });

  it('mute toggles sender tracks', async () => {
    const trackState = { enabled: true };
    class TrackPeerConnection extends FakeRTCPeerConnection {
      getSenders() {
        return [{ track: trackState } as any];
      }
    }
    const rtc = new OpenAIRealtimeWebRTC({
      changePeerConnection: async () => new TrackPeerConnection() as any,
    });
    await rtc.connect({ apiKey: 'ek_test' });
    rtc.mute(true);
    expect(trackState.enabled).toBe(false);
    rtc.mute(false);
    expect(trackState.enabled).toBe(true);
  });

  it('sendEvent throws when not connected', () => {
    const rtc = new OpenAIRealtimeWebRTC();
    expect(() => rtc.sendEvent({ type: 'test' } as any)).toThrow();
  });

  it('allows overriding the peer connection', async () => {
    class NewPeerConnection extends FakeRTCPeerConnection {}
    const custom = new NewPeerConnection();
    const rtc = new OpenAIRealtimeWebRTC({
      changePeerConnection: async () => custom as any,
    });
    await rtc.connect({ apiKey: 'ek_test' });
    expect(rtc.connectionState.peerConnection).toBe(custom as any);
  });
});
