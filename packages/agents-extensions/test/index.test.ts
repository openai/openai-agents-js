import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { TwilioRealtimeTransportLayer } from '../src';

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

    transport._interrupt(0);

    const call = sendEventSpy.mock.calls.find(
      (c) => c[0]?.type === 'conversation.item.truncate',
    );
    expect(call?.[0].audio_end_ms).toBe(50);
  });
});
