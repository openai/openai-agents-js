import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIRealtimeWebRTC } from '../src/openaiRealtimeWebRtc';

class FakeRTCDataChannel extends EventTarget {
  sent: string[] = [];
  readyState = 'open';
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 'closed';
  }
}

let lastChannel: FakeRTCDataChannel | null = null;

class FakeRTCPeerConnection {
  ontrack: ((ev: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';

  createDataChannel(_name: string) {
    lastChannel = new FakeRTCDataChannel();
    // simulate async open event
    setTimeout(() => {
      this._simulateStateChange('connected');
      lastChannel?.dispatchEvent(new Event('open'));
    }, 0);
    return lastChannel as unknown as RTCDataChannel;
  }
  addTrack() {}
  async createOffer() {
    this._simulateStateChange('connecting');
    return { sdp: 'offer', type: 'offer' };
  }
  async setLocalDescription(_desc: any) {}
  async setRemoteDescription(_desc: any) {}
  close() {
    this._simulateStateChange('closed');
  }
  getSenders() {
    return [] as any;
  }

  _simulateStateChange(
    state:
      | 'new'
      | 'connecting'
      | 'connected'
      | 'disconnected'
      | 'failed'
      | 'closed',
  ) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    setTimeout(() => {
      if (this.onconnectionstatechange) {
        this.onconnectionstatechange();
      }
    }, 0);
  }
}

describe('OpenAIRealtimeWebRTC.interrupt', () => {
  const originals: Record<string, any> = {};

  beforeEach(() => {
    originals.RTCPeerConnection = (global as any).RTCPeerConnection;
    originals.navigator = (global as any).navigator;
    originals.document = (global as any).document;
    originals.fetch = (global as any).fetch;

    (global as any).RTCPeerConnection = FakeRTCPeerConnection as any;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getAudioTracks: () => [{ enabled: true }],
          }),
        },
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: { createElement: () => ({ autoplay: true }) },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => ({
        text: async () => 'answer',
        headers: {
          get: (headerKey: string) => {
            if (headerKey === 'Location') {
              return 'https://api.openai.com/v1/calls/rtc_u1_1234567890';
            }
            return null;
          },
        },
      }),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    (global as any).RTCPeerConnection = originals.RTCPeerConnection;
    Object.defineProperty(globalThis, 'navigator', {
      value: originals.navigator,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: originals.document,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: originals.fetch,
      configurable: true,
      writable: true,
    });
    lastChannel = null;
  });

  it('sends response.cancel when interrupting during a response', async () => {
    const rtc = new OpenAIRealtimeWebRTC();
    await rtc.connect({ apiKey: 'ek_test' });

    // ensure channel exists
    const channel = lastChannel as FakeRTCDataChannel;
    const event = new MessageEvent('message', {
      data: JSON.stringify({
        type: 'response.created',
        event_id: '1',
        response: {},
      }),
    });
    channel.dispatchEvent(event);

    rtc.interrupt();

    expect(channel.sent.length).toBe(3);
    expect(JSON.parse(channel.sent[0]).type).toBe('session.update');
    expect(JSON.parse(channel.sent[1])).toEqual({ type: 'response.cancel' });
    expect(JSON.parse(channel.sent[2])).toEqual({
      type: 'output_audio_buffer.clear',
    });
  });

  it('stops sending response.cancel once audio playback is done', async () => {
    const rtc = new OpenAIRealtimeWebRTC();
    await rtc.connect({ apiKey: 'ek_test' });

    const channel = lastChannel as FakeRTCDataChannel;
    channel.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'response.created',
          event_id: 'rc-1',
          response: {},
        }),
      }),
    );

    channel.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'response.output_audio.done',
          event_id: 'rc-done-1',
          item_id: 'item-1',
          content_index: 0,
          output_index: 0,
          response_id: 'resp-1',
        }),
      }),
    );

    channel.sent.length = 0;
    rtc.interrupt();

    expect(channel.sent).toHaveLength(1);
    expect(JSON.parse(channel.sent[0])).toEqual({
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
        lastChannel = new FakeRTCDataChannel();
        return lastChannel as unknown as RTCDataChannel;
      }
    }

    (global as any).RTCPeerConnection = FailingRTCPeerConnection as any;
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => {
        throw new Error('connect failed');
      },
      configurable: true,
      writable: true,
    });

    const rtc = new OpenAIRealtimeWebRTC();
    rtc.on('error', () => {});
    const events: string[] = [];
    rtc.on('connection_change', (status) => events.push(status));

    await expect(rtc.connect({ apiKey: 'ek_test' })).rejects.toThrow();
    expect(rtc.status).toBe('disconnected');
    expect(rtc.callId).toBeUndefined();
    expect(events).toEqual(['connecting', 'disconnected']);
  });

  it('closes mic on connection failure', async () => {
    const stop = vi.fn();
    class StopTrackPeerConnection extends FakeRTCPeerConnection {
      getSenders() {
        return [{ track: { stop } } as any];
      }
      createDataChannel(_name: string) {
        lastChannel = new FakeRTCDataChannel();
        return lastChannel as unknown as RTCDataChannel;
      }
    }

    (global as any).RTCPeerConnection = StopTrackPeerConnection as any;
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => {
        throw new Error('connect failed');
      },
      configurable: true,
      writable: true,
    });

    const rtc = new OpenAIRealtimeWebRTC();
    rtc.on('error', () => {});
    await expect(rtc.connect({ apiKey: 'ek_test' })).rejects.toThrow();

    expect(stop).toHaveBeenCalled();
    expect(rtc.status).toBe('disconnected');
    expect(rtc.callId).toBeUndefined();
  });

  it('mute toggles sender tracks', async () => {
    const trackState = { enabled: true };
    class TrackPeerConnection extends FakeRTCPeerConnection {
      getSenders() {
        return [{ track: trackState } as any];
      }
    }
    (global as any).RTCPeerConnection = TrackPeerConnection as any;
    const rtc = new OpenAIRealtimeWebRTC();
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

describe('OpenAIRealtimeWebRTC.connectionState', () => {
  const originals: Record<string, any> = {};

  beforeEach(() => {
    originals.RTCPeerConnection = (global as any).RTCPeerConnection;
    originals.navigator = (global as any).navigator;
    originals.document = (global as any).document;
    originals.fetch = (global as any).fetch;

    (global as any).RTCPeerConnection = FakeRTCPeerConnection as any;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getAudioTracks: () => [{ enabled: true }],
          }),
        },
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: { createElement: () => ({ autoplay: true }) },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => ({
        text: async () => 'answer',
        headers: {
          get: (headerKey: string) => {
            if (headerKey === 'Location') {
              return 'https://api.openai.com/v1/calls/rtc_u1_1234567890';
            }
            return null;
          },
        },
      }),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    (global as any).RTCPeerConnection = originals.RTCPeerConnection;
    Object.defineProperty(globalThis, 'navigator', {
      value: originals.navigator,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: originals.document,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: originals.fetch,
      configurable: true,
      writable: true,
    });
    lastChannel = null;
  });

  it('fires connection_change and disconnects on peer connection failure', async () => {
    const rtc = new OpenAIRealtimeWebRTC();
    const events: string[] = [];
    rtc.on('connection_change', (status) => events.push(status));
    await rtc.connect({ apiKey: 'ek_test' });
    expect(rtc.status).toBe('connected');
    expect(events).toEqual(['connecting', 'connected']);
    const pc = rtc.connectionState
      .peerConnection as unknown as FakeRTCPeerConnection;
    expect(pc).toBeInstanceOf(FakeRTCPeerConnection);
    pc._simulateStateChange('failed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rtc.status).toBe('disconnected');
    expect(events).toEqual(['connecting', 'connected', 'disconnected']);
  });

  it('migrates connection state handler when peer connection is replaced', async () => {
    class CustomFakePeerConnection extends FakeRTCPeerConnection {}
    const customPC = new CustomFakePeerConnection();

    const rtc = new OpenAIRealtimeWebRTC({
      changePeerConnection: async () => customPC as any,
    });

    const closeSpy = vi.spyOn(rtc, 'close');
    const events: string[] = [];
    rtc.on('connection_change', (status) => events.push(status));

    await rtc.connect({ apiKey: 'ek_test' });

    expect(rtc.status).toBe('connected');
    expect(rtc.connectionState.peerConnection).toBe(customPC as any);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(events).toEqual(['connecting', 'connected']);

    customPC._simulateStateChange('failed');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closeSpy).toHaveBeenCalled();
    expect(rtc.status).toBe('disconnected');
    expect(events).toEqual(['connecting', 'connected', 'disconnected']);
  });
});

describe('OpenAIRealtimeWebRTC.callId', () => {
  const originals: Record<string, any> = {};
  const callId = 'rtc_u1_1234567890';
  beforeEach(() => {
    originals.RTCPeerConnection = (global as any).RTCPeerConnection;
    originals.navigator = (global as any).navigator;
    originals.document = (global as any).document;
    originals.fetch = (global as any).fetch;

    (global as any).RTCPeerConnection = FakeRTCPeerConnection as any;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getAudioTracks: () => [{ enabled: true }],
          }),
        },
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: { createElement: () => ({ autoplay: true }) },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => ({
        text: async () => 'answer',
        headers: {
          get: (headerName: string) => {
            if (headerName === 'Location') {
              return 'https://api.openai.com/v1/calls/' + callId;
            }
            return null;
          },
        },
      }),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    (global as any).RTCPeerConnection = originals.RTCPeerConnection;
    Object.defineProperty(globalThis, 'navigator', {
      value: originals.navigator,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: originals.document,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: originals.fetch,
      configurable: true,
      writable: true,
    });
    lastChannel = null;
  });

  it('returns the callId', async () => {
    const rtc = new OpenAIRealtimeWebRTC();
    expect(rtc.callId).toBeUndefined();
    await rtc.connect({ apiKey: 'ek_test' });
    expect(rtc.callId).toBe(callId);
    rtc.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rtc.callId).toBeUndefined();
  });

  it('honors changePeerConnection hook and preserves callId', async () => {
    class CustomRTCPeerConnection extends FakeRTCPeerConnection {
      closed = false;
      close() {
        this.closed = true;
        super.close();
      }
    }

    (global as any).RTCPeerConnection = CustomRTCPeerConnection as any;

    const rtc = new OpenAIRealtimeWebRTC({
      changePeerConnection: async (pc) => {
        const custom = new CustomRTCPeerConnection();
        // carry over listeners from the original instance
        custom.onconnectionstatechange = pc.onconnectionstatechange as any;
        custom.ontrack = pc.ontrack as any;
        return custom as any;
      },
    });

    await rtc.connect({ apiKey: 'ek_test', model: 'rtc-model' });

    const state = rtc.connectionState;
    expect(state.peerConnection).toBeInstanceOf(CustomRTCPeerConnection);
    expect(rtc.callId).toBe(callId);

    rtc.close();
    expect((state.peerConnection as any).closed).toBe(true);
  });
});
