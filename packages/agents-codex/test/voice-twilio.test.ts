import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  bridgeTwilioVoice,
  type TwilioVoiceOptions,
} from '../src/voice/twilio';
import type {
  NativeRealtimeEvent,
  NativeRealtimeOptions,
  NativeRealtimeSession,
} from '../src/runtime/realtime';

class Media {
  private queue: NativeRealtimeEvent[] = [];
  private changed = Promise.withResolvers<void>();
  private ended = false;
  sendAudio = vi.fn(async (_input: { data: Uint8Array; format: string }) => {});
  reportPlayback = vi.fn();
  interrupt = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.ended = true;
    this.changed.resolve();
  });
  push(event: NativeRealtimeEvent) {
    this.queue.push(event);
    this.changed.resolve();
  }
  async *events() {
    while (!this.ended) {
      if (this.queue.length) yield this.queue.shift()!;
      else {
        await this.changed.promise;
        this.changed = Promise.withResolvers<void>();
      }
    }
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function connect(
  options: Partial<Omit<TwilioVoiceOptions, 'socket' | 'session'>> = {},
  open?: (
    media: Media,
    options: NativeRealtimeOptions,
  ) => Promise<NativeRealtimeSession>,
  beforeBridge?: (socket: WebSocket) => void,
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connected = new Promise<WebSocket>((resolve) =>
    server.once('connection', resolve),
  );
  const address = server.address();
  if (typeof address === 'string' || !address)
    throw new Error('Missing test address');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, 'open');
  const socket = await connected;
  const frames: Record<string, any>[] = [];
  client.on('message', (data) => frames.push(JSON.parse(data.toString())));
  const media = new Media();
  const session = {
    realtime: vi.fn(async (options: NativeRealtimeOptions) =>
      open ? open(media, options) : (media as unknown as NativeRealtimeSession),
    ),
  };
  beforeBridge?.(socket);
  const running = bridgeTwilioVoice({
    socket,
    session,
    inputAudioInactivityTimeoutMs: null,
    ...options,
  });
  void running.catch(() => {});
  cleanup.push(async () => {
    client.close();
    await running.catch(() => {});
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const send = (frame: object) => client.send(JSON.stringify(frame));
  send({
    event: 'start',
    start: {
      streamSid: 'call',
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  });
  return { client, socket, media, session, frames, running, send };
}

function audio(responseId: string, value: number): NativeRealtimeEvent {
  return {
    type: 'audio',
    responseId,
    itemId: `item-${responseId}`,
    contentIndex: 0,
    format: 'g711_ulaw',
    sampleRate: 8000,
    channels: 1,
    data: new Uint8Array(80).fill(value),
  };
}
function done(responseId: string): NativeRealtimeEvent {
  return { type: 'response', status: 'done', responseId };
}

describe('native Twilio media bridge', () => {
  it('defaults to telephony audio and fills timestamp gaps without replaying overlap', async () => {
    const { send, media, session } = await connect();
    const packet = (timestamp: number, value: number) => ({
      event: 'media',
      streamSid: 'call',
      media: {
        timestamp: String(timestamp),
        payload: Buffer.alloc(160, value).toString('base64'),
      },
    });
    send(packet(0, 7));
    send(packet(40, 9));
    send(packet(40, 9));
    await vi.waitFor(() => expect(media.sendAudio).toHaveBeenCalledTimes(3));
    expect(session.realtime).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { inputFormat: 'g711_ulaw', outputFormat: 'g711_ulaw' },
      }),
    );
    expect(
      media.sendAudio.mock.calls.map(([input]) => [...input.data]),
    ).toEqual([Array(160).fill(7), Array(160).fill(255), Array(160).fill(9)]);
  });

  it('invalidates cleared marks before releasing the next response', async () => {
    const { media, frames, send } = await connect();
    media.push(audio('A', 1));
    media.push(audio('A', 2));
    media.push(done('A'));
    media.push(audio('B', 3));
    media.push(done('B'));
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.event === 'mark')).toHaveLength(2),
    );
    expect(frames.filter((frame) => frame.event === 'media')).toHaveLength(2);
    const oldMarks = frames.filter((frame) => frame.event === 'mark');
    send({ event: 'mark', streamSid: 'call', mark: oldMarks[0].mark });
    await vi.waitFor(() =>
      expect(media.reportPlayback).toHaveBeenCalledTimes(1),
    );
    expect(media.reportPlayback).toHaveBeenLastCalledWith({
      responseId: 'A',
      itemId: 'item-A',
      contentIndex: 0,
      audioEndMs: 10,
    });
    media.push({
      type: 'playback_interrupted',
      responseId: 'A',
      retiredResponseIds: ['A'],
    });
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.event === 'media')).toHaveLength(3),
    );
    const clearIndex = frames.findIndex((frame) => frame.event === 'clear');
    expect(clearIndex).toBeGreaterThan(-1);
    expect(frames[clearIndex + 1].event).toBe('media');
    expect(Buffer.from(frames[clearIndex + 1].media.payload, 'base64')).toEqual(
      Buffer.alloc(80, 3),
    );
    send({ event: 'mark', streamSid: 'call', mark: oldMarks[1].mark });
    const newMark = frames.filter((frame) => frame.event === 'mark').at(-1)!;
    send({ event: 'mark', streamSid: 'call', mark: newMark.mark });
    await vi.waitFor(() =>
      expect(media.reportPlayback).toHaveBeenCalledTimes(2),
    );
    expect(media.reportPlayback).toHaveBeenLastCalledWith({
      responseId: 'B',
      itemId: 'item-B',
      contentIndex: 0,
      audioEndMs: 10,
    });
  });

  it('does not clear B for a delayed interruption of fully played A', async () => {
    const { media, frames, send } = await connect();
    media.push(audio('A', 1));
    media.push(done('A'));
    media.push(audio('B', 2));
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.event === 'mark')).toHaveLength(1),
    );
    send({
      event: 'mark',
      streamSid: 'call',
      mark: frames.find((frame) => frame.event === 'mark')!.mark,
    });
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.event === 'media')).toHaveLength(2),
    );
    media.push({
      type: 'playback_interrupted',
      responseId: 'A',
      retiredResponseIds: ['A'],
    });
    media.push(audio('B', 3));
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.event === 'media')).toHaveLength(3),
    );
    expect(frames.some((frame) => frame.event === 'clear')).toBe(false);
    expect(media.close).not.toHaveBeenCalled();
  });

  it('uses actual played time for barge-in and discards all queued speech', async () => {
    const { media, frames, send } = await connect();
    media.push(audio('A', 1));
    media.push(audio('A', 2));
    media.push(done('A'));
    media.push(audio('B', 3));
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.event === 'mark')).toHaveLength(2),
    );
    send({
      event: 'mark',
      streamSid: 'call',
      mark: frames.find((frame) => frame.event === 'mark')!.mark,
    });
    await vi.waitFor(() =>
      expect(media.reportPlayback).toHaveBeenCalledTimes(1),
    );
    media.push({ type: 'lifecycle', status: 'speech_started' });
    await vi.waitFor(() => expect(media.interrupt).toHaveBeenCalledTimes(1));
    expect(media.interrupt).toHaveBeenCalledWith(undefined, {
      playback: {
        responseId: 'A',
        itemId: 'item-A',
        contentIndex: 0,
        audioEndMs: 10,
      },
    });
    expect(frames.filter((frame) => frame.event === 'media')).toHaveLength(2);
  });

  it('pads stalled active speech once and avoids padding the same gap twice', async () => {
    const { media, send } = await connect({ inputAudioInactivityTimeoutMs: 1 });
    send({
      event: 'media',
      media: {
        timestamp: '0',
        payload: Buffer.alloc(160, 4).toString('base64'),
      },
    });
    await vi.waitFor(() => expect(media.sendAudio).toHaveBeenCalledTimes(1));
    media.push({ type: 'lifecycle', status: 'speech_started' });
    await vi.waitFor(() => expect(media.sendAudio).toHaveBeenCalledTimes(2));
    expect(media.sendAudio.mock.calls[1][0].data).toEqual(
      new Uint8Array(8000).fill(255),
    );
    media.push({ type: 'lifecycle', status: 'speech_stopped' });
    send({
      event: 'media',
      media: {
        timestamp: '2000',
        payload: Buffer.alloc(160, 5).toString('base64'),
      },
    });
    await vi.waitFor(() => expect(media.sendAudio).toHaveBeenCalledTimes(3));
    expect(Buffer.from(media.sendAudio.mock.calls[2][0].data)).toEqual(
      Buffer.alloc(160, 5),
    );
  });

  it('joins media close when the Twilio connection ends', async () => {
    const { media, client, running, session } = await connect();
    client.close();
    await running;
    expect(media.close).toHaveBeenCalledOnce();
    expect(session.realtime).toHaveBeenCalledOnce();
  });

  it('rejects incompatible codec settings before native admission', async () => {
    const { socket, session } = await connect();
    await expect(
      bridgeTwilioVoice({
        socket,
        session,
        realtimeOptions: { settings: { outputFormat: 'pcm16' } },
      }),
    ).rejects.toThrow('requires g711_ulaw');
    expect(session.realtime).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { type: 'server_vad', createResponse: false },
    { type: 'semantic_vad', createResponse: false },
  ] as const)(
    'rejects unsupported manual turn detection %j before acquiring the call',
    async (turnDetection) => {
      let checkSocket!: () => void;
      const { socket, session, running } = await connect(
        { realtimeOptions: { settings: { turnDetection } } },
        async () => {
          throw new Error('Unexpected native admission');
        },
        (socket) => {
          const on = vi.spyOn(socket, 'on');
          const close = vi.spyOn(socket, 'close');
          checkSocket = () => {
            expect(on).not.toHaveBeenCalled();
            expect(close).not.toHaveBeenCalled();
          };
        },
      );
      await expect(running).rejects.toThrow(
        'Twilio requires automatic VAD response creation',
      );
      expect(session.realtime).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(WebSocket.OPEN);
      checkSocket();
    },
  );

  it.each([
    { type: 'server_vad' },
    { type: 'server_vad', createResponse: true },
    { type: 'semantic_vad' },
    { type: 'semantic_vad', createResponse: true },
  ] as const)(
    'retains supported automatic turn detection %j',
    async (turnDetection) => {
      const { client, session, media, running } = await connect({
        realtimeOptions: { settings: { turnDetection } },
      });
      expect(session.realtime).toHaveBeenCalledOnce();
      expect(session.realtime.mock.calls[0][0].settings).toMatchObject({
        turnDetection,
        inputFormat: 'g711_ulaw',
        outputFormat: 'g711_ulaw',
      });
      client.close();
      await running;
      expect(media.close).toHaveBeenCalledOnce();
    },
  );

  it('retains and closes admission that finishes after cancellation', async () => {
    const pending = Promise.withResolvers<NativeRealtimeSession>();
    const controller = new AbortController();
    const { media, client, running } = await connect(
      { signal: controller.signal },
      () => pending.promise,
    );
    const reason = new Error('Cancelled while opening');
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const closed = once(client, 'close');
    controller.abort(reason);
    await closed;
    expect(settled).toBe(false);
    pending.resolve(media as unknown as NativeRealtimeSession);
    await expect(running).rejects.toBe(reason);
    expect(media.close).toHaveBeenCalledOnce();
    expect(media.sendAudio).not.toHaveBeenCalled();
  });

  it('closes both media connections on input overflow', async () => {
    const { client, media, running } = await connect();
    client.send(' '.repeat(2 * 1024 * 1024 + 1));
    await expect(running).rejects.toThrow('input buffer overflow');
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(media.close).toHaveBeenCalledOnce();
  });

  it('handles a stop message while native admission is pending', async () => {
    const pending = Promise.withResolvers<NativeRealtimeSession>();
    const { media, send, client, running, session } = await connect(
      {},
      () => pending.promise,
    );
    const closed = once(client, 'close');
    send({ event: 'stop', streamSid: 'call' });
    await closed;
    expect(session.realtime.mock.calls[0][0].signal?.aborted).toBe(true);
    pending.resolve(media as unknown as NativeRealtimeSession);
    await running;
    expect(media.close).toHaveBeenCalledOnce();
  });

  it('retains an admission failure after a remote stop', async () => {
    const pending = Promise.withResolvers<NativeRealtimeSession>();
    const { send, client, running } = await connect({}, () => pending.promise);
    const closed = once(client, 'close');
    send({ event: 'stop', streamSid: 'call' });
    await closed;
    const failure = new Error('Native cleanup failed');
    pending.reject(failure);
    await expect(running).rejects.toBe(failure);
  });

  it('handles a stop message while an audio write is pending', async () => {
    const pending = Promise.withResolvers<void>();
    const { media, send, running } = await connect();
    media.sendAudio.mockImplementationOnce(() => pending.promise);
    send({
      event: 'media',
      streamSid: 'call',
      media: { timestamp: 0, payload: Buffer.alloc(80).toString('base64') },
    });
    await vi.waitFor(() => expect(media.sendAudio).toHaveBeenCalledOnce());
    send({ event: 'stop', streamSid: 'call' });
    await vi.waitFor(() => expect(media.close).toHaveBeenCalledOnce());
    pending.resolve();
    await running;
  });

  it('discards old inactivity padding when newer audio arrives', async () => {
    const pending = Promise.withResolvers<void>();
    const { media, send } = await connect({ inputAudioInactivityTimeoutMs: 1 });
    media.sendAudio.mockImplementationOnce(() => pending.promise);
    send({
      event: 'media',
      streamSid: 'call',
      media: { timestamp: 0, payload: Buffer.alloc(80).toString('base64') },
    });
    await vi.waitFor(() => expect(media.sendAudio).toHaveBeenCalledOnce());
    media.push({ type: 'lifecycle', status: 'speech_started' });
    await vi.waitFor(() => expect(media.interrupt).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    send({
      event: 'media',
      streamSid: 'call',
      media: { timestamp: 10, payload: Buffer.alloc(80, 2).toString('base64') },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    pending.resolve();
    await vi.waitFor(() => expect(media.sendAudio).toHaveBeenCalledTimes(3));
    expect(media.sendAudio.mock.calls[1][0].data).toEqual(Buffer.alloc(80, 2));
    expect(media.sendAudio.mock.calls[2][0].data).toHaveLength(8000);
  });
});

it('discards the acknowledged response set atomically and preserves newer audio', async () => {
  const { media, frames, send } = await connect();
  media.push(audio('A', 1));
  media.push(done('A'));
  media.push(audio('B', 2));
  media.push(done('B'));
  media.push(audio('C', 3));
  media.push(done('C'));
  await vi.waitFor(() =>
    expect(frames.filter((frame) => frame.event === 'mark')).toHaveLength(1),
  );
  const oldMark = frames.find((frame) => frame.event === 'mark')!;
  media.push({
    type: 'playback_interrupted',
    retiredResponseIds: ['A', 'B'],
    cancelledResponseId: 'B',
  });
  await vi.waitFor(() =>
    expect(frames.filter((frame) => frame.event === 'mark')).toHaveLength(2),
  );
  expect(
    frames
      .filter((frame) => frame.event === 'media')
      .map((frame) => Buffer.from(frame.media.payload, 'base64')[0]),
  ).toEqual([1, 3]);
  expect(frames.filter((frame) => frame.event === 'clear')).toHaveLength(1);
  send({ event: 'mark', streamSid: 'call', mark: oldMark.mark });
  const currentMark = frames.filter((frame) => frame.event === 'mark').at(-1)!;
  send({ event: 'mark', streamSid: 'call', mark: currentMark.mark });
  await vi.waitFor(() => expect(media.reportPlayback).toHaveBeenCalledTimes(1));
  expect(media.reportPlayback).toHaveBeenLastCalledWith({
    responseId: 'C',
    itemId: 'item-C',
    contentIndex: 0,
    audioEndMs: 10,
  });
});
