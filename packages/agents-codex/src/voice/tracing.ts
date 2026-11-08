import { startSpan, type TraceSpan } from '../runtime/tracing-context';
import type { JsonValue } from '../runtime/binding';
import { pcmBytes, type AudioFrame, type AudioSamples } from './audio';

/** Native speech tracing is opt-in; payloads are bounded diagnostic prefixes. */
export interface VoiceTracingOptions {
  captureText?: boolean;
  captureAudio?: boolean;
}

/** Only requested, ancestry-permitted prefixes are retained; never whole segments. */
class VoiceCapture {
  private readonly data: Record<string, JsonValue> = {};
  private readonly audioParts: Buffer[] = [];
  private audioBytes = 0;
  constructor(
    readonly span: TraceSpan | undefined,
    private readonly options: VoiceTracingOptions | undefined,
  ) {}
  text(field: 'inputText' | 'outputText', text: string): void {
    if (!this.options?.captureText || !this.span?.context.includeSensitiveData)
      return;
    let prefix = (this.data[field] as string | undefined) ?? '';
    // 256 code points per field also bounds JSON escaping below the native limit.
    let count = [...prefix].length;
    for (const character of text) {
      if (count++ >= 256) {
        this.data[`${field}Truncated`] = true;
        break;
      }
      prefix += character;
    }
    this.data[field] = prefix;
  }
  audio(frame: AudioFrame<AudioSamples>): void {
    if (!this.options?.captureAudio || !this.span?.context.includeSensitiveData)
      return;
    const remaining = (512 - this.audioBytes) / 2;
    if (frame.data.length > remaining) this.data.audioTruncated = true;
    if (!remaining) return;
    const bytes = pcmBytes({
      ...frame,
      data: frame.data.subarray(0, remaining),
    });
    this.audioParts.push(bytes);
    this.audioBytes += bytes.length;
  }
  finish(status: 'ok' | 'error' | 'cancelled'): void {
    if (!this.span) return;
    try {
      if (this.audioBytes) {
        this.data.audio = Buffer.concat(this.audioParts).toString('base64');
        this.data.audioFormat = 'pcm16le';
      }
      this.span.end({ status, data: this.data });
    } finally {
      this.span.close();
    }
  }
}

/** Observational tracing never replaces a processing or consumer failure. */
export async function* traceVoice<T>(
  stage: string,
  options: VoiceTracingOptions | undefined,
  parent: TraceSpan | undefined,
  produce: (capture: VoiceCapture) => AsyncIterable<T>,
  observe?: (capture: VoiceCapture, value: T) => void,
): AsyncGenerator<T> {
  let span: TraceSpan | undefined;
  if (options) {
    try {
      span = await startSpan({
        name: `voice.${stage}`,
        parent,
        includeSensitiveData: !!(options.captureText || options.captureAudio),
        metadata: { stage, sampleRate: 24000, channels: 1 },
      });
    } catch {
      // Export or optional tracing setup must not stop voice processing.
    }
  }
  const capture = new VoiceCapture(span, options);
  let status: 'ok' | 'error' | 'cancelled' = 'cancelled';
  try {
    for await (const value of produce(capture)) {
      observe?.(capture, value);
      yield value;
    }
    status = 'ok';
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    try {
      capture.finish(status);
    } catch {
      // Native telemetry failures do not change the processing outcome.
    }
  }
}
