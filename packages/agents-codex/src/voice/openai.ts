import OpenAI, { toFile } from 'openai';
import WebSocket from 'ws';
import {
  pcmBytes,
  type AudioFrame,
  type AudioInput,
  type SpeechProvider,
} from './pipeline';

export interface OpenAISpeechProviderOptions {
  client?: OpenAI;
  apiKey?: string;
  baseURL?: string;
  transcriptionModel?: string;
  streamingTranscriptionModel?: string;
  synthesisModel?: string;
  voice?: string;
  /** Maximum wait for a transcription protocol acknowledgement, in milliseconds. */
  timeoutMs?: number;
}

/** Server-side speech provider. Streaming input uses explicit commits, without VAD. */
export class OpenAISpeechProvider implements SpeechProvider {
  private readonly client: OpenAI;
  private readonly options: OpenAISpeechProviderOptions;
  constructor(options: OpenAISpeechProviderOptions = {}) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    )
      throw new TypeError('timeoutMs must be positive');
    this.options = { ...options };
    this.client =
      options.client ??
      new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
  }

  async *transcribe(
    input: AudioInput,
    { signal }: { signal: AbortSignal },
  ): AsyncGenerator<string> {
    signal.throwIfAborted();
    if (!('data' in input)) {
      yield* this.streamTranscription(input, signal);
      return;
    }
    const pcm = pcmBytes(input);
    if (pcm.length === 0) return;
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    const result = await this.client.audio.transcriptions.create(
      {
        file: await toFile(Buffer.concat([header, pcm]), 'audio.wav'),
        model: this.options.transcriptionModel ?? 'gpt-transcribe',
      },
      { signal },
    );
    signal.throwIfAborted();
    yield result.text;
  }

  async *synthesize(
    text: string,
    { signal }: { signal: AbortSignal },
  ): AsyncGenerator<AudioFrame> {
    signal.throwIfAborted();
    const response = await this.client.audio.speech.create(
      {
        model: this.options.synthesisModel ?? 'gpt-4o-mini-tts',
        voice: this.options.voice ?? 'alloy',
        input: text,
        response_format: 'pcm',
      },
      { signal },
    );
    if (!response.body) throw new Error('Speech response has no audio body');
    const reader = response.body.getReader();
    let carry = Buffer.alloc(0);
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await abortable(reader.read(), signal);
        if (done) break;
        const bytes = Buffer.concat([carry, value]);
        const length = bytes.length - (bytes.length % 2);
        const data = new Int16Array(length / 2);
        for (let i = 0; i < data.length; i++)
          data[i] = bytes.readInt16LE(i * 2);
        carry = Buffer.from(bytes.subarray(length));
        if (data.length) yield { data, sampleRate: 24000, channels: 1 };
      }
      if (carry.length)
        throw new Error(
          'Speech response ended with an incomplete PCM16 sample',
        );
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* The processing error retains precedence. */
      }
      reader.releaseLock();
    }
  }

  private async *streamTranscription(
    input: Exclude<AudioInput, AudioFrame>,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const url = new URL('realtime', this.client.baseURL.replace(/\/?$/, '/'));
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    url.searchParams.set('intent', 'transcription');
    if (
      typeof this.client.apiKey !== 'string' ||
      !this.client.apiKey ||
      this.client.apiKey === '<Missing Key>'
    )
      throw new Error(
        'Streaming transcription requires a static API key on the speech client',
      );
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.client.apiKey}` },
    });
    const events: Record<string, unknown>[] = [];
    let failure: unknown;
    const transport = new AbortController();
    let wake: (() => void) | undefined;
    const fail = (error: unknown) => {
      failure ??= error;
      transport.abort(failure);
      wake?.();
    };
    const onAbort = () => fail(signal.reason);
    const onError = (error: Error) => fail(error);
    const onClose = () =>
      fail(new Error('Transcription connection closed before completion'));
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (
          event.type === 'error' ||
          event.type === 'conversation.item.input_audio_transcription.failed'
        ) {
          fail(new Error('Transcription provider reported a processing error'));
        } else if (
          [
            'session.updated',
            'input_audio_buffer.committed',
            'conversation.item.input_audio_transcription.completed',
          ].includes(String(event.type))
        ) {
          events.push(event);
          wake?.();
        }
      } catch {
        fail(new Error('Invalid transcription event'));
      }
    };
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('message', onMessage);
    signal.addEventListener('abort', onAbort, { once: true });
    const next = async () => {
      while (!events.length) {
        if (failure !== undefined) throw failure;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            () => fail(new Error('Transcription event timed out')),
            this.options.timeoutMs ?? 30000,
          );
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
      }
      signal.throwIfAborted();
      return events.shift()!;
    };
    const send = (event: object) => {
      signal.throwIfAborted();
      if (failure !== undefined) throw failure;
      socket.send(JSON.stringify(event));
    };
    const commit = async () => {
      send({ type: 'input_audio_buffer.commit' });
      const committed = await next();
      if (
        committed.type !== 'input_audio_buffer.committed' ||
        typeof committed.item_id !== 'string'
      )
        throw new Error('Expected a committed transcription item');
      const completed = await next();
      if (
        completed.type !==
          'conversation.item.input_audio_transcription.completed' ||
        completed.item_id !== committed.item_id ||
        typeof completed.transcript !== 'string'
      )
        throw new Error(
          'Expected the final transcript for the committed audio item',
        );
      return completed.transcript;
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error('Transcription connection timed out')),
          this.options.timeoutMs ?? 30000,
        );
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          socket.off('open', opened);
          socket.off('error', errored);
          socket.off('close', closed);
          signal.removeEventListener('abort', aborted);
          if (error !== undefined) reject(error);
          else resolve();
        };
        const opened = () => finish();
        const errored = (error: Error) => finish(error);
        const closed = () =>
          finish(new Error('Transcription connection closed before opening'));
        const aborted = () => finish(signal.reason);
        socket.once('open', opened);
        socket.once('error', errored);
        socket.once('close', closed);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      });
      send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: {
                model:
                  this.options.streamingTranscriptionModel ??
                  'gpt-live-transcribe',
              },
              turn_detection: null,
            },
          },
        },
      });
      if ((await next()).type !== 'session.updated')
        throw new Error('Expected transcription session setup');
      let buffered = false;
      const source = input[Symbol.asyncIterator]();
      try {
        for (;;) {
          signal.throwIfAborted();
          transport.signal.throwIfAborted();
          const result = await abortable(source.next(), transport.signal);
          if (result.done) break;
          const frame = result.value;
          signal.throwIfAborted();
          if ('type' in frame) {
            if (frame.type !== 'commit')
              throw new TypeError('Unsupported audio boundary');
            if (buffered) {
              yield await commit();
              buffered = false;
            }
          } else {
            const bytes = pcmBytes(frame);
            if (bytes.length) {
              send({
                type: 'input_audio_buffer.append',
                audio: bytes.toString('base64'),
              });
              buffered = true;
            }
          }
        }
        if (buffered) yield await commit();
      } finally {
        // The application owns its source. A stuck source.next/return cannot hold our socket open.
        void Promise.resolve()
          .then(() => source.return?.())
          .catch(() => {});
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      socket.off('message', onMessage);
      if (socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          socket.once('close', resolve);
          socket.terminate();
        });
      }
      socket.off('error', onError);
      socket.off('close', onClose);
    }
  }
}

/** Stop waiting without pretending to stop an application-owned source. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
