import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';
import type { MessageEvent as NodeMessageEvent } from 'ws';

import { TwilioRealtimeTransportLayer } from '../src/TwilioRealtimeTransport';

class FakeTwilioWebSocket extends EventEmitter {
  send = vi.fn();
  close = vi.fn();
  readyState = 1;
}

FakeTwilioWebSocket.prototype.addEventListener = function (
  type: string,
  listener: (event: NodeMessageEvent) => void,
) {
  this.on(type, listener);
};

function createTransport() {
  const twilio = new FakeTwilioWebSocket();
  const transport = new TwilioRealtimeTransportLayer({
    twilioWebSocket: twilio as any,
  });
  return { transport, twilio };
}

describe('TwilioRealtimeTransportLayer.listen', () => {
  test('resolves with start data before the OpenAI session connects', async () => {
    const { transport, twilio } = createTransport();
    const startPromise = transport.listen();

    twilio.emit('message', {
      data: JSON.stringify({
        event: 'start',
        start: {
          streamSid: 'stream-123',
          callSid: 'call-123',
          customParameters: { store: 'Beacon' },
          mediaFormat: {
            encoding: 'audio/x-mulaw',
            sampleRate: 8_000,
            channels: 1,
          },
        },
      }),
    });

    await expect(startPromise).resolves.toMatchObject({
      streamSid: 'stream-123',
      callSid: 'call-123',
      customParameters: { store: 'Beacon' },
    });
    await expect(transport.listen()).resolves.toMatchObject({
      streamSid: 'stream-123',
      callSid: 'call-123',
    });
  });

  test('reuses the same pending listener promise', () => {
    const { transport } = createTransport();

    const first = transport.listen();
    const second = transport.listen();

    expect(second).toBe(first);
  });

  test('rejects when Twilio closes before the start event', async () => {
    const { transport, twilio } = createTransport();
    const startPromise = transport.listen();

    twilio.emit('close');

    await expect(startPromise).rejects.toThrow(
      'Twilio websocket closed before a start event was received.',
    );
    await expect(transport.listen()).rejects.toThrow(
      'Twilio websocket closed before a start event was received.',
    );
  });

  test('rejects when Twilio errors before the start event', async () => {
    const { transport, twilio } = createTransport();
    transport.on('error', () => {});
    const startPromise = transport.listen();
    const error = new Error('twilio failed');

    twilio.emit('error', error);

    await expect(startPromise).rejects.toBe(error);
  });
});
