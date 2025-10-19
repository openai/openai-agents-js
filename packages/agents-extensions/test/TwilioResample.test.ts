import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { TwilioRealtimeTransportLayer } from '../src/TwilioRealtimeTransport';

import type { MessageEvent as NodeMessageEvent } from 'ws';
import type { MessageEvent } from 'undici-types';

// Mock the realtime package like other tests do so we can observe sendAudio, etc.
vi.mock('@openai/agents/realtime', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  const utils = {
    base64ToArrayBuffer: (b64: string) =>
      Uint8Array.from(Buffer.from(b64, 'base64')).buffer,
    arrayBufferToBase64: (buf: ArrayBuffer) =>
      Buffer.from(new Uint8Array(buf)).toString('base64'),
  };
  class FakeOpenAIRealtimeWebSocket extends EventEmitter {
    status: 'connected' | 'disconnected' = 'disconnected';
    currentItemId: string | null = null;
  }
  FakeOpenAIRealtimeWebSocket.prototype.connect = vi.fn(async function (
    this: any,
  ) {
    this.status = 'connected';
  });
  FakeOpenAIRealtimeWebSocket.prototype.sendAudio = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype.close = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype._interrupt = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype.updateSessionConfig = vi.fn();
  return { OpenAIRealtimeWebSocket: FakeOpenAIRealtimeWebSocket, utils };
});

class FakeTwilioWebSocket extends EventEmitter {
  send = vi.fn();
  close = vi.fn();
}

// @ts-expect-error - make the node EventEmitter compatible with the browser style used in the transport
FakeTwilioWebSocket.prototype.addEventListener = function (
  type: string,
  listener: (evt: MessageEvent | NodeMessageEvent) => void,
) {
  // When the transport registers addEventListener('message', ...) it expects the listener
  // to receive an object with a `.data` that responds to toString(). Tests below emit the
  // raw payload as the event argument and this wrapper synthesizes { data: evt }.
  this.on(type, (evt) => listener(type === 'message' ? { data: evt } : evt));
};

describe('TwilioRealtimeTransportLayer resampling hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('resampleIncoming is called and its result is passed to sendAudio', async () => {
    const resampleIncoming = vi.fn(
      async (data: ArrayBuffer, from?: string, to?: string) => {
        // ensure we receive the original data (we won't assert exact bytes here, just that the hook was called)
        _ = from;
        _ = to;
        return data;
      },
    );

    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
      resampleIncoming,
    });

    // connect the transport (mocks will set the OpenAI websocket to connected)
    await transport.connect({ apiKey: 'ek_test' } as any);

    // Grab the mocked OpenAIRealtimeWebSocket prototype to assert sendAudio was called with our resampled buffer
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);

    // Prepare a Twilio 'media' message (base64-encoded payload). Use small bytes.
    const originalBytes = Buffer.from([1, 2, 3]);
    const payloadB64 = originalBytes.toString('base64');
    const twilioMessage = {
      event: 'media',
      streamSid: 'FAKE',
      media: { payload: payloadB64 },
    };

    // Emit the message (the FakeTwilioWebSocket addEventListener wrapper will provide { data: evt })
    twilio.emit('message', { toString: () => JSON.stringify(twilioMessage) });

    // wait a tick for async handler to run
    await Promise.resolve();

    // resampleIncoming should have been called
    expect(resampleIncoming).toHaveBeenCalled();
    // sendAudio should have been called with the resampled buffer
    expect(sendAudioSpy).toHaveBeenCalled();
    const calledArg = sendAudioSpy.mock.calls[0][0] as ArrayBuffer;
    expect(Array.from(new Uint8Array(calledArg))).toEqual(
      Array.from(new Uint8Array(originalBytes)),
    );
  });

  test('resampleOutgoing is called and Twilio receives its result', async () => {
    const resampleOutgoing = vi.fn(
      async (data: ArrayBuffer, from?: string, to?: string) => {
        _ = from;
        _ = to;
        return data;
      },
    );

    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
      resampleOutgoing,
    });

    await transport.connect({ apiKey: 'ek_test' } as any);

    // set a currentItemId so the transport resets chunk count and emits marks like real usage
    // @ts-expect-error - we're setting a protected field for test
    transport.currentItemId = 'test-item';

    // Call the protected _onAudio to simulate outgoing audio from OpenAI -> Twilio
    const outgoingBuffer = new Uint8Array([10, 11, 12]).buffer;
    await transport['_onAudio']({
      responseId: 'FAKE_ID',
      type: 'audio',
      data: outgoingBuffer,
    });

    // twilio.send should have been called at least twice (media and mark). Inspect the first call (media)
    const sendCalls = vi.mocked(twilio.send).mock.calls;
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);

    const firstArg = sendCalls[0][0] as string;
    const parsed = JSON.parse(firstArg);
    expect(parsed.event).toBe('media');
    // verify media.payload decodes to the resampled bytes
    const decoded = Buffer.from(parsed.media.payload, 'base64');
    expect(Array.from(decoded)).toEqual(
      Array.from(new Uint8Array(outgoingBuffer)),
    );

    // ensure the outgoing resampler was called
    expect(resampleOutgoing).toHaveBeenCalled();
  });
});
