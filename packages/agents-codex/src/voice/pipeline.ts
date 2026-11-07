import type { VoiceWorkflow } from './workflow';

/** Application-owned mono PCM16 samples; providers must not mutate them. */
export interface AudioFrame {
  readonly data: Int16Array;
  readonly sampleRate: 24000;
  readonly channels: 1;
}
/** Commit ends an utterance. Source EOF commits any remaining nonempty audio. */
export type AudioInput =
  AudioFrame | AsyncIterable<AudioFrame | { readonly type: 'commit' }>;
export type VoiceEvent =
  | { type: 'audio'; frame: AudioFrame }
  | { type: 'turn_started' | 'turn_ended' | 'session_ended' };
export interface SpeechProvider {
  transcribe(
    input: AudioInput,
    options: { signal: AbortSignal },
  ): AsyncIterable<string>;
  synthesize(
    text: string,
    options: { signal: AbortSignal },
  ): AsyncIterable<AudioFrame>;
}

export function pcmBytes(frame: AudioFrame): Buffer {
  if (
    !(frame.data instanceof Int16Array) ||
    frame.sampleRate !== 24000 ||
    frame.channels !== 1
  )
    throw new TypeError('Voice audio must be mono PCM16 at 24000 Hz');
  const bytes = Buffer.alloc(frame.data.length * 2);
  for (let i = 0; i < frame.data.length; i++)
    bytes.writeInt16LE(frame.data[i], i * 2);
  return bytes;
}

/** Ordered, serial synthesis with application-owned input, output, and native Session lifetime. */
export class VoicePipeline {
  constructor(
    private readonly options: {
      workflow: VoiceWorkflow;
      provider: SpeechProvider;
    },
  ) {}

  async *run(
    input: AudioInput,
    { signal }: { signal?: AbortSignal } = {},
  ): AsyncGenerator<VoiceEvent> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const options = { signal: controller.signal };
    try {
      for await (const transcription of this.options.provider.transcribe(
        input,
        options,
      )) {
        options.signal.throwIfAborted();
        if (!transcription.trim()) continue;
        yield { type: 'turn_started' };
        let pending = '';
        for await (const text of this.options.workflow.run(
          transcription,
          options,
        )) {
          options.signal.throwIfAborted();
          pending += text;
          let match: RegExpExecArray | null;
          while ((match = /^([\s\S]*?[.!?](?:\s+|$))/.exec(pending))) {
            const segment = match[0];
            pending = pending.slice(segment.length);
            for await (const frame of this.options.provider.synthesize(
              segment,
              options,
            )) {
              options.signal.throwIfAborted();
              yield { type: 'audio', frame };
            }
          }
        }
        if (pending.trim()) {
          for await (const frame of this.options.provider.synthesize(
            pending,
            options,
          )) {
            options.signal.throwIfAborted();
            yield { type: 'audio', frame };
          }
        }
        yield { type: 'turn_ended' };
      }
      options.signal.throwIfAborted();
      yield { type: 'session_ended' };
    } finally {
      controller.abort();
      signal?.removeEventListener('abort', abort);
    }
  }
}
