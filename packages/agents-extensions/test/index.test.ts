import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { TwilioRealtimeTransportLayer } from '../src';
import type {
  MessageEvent as NodeMessageEvent,
  WebSocket as NodeWebSocket,
} from 'ws';

vi.mock('ws', () => {
  class FakeWebSocket {
    url: string;
    listeners: Record<string, ((ev: any) => void)[]> = {};
    constructor(url: string, _args?: any) {
      this.url = url;
      setTimeout(() => this._emit('open', {}));
    }
    addEventListener(type: string, listener: (ev: any) => void) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(listener);
    }
    send(_data: any) {}
    close() {
      this._emit('close', {});
    }
    private _emit(type: string, ev: any) {
      (this.listeners[type] || []).forEach((fn) => fn(ev));
    }
  }
  return { WebSocket: FakeWebSocket };
});

class FakeTwilioWebSocket extends EventEmitter {
  send = vi.fn();
  close = vi.fn();

  addEventListener(
    type: string,
    listener: (evt: MessageEvent | NodeMessageEvent) => void,
  ) {
    this.on(type, (evt) => listener(type === 'message' ? { data: evt } : evt));
  }
}

const asTwilioWebSocket = (
  socket: FakeTwilioWebSocket,
): WebSocket | NodeWebSocket => socket as unknown as WebSocket | NodeWebSocket;

const setAudioLengthMs = (
  transport: TwilioRealtimeTransportLayer,
  audioLengthMs: number,
): void => {
  (
    transport as unknown as {
      _audioLengthMs: number;
    }
  )._audioLengthMs = audioLengthMs;
};

describe('TwilioRealtimeTransportLayer', () => {
  test('should be available', () => {
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(new FakeTwilioWebSocket()),
    });
    expect(transport).toBeDefined();
  });

  test('malformed mark name does not produce NaN', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });

    const sendEventSpy = vi.spyOn(
      transport as TwilioRealtimeTransportLayer,
      'sendEvent',
    );

    await transport.connect({ apiKey: 'ek_test' });
    sendEventSpy.mockClear();

    const payload = { event: 'mark', mark: { name: 'badmark' } };
    twilio.emit('message', { toString: () => JSON.stringify(payload) });

    transport._interrupt(0, false);
    setAudioLengthMs(transport, 500);
    transport._interrupt(0, true);

    const call = sendEventSpy.mock.calls
      .filter((c) => c[0]?.type === 'conversation.item.truncate')
      .at(-1);
    expect(call?.[0].audio_end_ms).toBe(50);
  });

  test('interrupt clamps overshoot and emits integer audio_end_ms', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });

    const sendEventSpy = vi.spyOn(
      transport as TwilioRealtimeTransportLayer,
      'sendEvent',
    );

    await transport.connect({
      apiKey: 'ek_test',
      initialSessionConfig: { speed: 1.1 },
    });
    sendEventSpy.mockClear();

    setAudioLengthMs(transport, 20);
    transport._interrupt(0, true);

    const call = sendEventSpy.mock.calls
      .filter((c) => c[0]?.type === 'conversation.item.truncate')
      .at(-1);
    expect(call?.[0].audio_end_ms).toBe(20);
    expect(Number.isInteger(call?.[0].audio_end_ms)).toBe(true);
  });
});
