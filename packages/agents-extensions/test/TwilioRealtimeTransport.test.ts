import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'events';
import { TwilioRealtimeTransportLayer } from '../src/TwilioRealtimeTransport';

import type {
  MessageEvent as NodeMessageEvent,
  WebSocket as NodeWebSocket,
} from 'ws';
import type { MessageEvent } from 'undici-types';

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
    if (this.status !== 'disconnected') {
      throw new Error('Transport is already connected.');
    }
    this.status = 'connected';
  });
  FakeOpenAIRealtimeWebSocket.prototype.sendAudio = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype.sendEvent = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype._cancelResponse = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype._afterAudioDoneEvent = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype.close = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype.updateSessionConfig = vi.fn();
  return { OpenAIRealtimeWebSocket: FakeOpenAIRealtimeWebSocket, utils };
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

const setCurrentItemId = (
  transport: TwilioRealtimeTransportLayer,
  currentItemId: string,
): void => {
  (
    transport as unknown as {
      currentItemId: string;
    }
  ).currentItemId = currentItemId;
};

const base64 = (data: string) => Buffer.from(data).toString('base64');

const startTwilioStream = (
  twilio: FakeTwilioWebSocket,
  mediaFormat: unknown = {
    encoding: 'audio/x-mulaw',
    sampleRate: 8_000,
    channels: 1,
  },
) => {
  twilio.emit('message', {
    toString: () =>
      JSON.stringify({
        event: 'start',
        start: { streamSid: 'sid', mediaFormat },
      }),
  });
};

describe('TwilioRealtimeTransportLayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('_setInputAndOutputAudioFormat defaults g711', () => {
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(new FakeTwilioWebSocket()),
    });
    expect(transport._setInputAndOutputAudioFormat()).toEqual({
      inputAudioFormat: 'g711_ulaw',
      outputAudioFormat: 'g711_ulaw',
    });
    expect(
      transport._setInputAndOutputAudioFormat({ inputAudioFormat: 'pcm16' }),
    ).toEqual({
      inputAudioFormat: 'g711_ulaw',
      outputAudioFormat: 'g711_ulaw',
    });
  });

  test('_setInputAndOutputAudioFormat preserves nested audio config', () => {
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(new FakeTwilioWebSocket()),
    });

    expect(
      transport._setInputAndOutputAudioFormat({
        instructions: 'hi',
        audio: {
          input: {
            turnDetection: {
              type: 'server_vad',
              silenceDurationMs: 300,
            },
          },
          output: {
            voice: 'alloy',
          },
        },
      } as any),
    ).toEqual({
      instructions: 'hi',
      audio: {
        input: {
          format: 'g711_ulaw',
          turnDetection: {
            type: 'server_vad',
            silenceDurationMs: 300,
          },
        },
        output: {
          format: 'g711_ulaw',
          voice: 'alloy',
        },
      },
    });
  });

  test('coerces explicit PCM session formats after handoff', () => {
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(new FakeTwilioWebSocket()),
    });

    expect(
      transport._setInputAndOutputAudioFormat({
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24_000 } },
          output: { format: { type: 'audio/pcm', rate: 24_000 } },
        },
      } as any),
    ).toEqual({
      audio: {
        input: { format: 'g711_ulaw' },
        output: { format: 'g711_ulaw' },
      },
    });
  });

  test('preserves explicitly compatible G.711 formats', () => {
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(new FakeTwilioWebSocket()),
    });

    expect(
      transport._setInputAndOutputAudioFormat({
        audio: {
          input: { format: { type: 'audio/pcmu' } },
          output: { format: 'g711_alaw' },
        },
      } as any),
    ).toEqual({
      audio: {
        input: { format: { type: 'audio/pcmu' } },
        output: { format: 'g711_alaw' },
      },
    });
  });

  test('validates the Twilio input inactivity timeout', () => {
    expect(
      () =>
        new TwilioRealtimeTransportLayer({
          twilioWebSocket: asTwilioWebSocket(new FakeTwilioWebSocket()),
          inputAudioInactivityTimeoutMs: 0,
        }),
    ).toThrow(
      'inputAudioInactivityTimeoutMs must be a positive finite number no greater than 2147483647, or null.',
    );
    expect(
      () =>
        new TwilioRealtimeTransportLayer({
          twilioWebSocket: asTwilioWebSocket(new FakeTwilioWebSocket()),
          inputAudioInactivityTimeoutMs: 2_147_483_648,
        }),
    ).toThrow(RangeError);
  });

  test('connect handles messages and events', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    const closeSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.close);
    const cancelSpy = vi.mocked(
      OpenAIRealtimeWebSocket.prototype._cancelResponse,
    );

    const mediaPayload = base64('a');
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'media', media: { payload: mediaPayload } }),
    });
    expect(sendAudioSpy).toHaveBeenCalledTimes(1);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'start', start: { streamSid: 'sid' } }),
    });
    twilio.emit('message', {
      toString: () => JSON.stringify({ event: 'mark', mark: { name: 'u:5' } }),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Invalid mark name received. Mark data is redacted.',
    );
    transport.emit('response.created', {
      response: { id: 'response-1' },
    } as any);
    transport._interrupt(0);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(twilio.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'clear', streamSid: 'sid' }),
    );

    const errListener = vi.fn();
    transport.on('error', errListener);
    twilio.emit('message', { toString: () => 'bad{' });
    expect(errListener).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Error parsing message:', 'object');
    errorSpy.mockRestore();
    warnSpy.mockRestore();

    twilio.emit('close');
    expect(closeSpy).toHaveBeenCalled();
    twilio.emit('error', new Error('boom'));
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  test('pads missing Twilio media timestamps with PCMU silence', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('a'.repeat(160)), timestamp: '100' },
        }),
    });
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('b'.repeat(160)), timestamp: '140' },
        }),
    });

    expect(sendAudioSpy).toHaveBeenCalledTimes(3);
    expect(new Uint8Array(sendAudioSpy.mock.calls[1][0])).toEqual(
      new Uint8Array(160).fill(0xff),
    );
    expect(Buffer.from(sendAudioSpy.mock.calls[2][0]).toString()).toBe(
      'b'.repeat(160),
    );
  });

  test('does not synthesize silence for unsupported Twilio media formats', async () => {
    vi.useFakeTimers();
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio, {
      encoding: 'audio/pcm',
      sampleRate: 8_000,
      channels: 1,
    });

    for (const [payload, timestamp] of [
      ['a', '100'],
      ['b', '10000'],
    ]) {
      twilio.emit('message', {
        toString: () =>
          JSON.stringify({
            event: 'media',
            media: { payload: base64(payload.repeat(160)), timestamp },
          }),
      });
    }
    transport.emit('input_audio_buffer.speech_started', {} as any);
    await vi.advanceTimersByTimeAsync(750);

    expect(sendAudioSpy).toHaveBeenCalledTimes(2);
  });

  test.each([null, '', ' ', 'not-a-number'])(
    'does not infer silence from an invalid Twilio timestamp %#',
    async (timestamp) => {
      const twilio = new FakeTwilioWebSocket();
      const transport = new TwilioRealtimeTransportLayer({
        twilioWebSocket: asTwilioWebSocket(twilio),
      });
      await transport.connect({ apiKey: 'ek_test' } as any);
      const { OpenAIRealtimeWebSocket } =
        await import('@openai/agents/realtime');
      const sendAudioSpy = vi.mocked(
        OpenAIRealtimeWebSocket.prototype.sendAudio,
      );
      startTwilioStream(twilio);

      twilio.emit('message', {
        toString: () =>
          JSON.stringify({
            event: 'media',
            media: { payload: base64('a'.repeat(160)), timestamp },
          }),
      });
      twilio.emit('message', {
        toString: () =>
          JSON.stringify({
            event: 'media',
            media: { payload: base64('b'.repeat(160)), timestamp: '10000' },
          }),
      });

      expect(sendAudioSpy).toHaveBeenCalledTimes(2);
    },
  );

  test('resets timestamp inference after Twilio media moves backward', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio);

    for (const [payload, timestamp] of [
      ['a', '100'],
      ['b', '80'],
      ['c', '140'],
    ]) {
      twilio.emit('message', {
        toString: () =>
          JSON.stringify({
            event: 'media',
            media: { payload: base64(payload.repeat(160)), timestamp },
          }),
      });
    }

    expect(sendAudioSpy).toHaveBeenCalledTimes(3);
  });

  test('caps inferred Twilio timestamp silence at ten seconds', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('a'.repeat(160)), timestamp: '100' },
        }),
    });
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('b'.repeat(160)), timestamp: '20120' },
        }),
    });

    expect(sendAudioSpy).toHaveBeenCalledTimes(3);
    expect(new Uint8Array(sendAudioSpy.mock.calls[1][0])).toEqual(
      new Uint8Array(80_000).fill(0xff),
    );
  });

  test('pads active speech after Twilio input becomes inactive', async () => {
    vi.useFakeTimers();
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('a'.repeat(160)), timestamp: '100' },
        }),
    });
    transport.emit('input_audio_buffer.speech_started', {} as any);
    await vi.advanceTimersByTimeAsync(749);
    expect(sendAudioSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(sendAudioSpy).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(sendAudioSpy.mock.calls[1][0])).toEqual(
      new Uint8Array(8_000).fill(0xff),
    );

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('b'.repeat(160)), timestamp: '5100' },
        }),
    });

    expect(sendAudioSpy).toHaveBeenCalledTimes(3);
    expect(Buffer.from(sendAudioSpy.mock.calls[2][0]).toString()).toBe(
      'b'.repeat(160),
    );
  });

  test('pads inactivity when speech detection arrives after the deadline', async () => {
    vi.useFakeTimers();
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('a'.repeat(160)), timestamp: '100' },
        }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendAudioSpy).toHaveBeenCalledTimes(1);

    transport.emit('input_audio_buffer.speech_started', {} as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendAudioSpy).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(sendAudioSpy.mock.calls[1][0])).toEqual(
      new Uint8Array(8_000).fill(0xff),
    );
  });

  test('cancels inactivity padding when speech stops', async () => {
    vi.useFakeTimers();
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('a'.repeat(160)), timestamp: '100' },
        }),
    });
    transport.emit('input_audio_buffer.speech_started', {} as any);
    await vi.advanceTimersByTimeAsync(749);
    transport.emit('input_audio_buffer.speech_stopped', {} as any);
    await vi.advanceTimersByTimeAsync(1);

    expect(sendAudioSpy).toHaveBeenCalledTimes(1);
  });

  test('uses a configured Twilio input inactivity timeout', async () => {
    vi.useFakeTimers();
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
      inputAudioInactivityTimeoutMs: 250,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('a'.repeat(160)), timestamp: '100' },
        }),
    });
    transport.emit('input_audio_buffer.speech_started', {} as any);
    await vi.advanceTimersByTimeAsync(249);
    expect(sendAudioSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(sendAudioSpy).toHaveBeenCalledTimes(2);
  });

  test('can disable Twilio input inactivity padding', async () => {
    vi.useFakeTimers();
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
      inputAudioInactivityTimeoutMs: null,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('a'.repeat(160)), timestamp: '100' },
        }),
    });
    transport.emit('input_audio_buffer.speech_started', {} as any);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendAudioSpy).toHaveBeenCalledTimes(1);
  });

  test('preserves active input timing when a duplicate connect is rejected', async () => {
    vi.useFakeTimers();
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio);
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('a'.repeat(160)), timestamp: '100' },
        }),
    });
    transport.emit('input_audio_buffer.speech_started', {} as any);

    await expect(
      transport.connect({ apiKey: 'ek_test' } as any),
    ).rejects.toThrow('Transport is already connected.');
    await vi.advanceTimersByTimeAsync(750);

    expect(sendAudioSpy).toHaveBeenCalledTimes(2);
  });

  test('resets Twilio input timestamps when a new stream starts', async () => {
    vi.useFakeTimers();
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    startTwilioStream(twilio);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('a'.repeat(160)), timestamp: '100' },
        }),
    });
    transport.emit('input_audio_buffer.speech_started', {} as any);
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'start',
          start: {
            streamSid: 'sid-2',
            mediaFormat: {
              encoding: 'audio/x-mulaw',
              sampleRate: 8_000,
              channels: 1,
            },
          },
        }),
    });
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'media',
          media: { payload: base64('b'.repeat(160)), timestamp: '1000' },
        }),
    });

    await vi.advanceTimersByTimeAsync(750);
    expect(sendAudioSpy).toHaveBeenCalledTimes(2);
  });

  test('redacts Twilio message and parse-error data when model logging is disabled', async () => {
    const original = process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA;
    process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA = '1';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const secret = 'SECRET_TWILIO_MESSAGE_123';
    const emittedErrors: unknown[] = [];
    transport.on('error', (error) => emittedErrors.push(error));

    try {
      twilio.emit('message', {
        toString: () =>
          JSON.stringify({ event: 'mark', mark: { name: `u:${secret}` } }),
      });
      twilio.emit('message', {
        secret,
        toString: () => `bad{${secret}`,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        'Invalid mark name received. Mark data is redacted.',
      );
      expect(errorSpy).toHaveBeenCalledWith('Error parsing message:', 'object');
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret);
      expect(emittedErrors).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      if (typeof original === 'undefined') {
        delete process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA;
      } else {
        process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA = original;
      }
    }
  });

  test('_onAudio resets chunk count and emits', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const sendSpy = vi.mocked(twilio.send);
    const audioListener = vi.fn();
    transport.on('audio', audioListener);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'start', start: { streamSid: 'sid' } }),
    });

    setCurrentItemId(transport, 'a');
    transport['_onAudio']({
      responseId: 'FAKE_ID',
      type: 'audio',
      data: new Uint8Array(8).buffer,
    });
    setCurrentItemId(transport, 'a');
    transport['_onAudio']({
      responseId: 'FAKE_ID',
      type: 'audio',
      data: new Uint8Array(16).buffer,
    });
    setCurrentItemId(transport, 'b');
    transport['_onAudio']({
      responseId: 'FAKE_ID',
      type: 'audio',
      data: new Uint8Array(8).buffer,
    });

    const marks = sendSpy.mock.calls
      .map((c: any) => JSON.parse(c[0]))
      .filter((d: any) => d.event === 'mark');
    expect(marks[0].mark.name).toMatch(/^a:1:g\d+:m\d+$/);
    expect(marks[1].mark.name).toMatch(/^a:3:g\d+:m\d+$/);
    expect(marks[2].mark.name).toMatch(/^b:1:g\d+:m\d+$/);
    expect(audioListener).toHaveBeenCalledTimes(3);
  });

  test('connect preserves nested audio config while defaulting Twilio formats', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const connectSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.connect);

    await transport.connect({
      apiKey: 'ek_test',
      initialSessionConfig: {
        audio: {
          input: {
            turnDetection: {
              type: 'server_vad',
              silenceDurationMs: 300,
            },
          },
          output: {
            voice: 'alloy',
          },
        },
      },
    } as any);

    expect(connectSpy).toHaveBeenCalledWith({
      apiKey: 'ek_test',
      initialSessionConfig: {
        audio: {
          input: {
            format: 'g711_ulaw',
            turnDetection: {
              type: 'server_vad',
              silenceDurationMs: 300,
            },
          },
          output: {
            format: 'g711_ulaw',
            voice: 'alloy',
          },
        },
      },
    });
  });

  test('updateSessionConfig keeps audio format', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const spy = vi.mocked(
      OpenAIRealtimeWebSocket.prototype.updateSessionConfig,
    );
    transport.updateSessionConfig({
      instructions: 'hi',
      audio: {
        input: {
          turnDetection: {
            type: 'server_vad',
            silenceDurationMs: 300,
          },
        },
        output: {
          voice: 'alloy',
        },
      },
    } as any);
    expect(spy).toHaveBeenCalledWith({
      instructions: 'hi',
      audio: {
        input: {
          format: 'g711_ulaw',
          turnDetection: {
            type: 'server_vad',
            silenceDurationMs: 300,
          },
        },
        output: {
          format: 'g711_ulaw',
          voice: 'alloy',
        },
      },
    });
  });

  test('resets playback state on new Twilio start and handles invalid marks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'start', start: { streamSid: 'sid-1' } }),
    });
    twilio.emit('message', {
      toString: () => JSON.stringify({ event: 'mark', mark: { name: 'u:2' } }),
    });
    // malformed mark should be ignored but logged
    twilio.emit('message', {
      toString: () => JSON.stringify({ event: 'mark', mark: { name: 'u:x' } }),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Invalid mark name received. Mark data is redacted.',
    );

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'start', start: { streamSid: 'sid-2' } }),
    });
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'mark', mark: { name: 'done:u' } }),
    });

    transport.emit('response.created', {
      response: { id: 'response-1' },
    } as any);
    transport._interrupt(0);

    expect(twilio.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'clear', streamSid: 'sid-2' }),
    );
    warnSpy.mockRestore();
  });
});
