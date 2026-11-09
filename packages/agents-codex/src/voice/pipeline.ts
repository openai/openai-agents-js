import type { VoiceWorkflow } from './workflow';
import type { TraceSpan } from '../runtime/tracing-context';
import { traceVoice, type VoiceTracingOptions } from './tracing';

import { assertAudioFrame, type AudioFrame, type AudioSamples } from './audio';
export type { AudioFrame, AudioSamples } from './audio';
export { assertAudioFrame, pcmBytes } from './audio';
/** Commit ends an utterance. Source EOF commits any remaining nonempty audio. */
export type AudioInput =
  | AudioFrame<AudioSamples>
  | AsyncIterable<AudioFrame<AudioSamples> | { readonly type: 'commit' }>;
export type VoiceOutputDtype = 'int16' | 'float32';
type OutputSamples<D extends VoiceOutputDtype> = D extends 'float32'
  ? Float32Array
  : Int16Array;
export type VoiceEvent<D extends VoiceOutputDtype = 'int16'> =
  | { type: 'audio'; frame: AudioFrame<OutputSamples<D>> }
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
/** Emitted segments followed by remainder must reconstruct the pending text exactly. */
export type VoiceTextSplitter = (
  text: string,
  final: boolean,
) => {
  segments: readonly string[];
  remainder: string;
};
export type VoicePipelineOptions<D extends VoiceOutputDtype = 'int16'> = {
  workflow: VoiceWorkflow;
  provider: SpeechProvider;
  textSplitter?: VoiceTextSplitter;
  /** Runs synchronously after dtype conversion, before buffering. */
  outputTransform?: (
    frame: AudioFrame<OutputSamples<D>>,
  ) => AudioFrame<OutputSamples<D>>;
  /** Omitted emits immediately; a positive count flushes its tail at each synthesis boundary. */
  bufferSamples?: number;
  tracing?: VoiceTracingOptions;
} & ('int16' extends D ? { outputDtype?: D } : { outputDtype: D });

const splitSentences: VoiceTextSplitter = (text, final) => {
  if (final) return { segments: text ? [text] : [], remainder: '' };
  const segments: string[] = [];
  let match: RegExpExecArray | null;
  // A text delta can end inside a decimal or URL; wait for whitespace.
  while ((match = /^([\s\S]*?[.!?]\s+)/.exec(text))) {
    segments.push(match[0]);
    text = text.slice(match[0].length);
  }
  return { segments, remainder: text };
};

/** Ordered synthesis with caller-owned input, playback and native Session lifetime. */
export class VoicePipeline<D extends VoiceOutputDtype = 'int16'> {
  private readonly options: VoicePipelineOptions<D>;
  constructor(options: VoicePipelineOptions<D>) {
    if (
      options.bufferSamples !== undefined &&
      (!Number.isSafeInteger(options.bufferSamples) ||
        options.bufferSamples <= 0)
    )
      throw new TypeError('bufferSamples must be a positive safe integer');
    if (
      options.outputDtype !== undefined &&
      !['int16', 'float32'].includes(options.outputDtype)
    )
      throw new TypeError('Unsupported voice output dtype');
    this.options = {
      ...options,
      tracing: options.tracing && { ...options.tracing },
    };
  }

  async *run(
    input: AudioInput,
    { signal }: { signal?: AbortSignal } = {},
  ): AsyncGenerator<VoiceEvent<D>> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      yield* traceVoice(
        'pipeline',
        this.options.tracing,
        undefined,
        (capture) => this.turns(input, controller.signal, capture.span),
      );
    } finally {
      controller.abort();
      signal?.removeEventListener('abort', abort);
    }
  }

  private async *turns(
    input: AudioInput,
    signal: AbortSignal,
    parent?: TraceSpan,
  ): AsyncGenerator<VoiceEvent<D>> {
    const options = { signal };
    const transcripts = traceVoice(
      'transcription',
      this.options.tracing,
      parent,
      (capture) => {
        let observed = input;
        if ('data' in input) capture.audio(input);
        else
          observed = (async function* () {
            for await (const item of input) {
              if ('data' in item) capture.audio(item);
              yield item;
            }
          })();
        return this.options.provider.transcribe(observed, options);
      },
      (capture, text) => capture.text('outputText', text),
    );
    for await (const transcription of transcripts) {
      signal.throwIfAborted();
      if (!transcription.trim()) continue;
      yield { type: 'turn_started' };
      let pending = '';
      const texts = traceVoice(
        'workflow',
        this.options.tracing,
        parent,
        (capture) => {
          capture.text('inputText', transcription);
          return this.options.workflow.run(transcription, options);
        },
        (capture, text) => capture.text('outputText', text),
      );
      const split = (final: boolean) => {
        const result = (this.options.textSplitter ?? splitSentences)(
          pending,
          final,
        );
        if (
          !result ||
          !Array.isArray(result.segments) ||
          result.segments.some(
            (value) => typeof value !== 'string' || !value.length,
          ) ||
          typeof result.remainder !== 'string' ||
          result.segments.join('') + result.remainder !== pending ||
          (final && result.remainder)
        )
          throw new TypeError(
            'Voice text splitter must preserve all text and consume the final remainder',
          );
        pending = result.remainder;
        return result.segments;
      };
      for await (const text of texts) {
        signal.throwIfAborted();
        pending += text;
        for (const segment of split(false))
          yield* this.speech(segment, signal, parent);
      }
      for (const segment of split(true))
        yield* this.speech(segment, signal, parent);
      yield { type: 'turn_ended' };
    }
    signal.throwIfAborted();
    yield { type: 'session_ended' };
  }

  private async *speech(
    text: string,
    signal: AbortSignal,
    parent?: TraceSpan,
  ): AsyncGenerator<VoiceEvent<D>> {
    if (!text.trim()) return;
    const samples = traceVoice(
      'synthesis',
      this.options.tracing,
      parent,
      (capture) => {
        capture.text('inputText', text);
        return this.options.provider.synthesize(text, { signal });
      },
      (capture, frame) => capture.audio(frame),
    );
    const parts: OutputSamples<D>[] = [];
    let buffered = 0;
    const output = (count: number): AudioFrame<OutputSamples<D>> => {
      const data = (
        this.options.outputDtype === 'float32'
          ? new Float32Array(count)
          : new Int16Array(count)
      ) as OutputSamples<D>;
      let offset = 0;
      for (const part of parts) {
        data.set(part, offset);
        offset += part.length;
      }
      parts.length = 0;
      buffered = 0;
      return { data, sampleRate: 24000, channels: 1 };
    };
    for await (const frame of samples) {
      signal.throwIfAborted();
      assertAudioFrame(frame);
      if (!(frame.data instanceof Int16Array))
        throw new TypeError('Speech provider output must be PCM16');
      const data = (
        this.options.outputDtype === 'float32'
          ? Float32Array.from(
              frame.data,
              (value) => value / (value < 0 ? 32768 : 32767),
            )
          : frame.data.slice()
      ) as OutputSamples<D>;
      const converted: AudioFrame<OutputSamples<D>> = { ...frame, data };
      const transformed = this.options.outputTransform
        ? this.options.outputTransform(converted)
        : converted;
      assertAudioFrame(transformed);
      if (
        this.options.outputDtype === 'float32'
          ? !(transformed.data instanceof Float32Array)
          : !(transformed.data instanceof Int16Array)
      )
        throw new TypeError(
          'Voice output transform must preserve the selected dtype',
        );
      signal.throwIfAborted();
      const size = this.options.bufferSamples;
      if (size === undefined) {
        if (transformed.data.length)
          yield { type: 'audio', frame: transformed };
      } else {
        for (let offset = 0; offset < transformed.data.length;) {
          const end = Math.min(
            transformed.data.length,
            offset + size - buffered,
          );
          const part = transformed.data.slice(offset, end) as OutputSamples<D>;
          parts.push(part);
          buffered += part.length;
          offset = end;
          if (buffered === size) yield { type: 'audio', frame: output(size) };
        }
      }
    }
    signal.throwIfAborted();
    if (buffered) yield { type: 'audio', frame: output(buffered) };
  }
}
