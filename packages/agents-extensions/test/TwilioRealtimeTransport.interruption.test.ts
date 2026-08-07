import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  MessageEvent as NodeMessageEvent,
  WebSocket as NodeWebSocket,
} from 'ws';
import type { MessageEvent } from 'undici-types';

let openAIWebSocket: any;

function setOpenAIWebSocket(socket: any) {
  openAIWebSocket = socket;
}

vi.mock('ws', () => ({
  WebSocket: class {
    listeners: Record<string, ((event: any) => void)[]> = {};
    sent: string[] = [];

    constructor(_url: string, _options?: unknown) {
      setOpenAIWebSocket(this);
      setTimeout(() => this.emit('open', {}));
    }

    addEventListener(type: string, listener: (event: any) => void) {
      this.listeners[type] = this.listeners[type] ?? [];
      this.listeners[type].push(listener);
    }

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      this.emit('close', {});
    }

    emit(type: string, event: any) {
      for (const listener of this.listeners[type] ?? []) {
        listener(event);
      }
    }
  },
}));

import { TwilioRealtimeTransportLayer } from '../src/TwilioRealtimeTransport';

class FakeTwilioWebSocket extends EventEmitter {
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent | NodeMessageEvent) => void,
  ) {
    this.on(type, (event) =>
      listener(type === 'message' ? ({ data: event } as any) : event),
    );
  }
}

const asTwilioWebSocket = (
  socket: FakeTwilioWebSocket,
): WebSocket | NodeWebSocket => socket as unknown as WebSocket | NodeWebSocket;

function payloads(sent: string[]) {
  return sent.map((payload) => JSON.parse(payload));
}

function twilioMarks(twilio: FakeTwilioWebSocket) {
  return payloads(twilio.sent).filter((payload) => payload.event === 'mark');
}

function openAIEvents() {
  return payloads(openAIWebSocket?.sent ?? []);
}

function emitTwilioMessage(twilio: FakeTwilioWebSocket, message: unknown) {
  twilio.emit('message', JSON.stringify(message));
}

function returnTwilioMark(twilio: FakeTwilioWebSocket, name: string) {
  emitTwilioMessage(twilio, { event: 'mark', mark: { name } });
}

function emitOpenAIEvent(event: unknown) {
  openAIWebSocket?.emit('message', { data: JSON.stringify(event) });
}

function emitResponseCreated(responseId: string) {
  emitOpenAIEvent({
    type: 'response.created',
    event_id: `created-${responseId}`,
    response: { id: responseId, status: 'in_progress' },
  });
}

function emitAudioDelta(
  itemId: string,
  responseId: string,
  byteLength: number = 800,
  contentIndex: number = 0,
) {
  emitOpenAIEvent({
    type: 'response.output_audio.delta',
    event_id: `delta-${itemId}-${Math.random()}`,
    item_id: itemId,
    content_index: contentIndex,
    output_index: 0,
    response_id: responseId,
    delta: Buffer.alloc(byteLength).toString('base64'),
  });
}

function emitAudioDone(
  itemId: string,
  responseId: string,
  contentIndex: number = 0,
) {
  emitOpenAIEvent({
    type: 'response.output_audio.done',
    event_id: `done-${itemId}`,
    item_id: itemId,
    content_index: contentIndex,
    output_index: 0,
    response_id: responseId,
  });
}

async function createConnectedTransport() {
  const twilio = new FakeTwilioWebSocket();
  const transport = new TwilioRealtimeTransportLayer({
    twilioWebSocket: asTwilioWebSocket(twilio),
  });
  const connecting = transport.connect({ apiKey: 'ek_test', model: 'test' });
  await vi.runAllTimersAsync();
  await connecting;
  emitTwilioMessage(twilio, {
    event: 'start',
    start: { streamSid: 'stream-1' },
  });
  return { transport, twilio };
}

describe('TwilioRealtimeTransportLayer interruption ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    openAIWebSocket = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('truncates one item at its last acknowledged playback position', async () => {
    const { transport, twilio } = await createConnectedTransport();

    emitAudioDelta('item-a', 'response-a');
    const playedMark = twilioMarks(twilio).at(-1).mark.name;
    returnTwilioMark(twilio, playedMark);
    emitAudioDelta('item-a', 'response-a');
    emitAudioDone('item-a', 'response-a');

    transport.interrupt(false);

    expect(openAIEvents()).toContainEqual({
      type: 'conversation.item.truncate',
      item_id: 'item-a',
      content_index: 0,
      audio_end_ms: 150,
    });
    expect(payloads(twilio.sent)).toContainEqual({
      event: 'clear',
      streamSid: 'stream-1',
    });
  });

  test('clamps and floors a fully acknowledged fractional duration', async () => {
    const { transport, twilio } = await createConnectedTransport();

    emitAudioDelta('item-a', 'response-a', 161);
    const playedMark = twilioMarks(twilio).at(-1).mark.name;
    returnTwilioMark(twilio, playedMark);

    transport.interrupt(false);

    const truncation = openAIEvents().find(
      (event) => event.type === 'conversation.item.truncate',
    );
    expect(truncation).toEqual({
      type: 'conversation.item.truncate',
      item_id: 'item-a',
      content_index: 0,
      audio_end_ms: 20,
    });
    expect(Number.isInteger(truncation.audio_end_ms)).toBe(true);
  });

  test('truncates overlapping items at their own playback positions', async () => {
    const { transport, twilio } = await createConnectedTransport();

    emitAudioDelta('item-a', 'response-a');
    const playedMark = twilioMarks(twilio).at(-1).mark.name;
    returnTwilioMark(twilio, playedMark);
    emitAudioDelta('item-a', 'response-a');
    emitAudioDone('item-a', 'response-a');
    emitAudioDelta('item-b', 'response-b');

    transport.interrupt(false);

    expect(
      openAIEvents().filter(
        (event) => event.type === 'conversation.item.truncate',
      ),
    ).toEqual([
      {
        type: 'conversation.item.truncate',
        item_id: 'item-a',
        content_index: 0,
        audio_end_ms: 150,
      },
      {
        type: 'conversation.item.truncate',
        item_id: 'item-b',
        content_index: 0,
        audio_end_ms: 0,
      },
    ]);
  });

  test('does not apply clear-returned stale marks to a new generation', async () => {
    const { transport, twilio } = await createConnectedTransport();

    emitAudioDelta('item-a', 'response-a');
    const firstMark = twilioMarks(twilio).at(-1).mark.name;
    returnTwilioMark(twilio, firstMark);
    emitAudioDelta('item-a', 'response-a');
    const clearedMark = twilioMarks(twilio).at(-1).mark.name;
    transport.interrupt(false);

    returnTwilioMark(twilio, clearedMark);
    emitAudioDelta('item-b', 'response-b');
    transport.interrupt(false);

    const truncations = openAIEvents().filter(
      (event) => event.type === 'conversation.item.truncate',
    );
    expect(truncations.at(-1)).toEqual({
      type: 'conversation.item.truncate',
      item_id: 'item-b',
      content_index: 0,
      audio_end_ms: 50,
    });
  });

  test('does not emit or forward late audio for an interrupted item', async () => {
    const { transport, twilio } = await createConnectedTransport();
    const audioListener = vi.fn();
    transport.on('audio', audioListener);

    emitResponseCreated('response-a');
    emitAudioDelta('item-a', 'response-a');
    transport.interrupt(false);
    const mediaCountAfterInterrupt = payloads(twilio.sent).filter(
      (payload) => payload.event === 'media',
    ).length;
    emitAudioDelta('item-a', 'response-a');
    emitAudioDelta('item-b', 'response-a');
    emitTwilioMessage(twilio, {
      event: 'start',
      start: { streamSid: 'stream-2' },
    });
    emitAudioDelta('item-c', 'response-a');

    emitResponseCreated('response-b');
    emitAudioDelta('item-d', 'response-b');

    expect(
      payloads(twilio.sent).filter((payload) => payload.event === 'media'),
    ).toHaveLength(mediaCountAfterInterrupt + 1);
    expect(audioListener).toHaveBeenCalledTimes(2);
  });

  test('drops an interrupted response before its first audio delta', async () => {
    const { transport, twilio } = await createConnectedTransport();
    const audioListener = vi.fn();
    transport.on('audio', audioListener);

    emitResponseCreated('response-a');
    transport.interrupt(false);
    const mediaCountAfterInterrupt = payloads(twilio.sent).filter(
      (payload) => payload.event === 'media',
    ).length;
    emitAudioDelta('item-a', 'response-a');

    expect(
      payloads(twilio.sent).filter((payload) => payload.event === 'media'),
    ).toHaveLength(mediaCountAfterInterrupt);
    expect(audioListener).not.toHaveBeenCalled();
  });

  test('invalidates playback ownership when locally closed', async () => {
    const { transport, twilio } = await createConnectedTransport();

    emitAudioDelta('item-a', 'response-a');
    transport.close();
    const sentBeforeInterrupt = [...twilio.sent];

    expect(() => transport.interrupt(false)).not.toThrow();
    expect(twilio.sent).toEqual(sentBeforeInterrupt);
  });

  test('invalidates playback ownership when remotely closed', async () => {
    const { transport, twilio } = await createConnectedTransport();

    emitAudioDelta('item-a', 'response-a');
    openAIWebSocket.emit('close', {});
    const sentBeforeInterrupt = [...twilio.sent];

    expect(() => transport.interrupt(false)).not.toThrow();
    expect(twilio.sent).toEqual(sentBeforeInterrupt);
  });

  test('tracks only the new session playback after reconnecting', async () => {
    const { transport, twilio } = await createConnectedTransport();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    emitAudioDelta('item-a', 'response-a');
    transport.close();
    const reconnecting = transport.connect({
      apiKey: 'ek_test',
      model: 'test',
    });
    await vi.runAllTimersAsync();
    await reconnecting;

    openAIWebSocket.sent = [];
    emitTwilioMessage(twilio, {
      event: 'media',
      media: { payload: Buffer.from([1]).toString('base64') },
    });
    expect(
      openAIEvents().filter(
        (event) => event.type === 'input_audio_buffer.append',
      ),
    ).toHaveLength(1);

    emitAudioDelta('item-b', 'response-b');
    const playedMark = twilioMarks(twilio).at(-1).mark.name;
    returnTwilioMark(twilio, playedMark);

    transport.interrupt(false);

    expect(
      openAIEvents().filter(
        (event) => event.type === 'conversation.item.truncate',
      ),
    ).toEqual([
      {
        type: 'conversation.item.truncate',
        item_id: 'item-b',
        content_index: 0,
        audio_end_ms: 100,
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('removes a fully played item when Twilio returns its done mark', async () => {
    const { transport, twilio } = await createConnectedTransport();

    emitAudioDelta('item-a', 'response-a');
    emitAudioDone('item-a', 'response-a');
    const [audioMark, doneMark] = twilioMarks(twilio).slice(-2);
    returnTwilioMark(twilio, audioMark.mark.name);
    returnTwilioMark(twilio, doneMark.mark.name);
    emitAudioDelta('item-b', 'response-b');

    transport.interrupt(false);

    expect(
      openAIEvents().filter(
        (event) => event.type === 'conversation.item.truncate',
      ),
    ).toEqual([
      {
        type: 'conversation.item.truncate',
        item_id: 'item-b',
        content_index: 0,
        audio_end_ms: 50,
      },
    ]);
  });

  test('binds interleaved done events to their exact item', async () => {
    const { transport, twilio } = await createConnectedTransport();

    emitAudioDelta('item-a', 'response-a');
    emitAudioDelta('item-b', 'response-b');
    emitAudioDone('item-a', 'response-a');
    const [itemAMark, itemBMark, doneMark] = twilioMarks(twilio).slice(-3);
    expect(doneMark.mark.name).toMatch(/^done:item-a:/);
    returnTwilioMark(twilio, itemAMark.mark.name);
    returnTwilioMark(twilio, itemBMark.mark.name);
    returnTwilioMark(twilio, doneMark.mark.name);

    transport.interrupt(false);

    expect(
      openAIEvents().filter(
        (event) => event.type === 'conversation.item.truncate',
      ),
    ).toEqual([
      {
        type: 'conversation.item.truncate',
        item_id: 'item-b',
        content_index: 0,
        audio_end_ms: 100,
      },
    ]);
  });

  test('binds done marks to the exact content index', async () => {
    const { transport, twilio } = await createConnectedTransport();

    emitAudioDelta('item-a', 'response-a', 800, 0);
    emitAudioDelta('item-a', 'response-a', 800, 1);
    emitAudioDone('item-a', 'response-a', 0);
    const [contentZeroMark, contentOneMark, doneMark] =
      twilioMarks(twilio).slice(-3);
    returnTwilioMark(twilio, contentZeroMark.mark.name);
    returnTwilioMark(twilio, contentOneMark.mark.name);
    returnTwilioMark(twilio, doneMark.mark.name);

    transport.interrupt(false);

    expect(
      openAIEvents().filter(
        (event) => event.type === 'conversation.item.truncate',
      ),
    ).toEqual([
      {
        type: 'conversation.item.truncate',
        item_id: 'item-a',
        content_index: 1,
        audio_end_ms: 100,
      },
    ]);
  });
});
