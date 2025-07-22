import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIRealtimeBase } from '../src/openaiRealtimeBase';
import { OpenAIRealtimeWebSocket } from '../src/openaiRealtimeWebsocket';

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

  it('handles audio delta, speech started and created/done events', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const audioSpy = vi.fn();
    ws.on('audio', audioSpy);
    const sendSpy = vi.spyOn(ws, 'sendEvent');
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
        type: 'response.audio.delta',
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
      sendSpy.mock.calls.some((c) => c[0].type === 'response.cancel'),
    ).toBe(true);
    expect(
      sendSpy.mock.calls.some(
        (c) => c[0].type === 'conversation.item.truncate',
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
        type: 'response.audio.delta',
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
      sendSpy.mock.calls.every((c) => c[0].type !== 'response.cancel'),
    ).toBe(true);
  });

  it('sendEvent throws when not connected', () => {
    const ws = new OpenAIRealtimeWebSocket();
    expect(() => ws.sendEvent({ type: 'noop' } as any)).toThrow();
  });

  it('close resets state so interrupt does nothing', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi.spyOn(ws, 'sendEvent');
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.audio.delta',
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
        type: 'response.audio.delta',
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
      sendSpy.mock.calls.some((c) => c[0].type === 'response.cancel'),
    ).toBe(true);
    expect(
      sendSpy.mock.calls.some(
        (c) => c[0].type === 'conversation.item.truncate',
      ),
    ).toBe(true);
    sendSpy.mockClear();
    ws.interrupt();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
