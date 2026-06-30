import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { TwilioRealtimeTransportLayer } from '../src/TwilioRealtimeTransport';
import { allowConsole } from '../../../helpers/tests/console-guard';

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
  listenerWrappers = new Map<
    string,
    Map<(evt: any) => void, (evt: any) => void>
  >();

  addEventListener(type: string, listener: (evt: any) => void) {
    const wrapped = (evt: any) =>
      listener(type === 'message' ? { data: evt } : evt);
    const wrappers = this.listenerWrappers.get(type) ?? new Map();
    wrappers.set(listener, wrapped);
    this.listenerWrappers.set(type, wrappers);
    this.on(type, wrapped);
  }

  removeEventListener(type: string, listener: (evt: any) => void) {
    const wrappers = this.listenerWrappers.get(type);
    if (!wrappers) {
      return;
    }

    const wrapped = wrappers.get(listener);
    if (!wrapped) {
      return;
    }

    this.off(type, wrapped);
    wrappers.delete(listener);
    if (wrappers.size === 0) {
      this.listenerWrappers.delete(type);
    }
  }
}

const base64 = (data: string) => Buffer.from(data).toString('base64');

describe('TwilioRealtimeTransportLayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('_setInputAndOutputAudioFormat defaults g711', () => {
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: new FakeTwilioWebSocket() as any,
    });
    expect(transport._setInputAndOutputAudioFormat()).toEqual({
      inputAudioFormat: 'g711_ulaw',
      outputAudioFormat: 'g711_ulaw',
    });
    expect(
      transport._setInputAndOutputAudioFormat({ inputAudioFormat: 'foo' }),
    ).toEqual({ inputAudioFormat: 'foo', outputAudioFormat: 'g711_ulaw' });
  });

  test('_setInputAndOutputAudioFormat preserves nested audio config', () => {
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: new FakeTwilioWebSocket() as any,
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

  test('connect handles messages and events', async () => {
    allowConsole(['error']);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    const closeSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.close);
    const interruptSpy = vi.mocked(
      OpenAIRealtimeWebSocket.prototype._interrupt,
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
    transport._interrupt(0);
    expect(interruptSpy).toHaveBeenCalledWith(55, true);
    expect(twilio.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'clear', streamSid: 'sid' }),
    );

    const errListener = vi.fn();
    transport.on('error', errListener);
    twilio.emit('message', { toString: () => 'bad{' });
    expect(errListener).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Error parsing message:',
      expect.any(Error),
      'Message:',
      expect.any(Object),
    );
    errorSpy.mockRestore();

    twilio.emit('close');
    expect(closeSpy).toHaveBeenCalled();

    const twilioError = new FakeTwilioWebSocket();
    const transportError = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilioError as any,
    });
    transportError.on('error', vi.fn());
    await transportError.connect({ apiKey: 'ek_test' } as any);
    twilioError.emit('error', new Error('boom'));
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  test('connect does not duplicate Twilio listeners on reconnect', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });

    await transport.connect({ apiKey: 'ek_test' } as any);
    await transport.connect({ apiKey: 'ek_test' } as any);

    expect(twilio.listenerCount('message')).toBe(1);
    expect(twilio.listenerCount('close')).toBe(1);
    expect(twilio.listenerCount('error')).toBe(1);

    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const sendAudioSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.sendAudio);
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'media', media: { payload: base64('a') } }),
    });

    expect(sendAudioSpy).toHaveBeenCalledTimes(1);

    transport.emit('audio_done' as any);
    expect(twilio.send).toHaveBeenCalledTimes(1);
  });

  test('connect removes Twilio listeners when OpenAI connect fails', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    vi.mocked(OpenAIRealtimeWebSocket.prototype.connect).mockRejectedValueOnce(
      new Error('connect failed'),
    );

    await expect(
      transport.connect({ apiKey: 'ek_test' } as any),
    ).rejects.toThrow('connect failed');

    expect(twilio.listenerCount('message')).toBe(0);
    expect(twilio.listenerCount('close')).toBe(0);
    expect(twilio.listenerCount('error')).toBe(0);

    transport.emit('audio_done' as any);
    expect(twilio.send).not.toHaveBeenCalled();
  });

  test('close removes Twilio listeners', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);

    transport.close();

    expect(twilio.listenerCount('message')).toBe(0);
    expect(twilio.listenerCount('close')).toBe(0);
    expect(twilio.listenerCount('error')).toBe(0);

    transport.emit('audio_done' as any);
    expect(twilio.send).not.toHaveBeenCalled();
  });

  test('_onAudio resets chunk count and emits', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const sendSpy = vi.mocked(twilio.send);
    const audioListener = vi.fn();
    transport.on('audio', audioListener);

    // @ts-expect-error - we're testing protected readonly fields
    transport.currentItemId = 'a';
    transport['_onAudio']({
      responseId: 'FAKE_ID',
      type: 'audio',
      data: new Uint8Array(8).buffer,
    });
    // @ts-expect-error - we're testing protected readonly fields
    transport.currentItemId = 'a';
    transport['_onAudio']({
      responseId: 'FAKE_ID',
      type: 'audio',
      data: new Uint8Array(16).buffer,
    });
    // @ts-expect-error - we're testing protected readonly fields
    transport.currentItemId = 'b';
    transport['_onAudio']({
      responseId: 'FAKE_ID',
      type: 'audio',
      data: new Uint8Array(8).buffer,
    });

    const marks = sendSpy.mock.calls
      .map((c: any) => JSON.parse(c[0]))
      .filter((d: any) => d.event === 'mark');
    expect(marks[0].mark.name).toBe('a:1');
    expect(marks[1].mark.name).toBe('a:3');
    expect(marks[2].mark.name).toBe('b:1');
    expect(audioListener).toHaveBeenCalledTimes(3);
  });

  test('connect preserves nested audio config while defaulting Twilio formats', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
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
      twilioWebSocket: twilio as any,
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

  test('resets counters on new Twilio start and handles invalid marks', async () => {
    allowConsole(['warn']);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const interruptSpy = vi.mocked(
      OpenAIRealtimeWebSocket.prototype._interrupt,
    );

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
    expect(warnSpy).toHaveBeenCalledWith('Invalid mark name received:', 'u:x');

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'start', start: { streamSid: 'sid-2' } }),
    });
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'mark', mark: { name: 'done:u' } }),
    });

    transport._interrupt(0);

    // After new start, previous counts are cleared; done mark resets to baseline 0 + 50 buffer.
    expect(interruptSpy).toHaveBeenCalledWith(50, true);
    expect(twilio.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'clear', streamSid: 'sid-2' }),
    );
    warnSpy.mockRestore();
  });

  test('resets chunk count on done marks before interrupting', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const interruptSpy = vi.mocked(
      OpenAIRealtimeWebSocket.prototype._interrupt,
    );

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'start', start: { streamSid: 'sid-1' } }),
    });
    twilio.emit('message', {
      toString: () => JSON.stringify({ event: 'mark', mark: { name: 'u:7' } }),
    });
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'mark', mark: { name: 'done:u' } }),
    });

    transport._interrupt(0);

    expect(interruptSpy).toHaveBeenCalledWith(50, true);
    expect(twilio.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'clear', streamSid: 'sid-1' }),
    );
  });
});
