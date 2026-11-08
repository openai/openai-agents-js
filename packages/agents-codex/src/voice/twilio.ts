import { Buffer } from 'node:buffer';
import type WebSocket from 'ws';
import type { Session } from '../runtime/public-agent';
import type {
  NativeRealtimeEvent,
  NativeRealtimeOptions,
  NativeRealtimePlaybackPosition,
  NativeRealtimeSession,
} from '../runtime/realtime';

export interface TwilioVoiceOptions {
  /** An authenticated, application-owned Twilio Media Streams connection. */
  socket: WebSocket;
  session: Pick<Session<unknown>, 'realtime'>;
  realtimeOptions?: NativeRealtimeOptions;
  signal?: AbortSignal;
  /** Send one second of silence after active speech stalls; null disables it. */
  inputAudioInactivityTimeoutMs?: number | null;
  /** Observe the bridge's sole native event stream. */
  onEvent?: (event: NativeRealtimeEvent) => void;
}

interface PlaybackItem {
  position: NativeRealtimePlaybackPosition;
  sentSamples: number;
  playedSamples: number;
}
interface PlaybackResponse {
  id: string;
  done: boolean;
  chunks: { data: Uint8Array; item: PlaybackItem }[];
  items: Map<string, PlaybackItem>;
  pending: number;
}
interface PlaybackMark {
  response: PlaybackResponse;
  item: PlaybackItem;
  endSamples: number;
  bytes: number;
}

type InputFrame =
  | { data: Uint8Array; start: number; end: number }
  | { inactivityEpoch: number };

const BUFFER_BYTES = 2 * 1024 * 1024;
// Charge queued metadata too, so tiny or empty frames cannot bypass the bound.
const INPUT_FRAME_BYTES = 128;
const MESSAGE_LIMIT = 128;
const RESPONSE_LIMIT = 1024;

/**
 * Bridge Twilio to a new native Realtime generation on an existing Session.
 * Resolves after both media connections close; the caller's Session stays open.
 * Only one response enters Twilio's playback buffer at a time, so a late scoped
 * interruption can never clear another response. Mark ACKs, not received audio,
 * determine the position used for conversation truncation.
 */
export async function bridgeTwilioVoice({
  socket,
  session,
  realtimeOptions = {},
  signal,
  inputAudioInactivityTimeoutMs = 750,
  onEvent,
}: TwilioVoiceOptions): Promise<void> {
  for (const format of [
    realtimeOptions.settings?.inputFormat,
    realtimeOptions.settings?.outputFormat,
  ]) {
    if (format !== undefined && format !== 'g711_ulaw')
      throw new TypeError('Twilio requires g711_ulaw input and output');
  }
  const turnDetection = realtimeOptions.settings?.turnDetection;
  if (turnDetection === null || turnDetection?.createResponse === false)
    throw new TypeError('Twilio requires automatic VAD response creation');
  if (
    inputAudioInactivityTimeoutMs !== null &&
    (!Number.isSafeInteger(inputAudioInactivityTimeoutMs) ||
      inputAudioInactivityTimeoutMs < 0 ||
      inputAudioInactivityTimeoutMs > 2147483647)
  )
    throw new TypeError('Invalid Twilio input inactivity timeout');
  signal?.throwIfAborted();
  realtimeOptions.signal?.throwIfAborted();
  if (Number(socket.readyState) !== 1)
    throw new Error('Twilio WebSocket must already be open');

  const controller = new AbortController();
  const responses: PlaybackResponse[] = [];
  const retired = new Set<string>();
  const marks = new Map<string, PlaybackMark>();
  const incoming: InputFrame[] = [];
  const socketEnded = Promise.withResolvers<void>();
  let streamSid: string | undefined;
  let outputBytes = 0;
  let outputChunks = 0;
  let inputBytes = 0;
  let epoch = 0;
  let markSequence = 0;
  let stopped = false;
  let failure: unknown;
  let voice: NativeRealtimeSession | undefined;
  let inputPump: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let inactivity: ReturnType<typeof setTimeout> | undefined;
  let speechActive = false;
  let lastMediaAt: number | undefined;
  let nextInputSample: number | undefined;
  let paddedInactivity = false;
  let inputEpoch = 0;

  const clearTimer = () => {
    inputEpoch++;
    clearTimeout(inactivity);
    inactivity = undefined;
  };
  const stop = (error?: unknown) => {
    if (
      error !== undefined &&
      error !== controller.signal.reason &&
      failure === undefined
    )
      failure = error;
    if (stopped) return;
    stopped = true;
    clearTimer();
    controller.abort();
    socket.close();
    closing = admission
      .then((owner) => owner.close())
      .catch((closeError) => {
        if (closeError !== controller.signal.reason && failure === undefined)
          failure = closeError;
      });
  };
  const send = (frame: object) => socket.send(JSON.stringify(frame));
  const pumpOutput = () => {
    if (stopped || !streamSid) return;
    while (responses.length) {
      const response = responses[0];
      while (response.chunks.length && marks.size < MESSAGE_LIMIT) {
        const { data, item } = response.chunks.shift()!;
        item.sentSamples += data.byteLength;
        const name = `${epoch}:${++markSequence}`;
        marks.set(name, {
          response,
          item,
          endSamples: item.sentSamples,
          bytes: data.byteLength,
        });
        response.pending++;
        send({
          event: 'media',
          streamSid,
          media: { payload: Buffer.from(data).toString('base64') },
        });
        send({ event: 'mark', streamSid, mark: { name } });
      }
      if (!response.done || response.pending || response.chunks.length) return;
      responses.shift();
    }
  };
  const playbackPosition = () => {
    for (const item of responses[0]?.items.values() ?? []) {
      if (item.sentSamples > item.playedSamples)
        return {
          ...item.position,
          audioEndMs: Math.floor(item.playedSamples / 8),
        };
    }
    return undefined;
  };
  const discard = (responseIds?: readonly string[]) => {
    const active = responses[0];
    const clearsWire =
      active && (responseIds === undefined || responseIds.includes(active.id));
    const removed = responses.filter(
      (response) =>
        responseIds === undefined || responseIds.includes(response.id),
    );
    for (const response of removed) {
      retired.add(response.id);
      for (const chunk of response.chunks) {
        outputBytes -= chunk.data.byteLength;
        outputChunks--;
      }
      responses.splice(responses.indexOf(response), 1);
    }
    for (const id of responseIds ?? []) retired.add(id);
    // Native rejects audio for terminal, interrupted or unknown responses.
    // Retain only a bounded recent window for local interruption races.
    while (retired.size > RESPONSE_LIMIT)
      retired.delete(retired.values().next().value!);
    if (clearsWire) {
      // Twilio ACKs cleared marks too. Invalidate them before issuing clear.
      epoch++;
      for (const mark of marks.values()) {
        outputBytes -= mark.bytes;
        outputChunks--;
      }
      marks.clear();
      if (streamSid && active.pending) send({ event: 'clear', streamSid });
    }
    pumpOutput();
  };
  const silence = async (samples: number) => {
    while (!stopped && samples > 0) {
      const size = Math.min(samples, 8000);
      await voice!.sendAudio({
        data: new Uint8Array(size).fill(0xff),
        format: 'g711_ulaw',
      });
      samples -= size;
    }
  };
  const scheduleInactivity = () => {
    clearTimer();
    if (
      stopped ||
      !speechActive ||
      lastMediaAt === undefined ||
      inputAudioInactivityTimeoutMs === null
    )
      return;
    const currentEpoch = inputEpoch;
    inactivity = setTimeout(
      () => {
        inactivity = undefined;
        if (stopped || !speechActive) return;
        // The input worker owns ordering with real media and timestamp padding.
        enqueue({ inactivityEpoch: currentEpoch });
      },
      Math.max(0, inputAudioInactivityTimeoutMs - (Date.now() - lastMediaAt)),
    );
    inactivity.unref?.();
  };
  const receive = async (frame: InputFrame) => {
    if ('inactivityEpoch' in frame) {
      if (
        frame.inactivityEpoch === inputEpoch &&
        speechActive &&
        !paddedInactivity
      ) {
        await silence(8000);
        paddedInactivity = true;
      }
      return;
    }
    let { data } = frame;
    const { start, end } = frame;
    if (nextInputSample !== undefined) {
      if (start > nextInputSample && !paddedInactivity)
        await silence(Math.min(start - nextInputSample, 80000));
      if (start < nextInputSample)
        data = data.subarray(Math.min(data.length, nextInputSample - start));
    }
    nextInputSample = Math.max(nextInputSample ?? 0, end);
    paddedInactivity = false;
    if (data.length && !stopped)
      await voice!.sendAudio({ data, format: 'g711_ulaw' });
  };
  // Control messages must remain live while native admission or audio writes wait.
  const dispatch = (encoded: string) => {
    const frame = JSON.parse(encoded);
    if (frame.event === 'connected') return;
    if (frame.event === 'start') {
      const start = frame.start;
      if (
        !start ||
        typeof start.streamSid !== 'string' ||
        !start.streamSid ||
        start.mediaFormat?.encoding !== 'audio/x-mulaw' ||
        start.mediaFormat?.sampleRate !== 8000 ||
        start.mediaFormat?.channels !== 1 ||
        (streamSid !== undefined && streamSid !== start.streamSid)
      )
        throw new Error('Invalid Twilio stream start');
      streamSid = start.streamSid;
      pumpOutput();
      return;
    }
    if (frame.streamSid !== undefined && frame.streamSid !== streamSid)
      throw new Error('Twilio frame belongs to another stream');
    if (frame.event === 'stop') {
      stop();
      return;
    }
    if (!streamSid) throw new Error('Twilio media arrived before stream start');
    if (frame.event === 'mark') {
      const mark = marks.get(frame.mark?.name);
      if (!mark) return;
      marks.delete(frame.mark.name);
      outputBytes -= mark.bytes;
      outputChunks--;
      mark.response.pending--;
      mark.item.playedSamples = Math.max(
        mark.item.playedSamples,
        mark.endSamples,
      );
      voice!.reportPlayback({
        ...mark.item.position,
        audioEndMs: Math.floor(mark.item.playedSamples / 8),
      });
      pumpOutput();
      return;
    }
    if (frame.event !== 'media')
      throw new Error('Unsupported Twilio stream event');
    const media = frame.media;
    if (media?.track !== undefined && media.track !== 'inbound') return;
    const timestamp =
      typeof media?.timestamp === 'string' && /^\d+$/.test(media.timestamp)
        ? Number(media.timestamp)
        : media?.timestamp;
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      !Number.isSafeInteger(timestamp * 8) ||
      typeof media?.payload !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        media.payload,
      )
    )
      throw new Error('Invalid Twilio audio frame');
    const data = Buffer.from(media.payload, 'base64');
    const start = timestamp * 8;
    const end = start + data.length;
    if (!Number.isSafeInteger(end))
      throw new Error('Twilio timestamp exceeds the supported range');
    lastMediaAt = Date.now();
    enqueue({ data, start, end });
    scheduleInactivity();
  };
  function startInput() {
    inputPump ??= (async () => {
      voice ??= await admission;
      while (!stopped && incoming.length) {
        const next = incoming.shift()!;
        inputBytes -=
          INPUT_FRAME_BYTES + ('data' in next ? next.data.byteLength : 0);
        await receive(next);
      }
    })()
      .catch(stop)
      .finally(() => {
        inputPump = undefined;
        if (!stopped && incoming.length) startInput();
      });
  }
  const enqueue = (frame: InputFrame) => {
    if (stopped) return;
    const bytes =
      INPUT_FRAME_BYTES + ('data' in frame ? frame.data.byteLength : 0);
    if (inputBytes + bytes > BUFFER_BYTES) {
      stop(new Error('Twilio input buffer overflow'));
      return;
    }
    incoming.push(frame);
    inputBytes += bytes;
    startInput();
  };
  const message = (data: WebSocket.RawData) => {
    if (stopped) return;
    try {
      const encoded = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : Buffer.from(data as ArrayBuffer).toString();
      if (encoded.length > BUFFER_BYTES)
        throw new Error('Twilio input buffer overflow');
      dispatch(encoded);
    } catch (error) {
      stop(error);
    }
  };
  const closed = () => {
    socketEnded.resolve();
    stop();
  };
  const errored = (error: Error) => stop(error);
  const aborted = () => stop(signal?.reason);
  const optionsAborted = () => stop(realtimeOptions.signal?.reason);

  const admission = session.realtime({
    ...realtimeOptions,
    signal: controller.signal,
    settings: {
      ...realtimeOptions.settings,
      inputFormat: 'g711_ulaw',
      outputFormat: 'g711_ulaw',
    },
  });
  socket.on('message', message);
  socket.on('close', closed);
  socket.on('error', errored);
  signal?.addEventListener('abort', aborted, { once: true });
  realtimeOptions.signal?.addEventListener('abort', optionsAborted, {
    once: true,
  });
  try {
    if (socket.readyState === 3) socketEnded.resolve();
    if (socket.readyState !== 1) stop();
    voice = await admission;
    if (signal?.aborted) aborted();
    if (realtimeOptions.signal?.aborted) optionsAborted();
    for await (const event of voice.events()) {
      if (stopped) break;
      if (event.type === 'audio') {
        if (
          event.format !== 'g711_ulaw' ||
          event.sampleRate !== 8000 ||
          event.channels !== 1 ||
          !event.responseId ||
          !event.itemId ||
          event.contentIndex === undefined
        )
          throw new Error('Twilio requires identified G.711 mu-law output');
        if (!retired.has(event.responseId)) {
          if (
            outputBytes + event.data.byteLength > BUFFER_BYTES ||
            outputChunks >= RESPONSE_LIMIT
          )
            throw new Error('Twilio output buffer overflow');
          let response = responses.find((item) => item.id === event.responseId);
          if (!response) {
            response = {
              id: event.responseId,
              done: false,
              chunks: [],
              items: new Map(),
              pending: 0,
            };
            responses.push(response);
          }
          const key = JSON.stringify([event.itemId, event.contentIndex]);
          let item = response.items.get(key);
          if (!item) {
            item = {
              position: {
                responseId: event.responseId,
                itemId: event.itemId,
                contentIndex: event.contentIndex,
                audioEndMs: 0,
              },
              sentSamples: 0,
              playedSamples: 0,
            };
            response.items.set(key, item);
          }
          response.chunks.push({ data: event.data.slice(), item });
          outputBytes += event.data.byteLength;
          outputChunks++;
          pumpOutput();
        }
      } else if (event.type === 'response' && event.status === 'done') {
        const response = responses.find((item) => item.id === event.responseId);
        if (response) response.done = true;
        pumpOutput();
      } else if (event.type === 'playback_interrupted') {
        discard(event.retiredResponseIds);
      } else if (
        event.type === 'response' &&
        event.status === 'cancelled' &&
        event.responseId
      ) {
        discard([event.responseId]);
      } else if (
        event.type === 'lifecycle' &&
        event.status === 'speech_started'
      ) {
        speechActive = true;
        scheduleInactivity();
        const playback = playbackPosition();
        discard();
        await voice.interrupt(undefined, { playback });
      } else if (
        event.type === 'lifecycle' &&
        event.status === 'speech_stopped'
      ) {
        speechActive = false;
        clearTimer();
      }
      onEvent?.(event);
    }
  } catch (error) {
    if (error !== controller.signal.reason && failure === undefined)
      failure = error;
  } finally {
    stop();
    await socketEnded.promise;
    socket.off('message', message);
    socket.off('close', closed);
    socket.off('error', errored);
    signal?.removeEventListener('abort', aborted);
    realtimeOptions.signal?.removeEventListener('abort', optionsAborted);
    await closing;
    await inputPump;
  }
  if (failure !== undefined) throw failure;
}
