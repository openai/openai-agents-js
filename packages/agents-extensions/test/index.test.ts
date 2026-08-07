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

describe('TwilioRealtimeTransportLayer', () => {
  test('should be available', () => {
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(new FakeTwilioWebSocket()),
    });
    expect(transport).toBeDefined();
  });

  test('ignores malformed mark names', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });

    const sendEventSpy = vi.spyOn(transport as any, 'sendEvent');

    await transport.connect({ apiKey: 'ek_test' });
    sendEventSpy.mockClear();

    const payload = { event: 'mark', mark: { name: 'badmark' } };
    twilio.emit('message', { toString: () => JSON.stringify(payload) });

    transport._interrupt(0, false);
    expect(
      sendEventSpy.mock.calls.filter(
        (call) => (call[0] as any)?.type === 'conversation.item.truncate',
      ),
    ).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      'Invalid mark name received. Mark data is redacted.',
    );
  });
});
