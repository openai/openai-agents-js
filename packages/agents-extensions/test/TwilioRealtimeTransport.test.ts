import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { TwilioRealtimeTransportLayer } from '../src/TwilioRealtimeTransport';
import { allowConsole } from '../../../helpers/tests/console-guard';

import type { MessageEvent as NodeMessageEvent } from 'ws';
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
  FakeOpenAIRealtimeWebSocket.prototype._interrupt = vi.fn();
  FakeOpenAIRealtimeWebSocket.prototype.updateSessionConfig = vi.fn();
  return { OpenAIRealtimeWebSocket: FakeOpenAIRealtimeWebSocket, utils };
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
    twilio.emit('error', new Error('boom'));
    expect(closeSpy).toHaveBeenCalledTimes(2);
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
    transport.updateSessionConfig({ instructions: 'hi' });
    expect(spy).toHaveBeenCalledWith({
      instructions: 'hi',
      inputAudioFormat: 'g711_ulaw',
      outputAudioFormat: 'g711_ulaw',
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
