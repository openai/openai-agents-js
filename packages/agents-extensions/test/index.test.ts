import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { TwilioRealtimeTransportLayer } from '../src';
import type { MessageEvent as NodeMessageEvent } from 'ws';

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
}

// @ts-expect-error - we're making the node event emitter compatible with the browser event emitter
FakeTwilioWebSocket.prototype.addEventListener = function (
  type: string,
  listener: (evt: MessageEvent | NodeMessageEvent) => void,
) {
  this.on(type, (evt) => listener(type === 'message' ? { data: evt } : evt));
};

describe('TwilioRealtimeTransportLayer', () => {
  test('should be available', () => {
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: {} as any,
    });
    expect(transport).toBeDefined();
  });

  test('malformed mark name does not produce NaN', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
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
    // @ts-expect-error - we're testing protected fields
    transport._audioLengthMs = 500;
    transport._interrupt(0, true);

    const call = sendEventSpy.mock.calls
      .filter((c) => c[0]?.type === 'conversation.item.truncate')
      .at(-1);
    expect(call?.[0].audio_end_ms).toBe(50);
  });

  test('interrupt clamps overshoot and emits integer audio_end_ms', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
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

    // @ts-expect-error - we're testing protected fields.
    transport._audioLengthMs = 20;
    transport._interrupt(0, true);

    const call = sendEventSpy.mock.calls
      .filter((c) => c[0]?.type === 'conversation.item.truncate')
      .at(-1);
    expect(call?.[0].audio_end_ms).toBe(20);
    expect(Number.isInteger(call?.[0].audio_end_ms)).toBe(true);
  });
});
