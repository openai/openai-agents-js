import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { TwilioRealtimeTransportLayer } from '../src/TwilioRealtimeTransport';
import { allowConsole } from '../../../helpers/tests/console-guard';

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
    this.status = 'connected';
  });
  FakeOpenAIRealtimeWebSocket.prototype.sendAudio = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype.close = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype.interrupt = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype._interrupt = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype._afterAudioDoneEvent = vi.fn(function (
    this: any,
  ) {
    this.currentItemId = null;
  });
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

describe('TwilioRealtimeTransportLayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      transport._setInputAndOutputAudioFormat({ inputAudioFormat: 'foo' }),
    ).toEqual({ inputAudioFormat: 'foo', outputAudioFormat: 'g711_ulaw' });
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

  test('connect handles messages and events', async () => {
    allowConsole(['error']);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
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
    twilio.emit('error', new Error('boom'));
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  test('interrupt skips Twilio clear before stream start', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const interruptSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.interrupt);

    transport.interrupt();

    const clearCalls = twilio.send.mock.calls
      .map((call) => JSON.parse(call[0]))
      .filter((message: any) => message.event === 'clear');
    expect(clearCalls).toEqual([]);
    expect(interruptSpy).toHaveBeenCalledWith(true);
  });

  test('interrupt clears Twilio playback even when base transport has no active audio state', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const interruptSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.interrupt);

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'start', start: { streamSid: 'sid' } }),
    });

    transport.interrupt();

    expect(twilio.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'clear', streamSid: 'sid' }),
    );
    expect(interruptSpy).toHaveBeenCalledWith(true);
  });

  test('interrupt clears Twilio playback once when base interrupt truncates audio', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const interruptSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.interrupt);
    const truncateSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype._interrupt);
    interruptSpy.mockImplementationOnce(function (
      this: any,
      cancelOngoingResponse = true,
    ) {
      this._interrupt(0, cancelOngoingResponse);
    });

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'start', start: { streamSid: 'sid' } }),
    });
    twilio.emit('message', {
      toString: () => JSON.stringify({ event: 'mark', mark: { name: 'u:5' } }),
    });

    transport.interrupt(false);

    const clearCalls = twilio.send.mock.calls
      .map((call) => JSON.parse(call[0]))
      .filter((message: any) => message.event === 'clear');
    expect(clearCalls).toEqual([{ event: 'clear', streamSid: 'sid' }]);
    expect(truncateSpy).toHaveBeenCalledWith(55, false);
  });

  test('interrupt truncates an item while Twilio is still playing completed audio', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const interruptSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype.interrupt);
    const truncateSpy = vi.mocked(OpenAIRealtimeWebSocket.prototype._interrupt);
    const resetSpy = vi.mocked(
      (OpenAIRealtimeWebSocket.prototype as any)._afterAudioDoneEvent,
    );
    interruptSpy.mockImplementationOnce(function (
      this: any,
      cancelOngoingResponse = true,
    ) {
      if (this.currentItemId == null) {
        return;
      }
      this._interrupt(0, cancelOngoingResponse);
      this.currentItemId = null;
    });

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'start', start: { streamSid: 'sid' } }),
    });
    // @ts-expect-error - we're testing protected readonly fields
    transport.currentItemId = 'item-1';
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'mark',
          mark: { name: 'item-1:5' },
        }),
    });

    transport.emit('audio_done');
    transport['_afterAudioDoneEvent']();

    expect(resetSpy).not.toHaveBeenCalled();
    // @ts-expect-error - we're testing protected readonly fields
    expect(transport.currentItemId).toBe('item-1');

    transport.interrupt(false);

    expect(twilio.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'clear', streamSid: 'sid' }),
    );
    expect(truncateSpy).toHaveBeenCalledWith(55, false);
  });

  test('resets retained audio state only for the matching Twilio done mark', async () => {
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilio as any,
    });
    await transport.connect({ apiKey: 'ek_test' } as any);
    const { OpenAIRealtimeWebSocket } = await import('@openai/agents/realtime');
    const resetSpy = vi.mocked(
      (OpenAIRealtimeWebSocket.prototype as any)._afterAudioDoneEvent,
    );

    twilio.emit('message', {
      toString: () =>
        JSON.stringify({ event: 'start', start: { streamSid: 'sid' } }),
    });
    // @ts-expect-error - we're testing protected readonly fields
    transport.currentItemId = 'item-1';
    transport.emit('audio_done');
    transport['_afterAudioDoneEvent']();

    // A new response can start before Twilio acknowledges the previous done mark.
    // @ts-expect-error - we're testing protected readonly fields
    transport.currentItemId = 'item-2';
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'mark',
          mark: { name: 'done:item-1' },
        }),
    });

    expect(resetSpy).not.toHaveBeenCalled();
    // @ts-expect-error - we're testing protected readonly fields
    expect(transport.currentItemId).toBe('item-2');

    transport.emit('audio_done');
    transport['_afterAudioDoneEvent']();
    twilio.emit('message', {
      toString: () =>
        JSON.stringify({
          event: 'mark',
          mark: { name: 'done:item-2' },
        }),
    });

    expect(resetSpy).toHaveBeenCalledTimes(1);
    // @ts-expect-error - we're testing protected readonly fields
    expect(transport.currentItemId).toBeNull();
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
    expect(marks[0].mark.name).toBe('a:1');
    expect(marks[1].mark.name).toBe('a:3');
    expect(marks[2].mark.name).toBe('b:1');
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

  test('resets counters on new Twilio start and handles invalid marks', async () => {
    allowConsole(['warn']);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twilio = new FakeTwilioWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: asTwilioWebSocket(twilio),
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
      twilioWebSocket: asTwilioWebSocket(twilio),
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
    // @ts-expect-error - we're testing protected readonly fields
    transport.currentItemId = 'u';
    transport.emit('audio_done');
    transport['_afterAudioDoneEvent']();
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
