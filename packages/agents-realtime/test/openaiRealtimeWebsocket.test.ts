import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIRealtimeBase } from '../src/openaiRealtimeBase';
import { OpenAIRealtimeWebSocket } from '../src/openaiRealtimeWebsocket';
import { OpenAIRealtimeSIP } from '../src/openaiRealtimeSip';
import { RealtimeAgent } from '../src/realtimeAgent';

let lastFakeSocket: any;
let fakeSockets: any[] = [];

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function sentPayloads() {
  return (lastFakeSocket?.sent ?? []).map((payload: string) =>
    JSON.parse(payload),
  );
}

vi.mock('ws', () => {
  return {
    WebSocket: class {
      url: string;
      listeners: Record<string, ((ev: any) => void)[]> = {};
      sent: any[] = [];
      closeCalls = 0;
      closeError: Error | undefined;
      emitCloseOnClose = true;
      sendHook: (() => void) | undefined;
      constructor(url: string, _args?: any) {
        this.url = url;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastFakeSocket = this;
        fakeSockets.push(this);
        setTimeout(() => this.emit('open', {}));
      }
      addEventListener(type: string, listener: (ev: any) => void) {
        this.listeners[type] = this.listeners[type] || [];
        this.listeners[type].push(listener);
      }
      send(data: any) {
        this.sent.push(data);
        this.sendHook?.();
      }
      close() {
        this.closeCalls += 1;
        if (this.closeError) {
          throw this.closeError;
        }
        if (this.emitCloseOnClose) {
          this.emit('close', {});
        }
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
    fakeSockets = [];
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

  it('rejects and cleans up when a connected-state observer throws', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const observerError = new Error('connected-state observer failed');
    let shouldThrow = true;
    ws.on('connection_change', (status) => {
      if (status === 'connected' && shouldThrow) {
        shouldThrow = false;
        throw observerError;
      }
    });

    const failedConnect = expect(
      ws.connect({ apiKey: 'ek_test', model: 'first-model' }),
    ).rejects.toBe(observerError);
    await vi.runAllTimersAsync();
    await failedConnect;

    expect(fakeSockets[0].closeCalls).toBe(1);
    expect(ws.status).toBe('disconnected');

    const retry = ws.connect({ apiKey: 'ek_retry', model: 'retry-model' });
    await vi.runAllTimersAsync();
    await retry;
    expect(ws.status).toBe('connected');
  });

  it('rejects when a connected observer closes the active attempt', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    let shouldClose = true;
    ws.on('connected', () => {
      if (shouldClose) {
        shouldClose = false;
        ws.close();
      }
    });

    const failedConnect = expect(
      ws.connect({ apiKey: 'ek_test', model: 'first-model' }),
    ).rejects.toThrow('closed before setup completed');
    await vi.runAllTimersAsync();
    await failedConnect;
    expect(ws.status).toBe('disconnected');

    const retry = ws.connect({ apiKey: 'ek_retry', model: 'retry-model' });
    await vi.runAllTimersAsync();
    await retry;
    expect(ws.status).toBe('connected');
  });

  it('attempts both disconnection notifications when the first throws', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const notificationError = new Error('connection change failed');
    const disconnected = vi.fn();
    ws.on('disconnected', disconnected);
    ws.on('connection_change', (status) => {
      if (status === 'disconnected') {
        throw notificationError;
      }
    });

    const connect = ws.connect({ apiKey: 'ek_test', model: 'first-model' });
    await vi.runAllTimersAsync();
    await connect;

    expect(() => ws.close()).toThrow(notificationError);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(ws.status).toBe('disconnected');
    expect(fakeSockets[0].closeCalls).toBe(1);
  });

  it('cleans up failed session setup and restores connection options for retry', async () => {
    const ws = new OpenAIRealtimeWebSocket({ model: 'initial-model' });
    const setupError = new Error('session setup failed');
    vi.spyOn(ws, 'updateSessionConfig').mockImplementationOnce(() => {
      throw setupError;
    });

    const failedConnect = expect(
      ws.connect({
        apiKey: 'ek_test',
        model: 'failed-model',
        url: 'ws://failed-attempt',
      }),
    ).rejects.toBe(setupError);
    await vi.runAllTimersAsync();
    await failedConnect;

    const failedSocket = fakeSockets[0];
    expect(failedSocket.closeCalls).toBe(1);
    expect(ws.status).toBe('disconnected');
    expect(ws.currentModel).toBe('initial-model');

    const retry = ws.connect({ apiKey: 'ek_test' });
    await vi.runAllTimersAsync();
    await retry;

    expect(fakeSockets).toHaveLength(2);
    expect(lastFakeSocket.url).toBe(
      'wss://api.openai.com/v1/realtime?model=initial-model',
    );
    expect(ws.status).toBe('connected');
  });

  it('preserves the setup error when failed connection cleanup throws', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const setupError = new Error('session setup failed');
    const cleanupError = new Error('socket close failed');
    const errors: unknown[] = [];
    ws.on('error', (event) => errors.push(event.error));
    ws.on('error', () => {
      throw new Error('cleanup error listener failed');
    });
    vi.spyOn(ws, 'updateSessionConfig').mockImplementationOnce(() => {
      lastFakeSocket.closeError = cleanupError;
      throw setupError;
    });

    const failedConnect = expect(
      ws.connect({ apiKey: 'ek_test', model: 'failed-model' }),
    ).rejects.toBe(setupError);
    await vi.runAllTimersAsync();
    await failedConnect;

    expect(fakeSockets[0].closeCalls).toBe(1);
    expect(errors).toContain(cleanupError);
    expect(ws.status).toBe('disconnected');

    const retry = ws.connect({ apiKey: 'ek_test' });
    await vi.runAllTimersAsync();
    await retry;
    expect(ws.status).toBe('connected');
  });

  it('preserves the setup error when cleanup observers close again', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const setupError = new Error('session setup failed');
    let closeAgain = true;
    ws.on('connection_change', (status) => {
      if (status === 'disconnected' && closeAgain) {
        closeAgain = false;
        ws.close();
      }
    });
    vi.spyOn(ws, 'updateSessionConfig').mockImplementationOnce(() => {
      throw setupError;
    });

    const failedConnect = expect(
      ws.connect({ apiKey: 'ek_test', model: 'failed-model' }),
    ).rejects.toBe(setupError);
    await vi.runAllTimersAsync();
    await failedConnect;

    expect(ws.status).toBe('disconnected');

    const retry = ws.connect({ apiKey: 'ek_retry', model: 'retry-model' });
    await vi.runAllTimersAsync();
    await retry;
    expect(ws.status).toBe('connected');
  });

  it.each([undefined, null])(
    'preserves a %s setup failure when cleanup observers close again',
    async (setupFailure) => {
      const ws = new OpenAIRealtimeWebSocket();
      let closeAgain = true;
      ws.on('connection_change', (status) => {
        if (status === 'disconnected' && closeAgain) {
          closeAgain = false;
          ws.close();
        }
      });
      vi.spyOn(ws, 'updateSessionConfig').mockImplementationOnce(() => {
        throw setupFailure;
      });

      const result = ws
        .connect({ apiKey: 'ek_test', model: 'failed-model' })
        .then(
          () => ({ rejected: false, error: undefined }),
          (error) => ({ rejected: true, error }),
        );
      await vi.runAllTimersAsync();

      await expect(result).resolves.toEqual({
        rejected: true,
        error: setupFailure,
      });
      expect(ws.status).toBe('disconnected');
    },
  );

  it('does not roll back a retry started by a cleanup observer', async () => {
    const ws = new OpenAIRealtimeWebSocket({ model: 'initial-model' });
    const setupError = new Error('session setup failed');
    let retry: Promise<void> | undefined;
    ws.on('connection_change', (status) => {
      if (status === 'disconnected' && !retry) {
        ws.close();
        retry = ws.connect({
          apiKey: 'ek_retry',
          model: 'retry-model',
        });
      }
    });
    vi.spyOn(ws, 'updateSessionConfig').mockImplementationOnce(() => {
      throw setupError;
    });

    const failedConnect = expect(
      ws.connect({ apiKey: 'ek_test', model: 'failed-model' }),
    ).rejects.toBe(setupError);
    await vi.runAllTimersAsync();
    await failedConnect;
    await retry;

    expect(fakeSockets).toHaveLength(2);
    expect(fakeSockets[1].url).toBe(
      'wss://api.openai.com/v1/realtime?model=retry-model',
    );
    expect(JSON.parse(fakeSockets[1].sent[0])).toMatchObject({
      type: 'session.update',
      session: { model: 'retry-model' },
    });
    expect(ws.currentModel).toBe('retry-model');
    expect(ws.status).toBe('connected');
  });

  it('restores connection defaults before a cleanup observer retries', async () => {
    const ws = new OpenAIRealtimeWebSocket({ model: 'initial-model' });
    const setupError = new Error('session setup failed');
    let retry: Promise<void> | undefined;
    ws.on('connection_change', (status) => {
      if (status === 'disconnected' && !retry) {
        retry = ws.connect({ apiKey: 'ek_retry' });
      }
    });
    vi.spyOn(ws, 'updateSessionConfig').mockImplementationOnce(() => {
      throw setupError;
    });

    const failedConnect = expect(
      ws.connect({
        apiKey: 'ek_test',
        model: 'failed-model',
        url: 'ws://failed-attempt',
      }),
    ).rejects.toBe(setupError);
    await vi.runAllTimersAsync();
    await failedConnect;
    await retry;

    expect(fakeSockets).toHaveLength(2);
    expect(fakeSockets[1].url).toBe(
      'wss://api.openai.com/v1/realtime?model=initial-model',
    );
    expect(JSON.parse(fakeSockets[1].sent[0])).toMatchObject({
      type: 'session.update',
      session: { model: 'initial-model' },
    });
    expect(ws.currentModel).toBe('initial-model');
    expect(ws.status).toBe('connected');
  });

  it('rejects overlapping connection attempts before opening another socket', async () => {
    const apiKey = createDeferred<string>();
    const ws = new OpenAIRealtimeWebSocket();
    const firstConnect = ws.connect({
      apiKey: () => apiKey.promise,
      model: 'first-model',
    });

    await expect(
      ws.connect({ apiKey: 'ek_second', model: 'second-model' }),
    ).rejects.toThrow('already connected or connecting');
    expect(fakeSockets).toHaveLength(0);

    apiKey.resolve('ek_first');
    await vi.runAllTimersAsync();
    await firstConnect;

    expect(fakeSockets).toHaveLength(1);
    expect(ws.currentModel).toBe('first-model');
  });

  it('rejects and cleans up socket errors without an error listener', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const socketError = new Error('socket failed');
    const connect = ws.connect({ apiKey: 'ek_test', model: 'first-model' });
    const failedConnect = expect(connect).rejects.toBe(socketError);

    await Promise.resolve();
    await Promise.resolve();
    const socket = fakeSockets[0];
    socket.emit('error', socketError);

    await failedConnect;
    await vi.runAllTimersAsync();
    expect(socket.closeCalls).toBe(1);
    expect(ws.status).toBe('disconnected');
  });

  it('preserves a socket error raised during initial session setup', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const socketError = new Error('socket failed during session setup');
    const connect = ws.connect({ apiKey: 'ek_test', model: 'first-model' });
    const failedConnect = expect(connect).rejects.toBe(socketError);

    await Promise.resolve();
    await Promise.resolve();
    const failedSocket = fakeSockets[0];
    failedSocket.sendHook = () => failedSocket.emit('error', socketError);

    await vi.runAllTimersAsync();
    await failedConnect;
    expect(failedSocket.closeCalls).toBe(1);
    expect(ws.status).toBe('disconnected');

    const retry = ws.connect({ apiKey: 'ek_retry', model: 'retry-model' });
    await vi.runAllTimersAsync();
    await retry;
    expect(ws.status).toBe('connected');
  });

  it('preserves a socket error when its observer closes the transport', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const socketError = new Error('socket setup failed');
    ws.on('error', () => ws.close());
    const connect = ws.connect({ apiKey: 'ek_test', model: 'first-model' });
    const failedConnect = expect(connect).rejects.toBe(socketError);

    await Promise.resolve();
    await Promise.resolve();
    fakeSockets[0].emit('error', socketError);

    await failedConnect;
    await vi.runAllTimersAsync();
    expect(ws.status).toBe('disconnected');
  });

  it('preserves a pre-open close error when its observer closes again', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    ws.on('connection_change', (status) => {
      if (status === 'disconnected') {
        ws.close();
      }
    });
    const connect = ws.connect({ apiKey: 'ek_test', model: 'first-model' });
    const failedConnect = expect(connect).rejects.toThrow(
      'WebSocket closed before the connection was ready.',
    );

    await Promise.resolve();
    await Promise.resolve();
    fakeSockets[0].emit('close', {});

    await failedConnect;
    await vi.runAllTimersAsync();
    expect(ws.status).toBe('disconnected');
  });

  it('close invalidates an attempt waiting for its API key', async () => {
    const apiKey = createDeferred<string>();
    const ws = new OpenAIRealtimeWebSocket({ model: 'initial-model' });
    const connect = ws.connect({
      apiKey: () => apiKey.promise,
      model: 'failed-model',
    });
    const closedConnect = expect(connect).rejects.toThrow(
      'closed before setup completed',
    );

    ws.close();
    await closedConnect;
    expect(ws.status).toBe('disconnected');
    expect(ws.currentModel).toBe('initial-model');

    apiKey.resolve('ek_stale');
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeSockets).toHaveLength(0);

    const retry = ws.connect({ apiKey: 'ek_retry' });
    await vi.runAllTimersAsync();
    await retry;
    expect(ws.status).toBe('connected');
  });

  it('close rejects an attempt waiting for the socket to open', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const connect = ws.connect({ apiKey: 'ek_test', model: 'first-model' });
    const closedConnect = expect(connect).rejects.toThrow(
      'closed before setup completed',
    );

    await Promise.resolve();
    await Promise.resolve();
    const socket = fakeSockets[0];
    ws.close();

    await closedConnect;
    await vi.runAllTimersAsync();
    expect(socket.closeCalls).toBe(1);
    expect(ws.status).toBe('disconnected');

    const retry = ws.connect({ apiKey: 'ek_retry' });
    await vi.runAllTimersAsync();
    await retry;
    expect(ws.status).toBe('connected');
  });

  it('rejects connect while already connected', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const firstConnect = ws.connect({
      apiKey: 'ek_test',
      model: 'first-model',
    });
    await vi.runAllTimersAsync();
    await firstConnect;

    await expect(
      ws.connect({ apiKey: 'ek_second', model: 'second-model' }),
    ).rejects.toThrow('already connected or connecting');
    expect(fakeSockets).toHaveLength(1);
    expect(ws.currentModel).toBe('first-model');
  });

  it('stays disconnected when close does not emit and ignores a stale close event', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const firstConnect = ws.connect({
      apiKey: 'ek_test',
      model: 'first-model',
    });
    await vi.runAllTimersAsync();
    await firstConnect;

    const firstSocket = fakeSockets[0];
    firstSocket.emitCloseOnClose = false;
    ws.close();
    expect(ws.status).toBe('disconnected');

    const retry = ws.connect({ apiKey: 'ek_test', model: 'second-model' });
    await vi.runAllTimersAsync();
    await retry;
    expect(ws.status).toBe('connected');

    firstSocket.emit('close', {});
    expect(ws.status).toBe('connected');
  });

  it('uses custom url from constructor', async () => {
    const ws = new OpenAIRealtimeWebSocket({ url: 'ws://test' });
    const p = ws.connect({ apiKey: 'ek_test', model: 'm' });
    await vi.runAllTimersAsync();
    await p;
    expect(lastFakeSocket!.url).toBe('ws://test');
  });

  it('ignores malformed JSON and binary non-JSON messages', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const events: any[] = [];
    ws.on('*', (event) => events.push(event));
    const p = ws.connect({ apiKey: 'ek_test', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    expect(() => lastFakeSocket!.emit('message', { data: '{' })).not.toThrow();
    expect(() =>
      lastFakeSocket!.emit('message', { data: new Uint8Array([0, 1, 2]) }),
    ).not.toThrow();
    expect(events).toEqual([]);
  });

  it('emits unknown valid events as generic messages', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const events: any[] = [];
    ws.on('*', (event) => events.push(event));
    const p = ws.connect({ apiKey: 'ek_test', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    const payload = {
      type: 'unknown.event',
      event_id: 'evt_x',
      foo: 'bar',
    };
    lastFakeSocket!.emit('message', { data: JSON.stringify(payload) });

    expect(events).toEqual([payload]);
  });

  it('preserves known server payloads on wildcard events', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const events: any[] = [];
    ws.on('*', (event) => events.push(event));
    const p = ws.connect({ apiKey: 'ek_test', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    const payload = {
      type: 'conversation.created',
      event_id: 'evt_known',
      conversation: {
        id: 'conv_1',
        provider_nested: { value: true },
      },
      provider_top_level: 123,
    };
    lastFakeSocket!.emit('message', { data: JSON.stringify(payload) });

    expect(events).toEqual([payload]);
  });

  it('handles audio delta, speech started and created/done events', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const audioSpy = vi.fn();
    ws.on('audio', audioSpy);
    const sendSpy = vi.spyOn(ws as any, 'sendEvent');
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
      sentPayloads().some((payload: any) => payload.type === 'response.cancel'),
    ).toBe(true);
    expect(
      sendSpy.mock.calls.some(
        (c: unknown[]) => (c[0] as any).type === 'conversation.item.truncate',
      ),
    ).toBe(true);

    sendSpy.mockClear();
    lastFakeSocket!.sent.length = 0;
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
      sentPayloads().every(
        (payload: any) => payload.type !== 'response.cancel',
      ),
    ).toBe(true);
  });

  it('does not send truncate events once audio playback completed', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const sendSpy = vi.spyOn(ws as any, 'sendEvent');
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
      sentPayloads().some((payload: any) => payload.type === 'response.cancel'),
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

  it('defers follow-up response.create until response.done after interrupt', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.created',
        event_id: 'r1',
        response: {},
      }),
    });
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.output_audio.delta',
        event_id: 'a1',
        item_id: 'item-1',
        content_index: 0,
        delta: 'AA==',
        output_index: 0,
        response_id: 'resp-1',
      }),
    });

    lastFakeSocket!.sent.length = 0;
    ws.interrupt();
    ws.sendMessage('blocked', {});
    await vi.runAllTimersAsync();

    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'response.cancel',
      'conversation.item.truncate',
      'conversation.item.create',
    ]);

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.done',
        event_id: 'r1_done',
        response: {},
      }),
    });
    await vi.runAllTimersAsync();

    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'response.cancel',
      'conversation.item.truncate',
      'conversation.item.create',
      'response.create',
    ]);
  });

  it('sends automatic response.create synchronously before later same-tick events', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    lastFakeSocket!.sent.length = 0;
    ws.sendMessage('first', {});
    ws.sendMessage('second', {});

    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'conversation.item.create',
      'response.create',
      'conversation.item.create',
    ]);
  });

  it('sends manual response.create synchronously before later same-tick events', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    lastFakeSocket!.sent.length = 0;
    ws.sendEvent({ type: 'response.create' } as any);
    ws.sendEvent({
      type: 'input_audio_buffer.append',
      audio: 'AA==',
    } as any);

    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'response.create',
      'input_audio_buffer.append',
    ]);
  });

  it('queues manual response.create until the previous turn is done', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.created',
        event_id: 'r1',
        response: {},
      }),
    });

    lastFakeSocket!.sent.length = 0;
    ws.sendEvent({
      type: 'response.create',
      response: { instructions: 'Say hello.' },
    } as any);
    await vi.runAllTimersAsync();

    expect(sentPayloads()).toEqual([]);

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.done',
        event_id: 'r1_done',
        response: {},
      }),
    });
    await vi.runAllTimersAsync();

    expect(sentPayloads()).toEqual([
      {
        type: 'response.create',
        event_id: expect.any(String),
        response: { instructions: 'Say hello.' },
      },
    ]);
  });

  it('releases queued response.create when the server rejects the pending one', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    ws.on('error', () => {});
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.created',
        event_id: 'r1',
        response: {},
      }),
    });

    lastFakeSocket!.sent.length = 0;
    ws.sendMessage('first', {});
    await vi.runAllTimersAsync();

    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'conversation.item.create',
    ]);

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.done',
        event_id: 'r1_done',
        response: {},
      }),
    });
    await vi.runAllTimersAsync();

    const firstResponseCreate = sentPayloads().find(
      (payload: any) => payload.type === 'response.create',
    );
    expect(firstResponseCreate?.event_id).toEqual(expect.any(String));

    ws.sendMessage('second', {});
    await vi.runAllTimersAsync();

    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'conversation.item.create',
      'response.create',
      'conversation.item.create',
    ]);

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'error',
        event_id: 'err-1',
        error: {
          code: 'bad_response_create',
          message: 'bad response.create',
          event_id: firstResponseCreate.event_id,
        },
      }),
    });
    await vi.runAllTimersAsync();

    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'conversation.item.create',
      'response.create',
      'conversation.item.create',
      'response.create',
    ]);
  });

  it('keeps queued requestResponse overrides distinct from automatic follow-ups', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.created',
        event_id: 'r1',
        response: {},
      }),
    });

    lastFakeSocket!.sent.length = 0;
    ws.sendMessage('auto', {});
    ws.requestResponse({ instructions: 'Use the override.' });
    await vi.runAllTimersAsync();

    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'conversation.item.create',
    ]);

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.done',
        event_id: 'r1_done',
        response: {},
      }),
    });
    await vi.runAllTimersAsync();

    expect(
      sentPayloads().filter(
        (payload: any) => payload.type === 'response.create',
      ),
    ).toEqual([
      {
        type: 'response.create',
        event_id: expect.any(String),
      },
    ]);

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.created',
        event_id: 'r2',
        response: {},
      }),
    });
    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.done',
        event_id: 'r2_done',
        response: {},
      }),
    });
    await vi.runAllTimersAsync();

    expect(
      sentPayloads().filter(
        (payload: any) => payload.type === 'response.create',
      ),
    ).toEqual([
      {
        type: 'response.create',
        event_id: expect.any(String),
      },
      {
        type: 'response.create',
        event_id: expect.any(String),
        response: { instructions: 'Use the override.' },
      },
    ]);
  });

  it('retries later coalesced auto response.create requests after a failure', async () => {
    const ws = new OpenAIRealtimeWebSocket();
    ws.on('error', () => {});
    const p = ws.connect({ apiKey: 'ek', model: 'm' });
    await vi.runAllTimersAsync();
    await p;

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.created',
        event_id: 'r1',
        response: {},
      }),
    });

    lastFakeSocket!.sent.length = 0;
    ws.sendMessage('first', {});
    ws.sendMessage('second', {});
    ws.sendMessage('third', {});
    await vi.runAllTimersAsync();

    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'conversation.item.create',
      'conversation.item.create',
      'conversation.item.create',
    ]);

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'response.done',
        event_id: 'r1_done',
        response: {},
      }),
    });
    await vi.runAllTimersAsync();

    const firstResponseCreate = sentPayloads().find(
      (payload: any) => payload.type === 'response.create',
    );
    expect(firstResponseCreate?.event_id).toEqual(expect.any(String));
    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'conversation.item.create',
      'conversation.item.create',
      'conversation.item.create',
      'response.create',
    ]);

    lastFakeSocket!.emit('message', {
      data: JSON.stringify({
        type: 'error',
        event_id: 'err-coalesced',
        error: {
          code: 'bad_response_create',
          message: 'bad response.create',
          event_id: firstResponseCreate.event_id,
        },
      }),
    });
    await vi.runAllTimersAsync();

    expect(sentPayloads().map((payload: any) => payload.type)).toEqual([
      'conversation.item.create',
      'conversation.item.create',
      'conversation.item.create',
      'response.create',
      'response.create',
    ]);
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
        model: 'gpt-realtime-1.5',
        config: { audio: { output: { speed: 1.5 } } },
      },
      { audio: { output: { speed: 2 } } },
    );
    expect(payload.type).toBe('realtime');
    expect(payload.model).toBe('gpt-realtime-1.5');
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
