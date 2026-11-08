export type AudioSamples = Int16Array | Float32Array;
/** Application-owned mono samples; providers must not mutate them. */
export interface AudioFrame<T extends AudioSamples = Int16Array> {
  readonly data: T;
  readonly sampleRate: 24000;
  readonly channels: 1;
}

export function assertAudioFrame(frame: AudioFrame<AudioSamples>): void {
  if (
    !(frame.data instanceof Int16Array || frame.data instanceof Float32Array) ||
    frame.sampleRate !== 24000 ||
    frame.channels !== 1
  )
    throw new TypeError(
      'Voice audio must be mono int16 or float32 at 24000 Hz',
    );
  if (
    frame.data instanceof Float32Array &&
    frame.data.some((value) => !Number.isFinite(value))
  )
    throw new TypeError('Float32 voice samples must be finite');
}

export function pcmBytes(frame: AudioFrame<AudioSamples>): Buffer {
  assertAudioFrame(frame);
  const bytes = Buffer.alloc(frame.data.length * 2);
  for (let i = 0; i < frame.data.length; i++) {
    const sample = frame.data[i];
    bytes.writeInt16LE(
      frame.data instanceof Int16Array
        ? sample
        : Math.round(
            Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
          ),
      i * 2,
    );
  }
  return bytes;
}
