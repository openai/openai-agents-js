import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIRealtimeBase } from '../src/openaiRealtimeBase';
import { OpenAIRealtimeWebSocket } from '../src/openaiRealtimeWebsocket';
import { OpenAIRealtimeSIP } from '../src/openaiRealtimeSip';
import { RealtimeAgent } from '../src/realtimeAgent';

let lastFakeSocket: any;
vi.mock('ws', () => {
  return {
    WebSocket: class {
      url: string;
      listeners: Record<string, ((ev: any) => void)[]> = {};
      sent: any[] = [];
      constructor(url: string, _args?: any) {
        this.url = url;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastFakeSocket = this;
        setTimeout(() => this.emit('open', {}));
      }
      addEventListener(type: string, listener: (ev: any) => void) {
        this.listeners[type] = this.listeners[type] || [];
        this.listeners[type].push(listener);
      }
      send(data: any) {
        this.sent.push(data);
      }
      close() {
        this.emit('close', {});
      }
      emit(type: string, ev: any) {
        (this.listeners[type] || []).forEach((fn) => fn(ev));
      }
    },
  };
});

describe('OpenAIRealtimeWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    lastFakeSocket = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('muted getter returns null', () => {
    const ws = new OpenAIRealtimeWebSocket();
    expect(ws.muted).toBeNull();
  });

  it('connection flow emits connection_change events', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const statuses: string[] = [];
    ws.on('connection_change', (s) => statuses.push(s));
    const p = ws.connect({ apiKey: 'ek_test', model: 'm' });
    await vi.runAllTimersAsync();
    await p;
    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('uses custom url from constructor', async () => {
    const ws = new OpenAIRealtimeWebSocket({ url: 'ws://test' });
    const p = ws.connect({ apiKey: 'ek_test', model: 'm' });
    await vi.runAllTimersAsync();
    await p;
    expect(lastFakeSocket!.url).toBe('ws://test');
  });

  it('handles audio delta, speech started and created/done events', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const audioSpy = vi.fn();
    ws.on('audio', audioSpy);
    const sendSpy = vi
      .spyOn(ws as any, 'sendEvent')
      .mockImplementation(() => {});
    const interruptSpy = vi.spyOn(ws, 'interrupt');
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    // ongoing response started
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.created',
        event_id: '1',
        response: {},
      }),
    });
    // audio arrives
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.output_audio.delta',
        event_id: '2',
        item_id: 'i',
        content_index: 0,
        delta: 'AA==',
        output_index: 0,
        response_id: 'r',
      }),
    });

    expect(audioSpy).toHaveBeenCalled();
    // speech started triggers interrupt
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        event_id: '3',
        item_id: 'i',
        audio_start_ms: 0,
      }),
    });
    expect(interruptSpy).toHaveBeenCalled();
    expect(
      sendSpy.mock.calls.some(
        (c: unknown[]) => (c[0] as any).type === 'response.cancel',
      ),
    ).toBe(true);
    expect(
      sendSpy.mock.calls.some(
        (c: unknown[]) => (c[0] as any).type === 'conversation.item.truncate',
      ),
    ).toBe(true);

    sendSpy.mockClear();
    // mark done and ensure no cancel next time
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.done',
        event_id: '4',
        response: {},
        test: false,
      }),
    });
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.output_audio.delta',
        event_id: '5',
        item_id: 'i2',
        content_index: 0,
        delta: 'AA==',
        output_index: 0,
        response_id: 'r2',
      }),
    });
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        event_id: '6',
        item_id: 'i2',
        audio_start_ms: 0,
      }),
    });
    expect(
      sendSpy.mock.calls.every(
        (c: unknown[]) => (c[0] as any).type !== 'response.cancel',
      ),
    ).toBe(true);
  });

  it('does not send truncate events once audio playback completed', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi
      .spyOn(ws as any, 'sendEvent')
      .mockImplementation(() => {});
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.output_audio.delta',
        event_id: 'delta-1',
        item_id: 'item-a',
        content_index: 0,
        delta: 'AA==',
        output_index: 0,
        response_id: 'resp-a',
      }),
    });

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.output_audio.done',
        event_id: 'done-1',
        item_id: 'item-a',
        content_index: 0,
        output_index: 0,
        response_id: 'resp-a',
      }),
    });

    sendSpy.mockClear();

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        event_id: 'speech-1',
        item_id: 'unused',
        audio_start_ms: 0,
      }),
    });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('sendEvent throws when not connected', () => {
    const ws = new OpenAIRealtimeWebSocket();
    expect(() => ws.sendEvent({ type: 'noop' } as any)).toThrow();
  });

  it('close resets state so interrupt does nothing', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi
      .spyOn(OpenAIRealtimeWebSocket.prototype as any, 'sendEvent')
      .mockImplementation(() => {});
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.output_audio.delta',
        event_id: '7',
        item_id: 'i',
        content_index: 0,
        delta: 'AA==',
        output_index: 0,
        response_id: 'r',
      }),
    });
    ws.close();
    sendSpy.mockClear();
    ws.interrupt();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('mute throws expected error', () => {
    const ws = new OpenAIRealtimeWebSocket();
    expect(() => ws.mute(true)).toThrow('Mute is not supported');
  });

  it('disables tracing when initial config sets tracing to null', async () => {
    const updateSpy = vi.spyOn(
      OpenAIRealtimeBase.prototype as any,
      '_updateTracingConfig',
    );
    const ws = new OpenAIRealtimeWebSocket();
    const connectPromise = ws.connect({
      apiKey: 'ek',
      model: 'm',
      initialSessionConfig: {
        tracing: null,
      },
    });
    await vi.runAllTimersAsync();
    await connectPromise;

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'session.created',
        event_id: 'evt_1',
        session: {
          tracing: 'auto',
        },
      }),
    });

    expect(updateSpy).toHaveBeenCalled();
    const lastCall = updateSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).toBeNull();
  });

  it('sendAudio only sends when connected', async () => {
    const baseSpy = vi.spyOn(OpenAIRealtimeBase.prototype, 'sendAudio');
    const ws = new OpenAIRealtimeWebSocket();
    const dummy = new ArrayBuffer(1);
    ws.sendAudio(dummy);
    expect(baseSpy).not.toHaveBeenCalled();
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;
    ws.sendAudio(dummy);
    expect(baseSpy).toHaveBeenCalled();
  });

  it('_interrupt floors fractional audio length when clamping', () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi
      .spyOn(OpenAIRealtimeWebSocket.prototype as any, 'sendEvent')
      .mockImplementation(() => {});
    // @ts-expect-error - testing protected field.
    ws._audioLengthMs = 42.8;
    ws._interrupt(100, false);
    const call = sendSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as any).type === 'conversation.item.truncate',
    );
    expect((call?.[0] as any).audio_end_ms).toBe(42);
    expect(Number.isInteger((call?.[0] as any).audio_end_ms)).toBe(true);
    sendSpy.mockRestore();
  });

  it('_interrupt quantizes and clamps elapsedTime', () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi
      .spyOn(OpenAIRealtimeWebSocket.prototype as any, 'sendEvent')
      .mockImplementation(() => {});
    // @ts-expect-error - testing protected field.
    ws._audioLengthMs = 100;
    ws._interrupt(110.9, false);
    let call = sendSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as any).type === 'conversation.item.truncate',
    );
    expect((call?.[0] as any).audio_end_ms).toBe(100);
    sendSpy.mockClear();
    // @ts-expect-error - testing protected field.
    ws._audioLengthMs = 200;
    ws._interrupt(123.7, false);
    call = sendSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as any).type === 'conversation.item.truncate',
    );
    expect((call?.[0] as any).audio_end_ms).toBe(123);
    sendSpy.mockRestore();
  });

  it('_interrupt floors sub-millisecond elapsedTime', () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi
      .spyOn(OpenAIRealtimeWebSocket.prototype as any, 'sendEvent')
      .mockImplementation(() => {});
    // @ts-expect-error - testing protected field.
    ws._audioLengthMs = 100;
    ws._interrupt(0.9, false);
    const call = sendSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as any).type === 'conversation.item.truncate',
    );
    expect((call?.[0] as any).audio_end_ms).toBe(0);
    expect(Number.isInteger((call?.[0] as any).audio_end_ms)).toBe(true);
    sendSpy.mockRestore();
  });

  it('_interrupt clamps overshoot elapsedTime', () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi
      .spyOn(OpenAIRealtimeWebSocket.prototype as any, 'sendEvent')
      .mockImplementation(() => {});
    // @ts-expect-error - testing protected field.
    ws._audioLengthMs = 42;
    ws._interrupt(42.6, false);
    const call = sendSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as any).type === 'conversation.item.truncate',
    );
    expect((call?.[0] as any).audio_end_ms).toBe(42);
    expect(Number.isInteger((call?.[0] as any).audio_end_ms)).toBe(true);
    sendSpy.mockRestore();
  });

  it('interrupt payload is integer with fractional speed', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi
      .spyOn(OpenAIRealtimeWebSocket.prototype as any, 'sendEvent')
      .mockImplementation(() => {});
    const p = ws.connect({
      apiKey: 'ek',
      model: 'm',
      initialSessionConfig: { speed: 1.1 },
    } as any);
    await vi.runAllTimersAsync();
    await p;
    // @ts-expect-error - testing protected field.
    ws._audioLengthMs = 200;
    ws._interrupt(123.4, false);
    const call = sendSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as any).type === 'conversation.item.truncate',
    );
    expect(Number.isInteger((call?.[0] as any).audio_end_ms)).toBe(true);
    sendSpy.mockRestore();
  });

  it('interrupt payload is integer with speed 1', () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi
      .spyOn(OpenAIRealtimeWebSocket.prototype as any, 'sendEvent')
      .mockImplementation(() => {});
    // @ts-expect-error - testing protected field.
    ws._audioLengthMs = 200;
    ws._interrupt(123.4, false);
    const call = sendSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as any).type === 'conversation.item.truncate',
    );
    expect((call?.[0] as any).audio_end_ms).toBe(123);
    expect(Number.isInteger((call?.[0] as any).audio_end_ms)).toBe(true);
    sendSpy.mockRestore();
  });

  it('full interrupt/_interrupt flow', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi.spyOn(ws, 'sendEvent');
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.created',
        event_id: '1',
        response: {},
      }),
    });
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.output_audio.delta',
        event_id: '2',
        item_id: 'i',
        content_index: 0,
        delta: 'AA==',
        output_index: 0,
        response_id: 'r',
      }),
    });
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        event_id: '3',
        item_id: 'i',
        audio_start_ms: 0,
      }),
    });
    expect(
      sendSpy.mock.calls.some(
        (c: unknown[]) => (c[0] as any).type === 'response.cancel',
      ),
    ).toBe(true);
    expect(
      sendSpy.mock.calls.some(
        (c: unknown[]) => (c[0] as any).type === 'conversation.item.truncate',
      ),
    ).toBe(true);
    sendSpy.mockClear();
    ws.interrupt();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('connects using callId when provided', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const p = ws.connect({ apiKey: 'ek_test', callId: 'call_abc' });
    await vi.runAllTimersAsync();
    await p;
    expect(lastFakeSocket!.url).toBe(
      'wss://api.openai.com/v1/realtime?call_id=call_abc',
    );
    ws.close();
  });

  it('updates cached URL when callId changes', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const first = ws.connect({ apiKey: 'ek_test', callId: 'call_one' });
    await vi.runAllTimersAsync();
    await first;
    expect(lastFakeSocket!.url).toBe(
      'wss://api.openai.com/v1/realtime?call_id=call_one',
    );
    ws.close();

    const second = ws.connect({ apiKey: 'ek_test', callId: 'call_two' });
    await vi.runAllTimersAsync();
    await second;
    expect(lastFakeSocket!.url).toBe(
      'wss://api.openai.com/v1/realtime?call_id=call_two',
    );
    ws.close();
  });

  it('OpenAIRealtimeSIP requires callId', async () => {
    const sip = new OpenAIRealtimeSIP();
    await expect(sip.connect({ apiKey: 'ek_test' } as any)).rejects.toThrow(
      'callId',
    );

    const p = sip.connect({ apiKey: 'ek_test', callId: 'call_xyz' });
    await vi.runAllTimersAsync();
    await p;
    expect(lastFakeSocket!.url).toBe(
      'wss://api.openai.com/v1/realtime?call_id=call_xyz',
    );
    sip.close();
  });

  it('OpenAIRealtimeSIP buildInitialConfig returns realtime payload seeded from agent', async () => {
    const agent = new RealtimeAgent({
      name: 'sip-agent',
      handoffs: [],
      instructions: 'Respond politely.',
    });
    const payload = await OpenAIRealtimeSIP.buildInitialConfig(
      agent,
      {
        model: 'gpt-realtime',
        config: { audio: { output: { speed: 1.5 } } },
      },
      { audio: { output: { speed: 2 } } },
    );
    expect(payload.type).toBe('realtime');
    expect(payload.model).toBe('gpt-realtime');
    expect(payload.instructions).toBe('Respond politely.');
    expect(payload.audio?.output?.speed).toBe(2);
  });

  it('OpenAIRealtimeSIP sendAudio throws', () => {
    const sip = new OpenAIRealtimeSIP();
    expect(() => sip.sendAudio(new ArrayBuffer(1))).toThrow(
      'OpenAIRealtimeSIP does not support sending audio buffers',
    );
  });
});
