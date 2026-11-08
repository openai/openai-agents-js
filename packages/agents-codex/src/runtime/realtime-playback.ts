export type NativeRealtimeAudioFormat = 'pcm16' | 'g711_ulaw' | 'g711_alaw';

/** Encoded mono audio without a container. PCM16 uses24kHz; G.711 uses8kHz. */
export interface NativeRealtimeAudioInput {
  readonly data: Uint8Array;
  readonly format: NativeRealtimeAudioFormat;
}

/** Actual playback measured from the start of one received audio content. */
export interface NativeRealtimePlaybackPosition {
  readonly responseId: string;
  readonly itemId: string;
  readonly contentIndex: number;
  readonly audioEndMs: number;
}

interface ReceivedAudio {
  responseId?: string;
  itemId?: string;
  contentIndex?: number;
  format?: NativeRealtimeAudioFormat;
  sampleRate: number;
  channels: number;
  data: Uint8Array;
}

/** Private accounting; received bytes alone never imply playback. */
export class NativeRealtimePlayback {
  private readonly items = new Map<
    string,
    {
      samples: number;
      rate: number;
      channels: number;
      format: NativeRealtimeAudioFormat | undefined;
      played?: NativeRealtimePlaybackPosition;
    }
  >();
  constructor(private readonly limit: number) {}
  private key(responseId: string, itemId: string, index: number): string {
    return JSON.stringify([responseId, itemId, index]);
  }
  observe(audio: ReceivedAudio): void {
    const { responseId, itemId, contentIndex, sampleRate, channels, format } =
      audio;
    if (!responseId || !itemId || contentIndex === undefined) return;
    const width = format === 'g711_ulaw' || format === 'g711_alaw' ? 1 : 2;
    const stride = width * channels;
    if (
      !Number.isSafeInteger(contentIndex) ||
      contentIndex < 0 ||
      !Number.isSafeInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isSafeInteger(channels) ||
      channels <= 0 ||
      audio.data.length % stride
    )
      throw new Error('Native Realtime output has invalid audio framing');
    const key = this.key(responseId, itemId, contentIndex);
    const previous = this.items.get(key);
    if (!previous && this.items.size >= this.limit)
      throw new Error('Native Realtime playback item capacity exceeded');
    if (
      previous &&
      (previous.rate !== sampleRate ||
        previous.channels !== channels ||
        previous.format !== format)
    )
      throw new Error(
        'Native Realtime audio format changed within one content',
      );
    const samples = (previous?.samples ?? 0) + audio.data.length / stride;
    if (!Number.isSafeInteger(samples))
      throw new Error('Native Realtime playback sample capacity exceeded');
    this.items.set(key, {
      samples,
      rate: sampleRate,
      channels,
      format,
      played: previous?.played,
    });
  }
  report(
    position: NativeRealtimePlaybackPosition,
  ): NativeRealtimePlaybackPosition {
    if (
      !position ||
      typeof position.responseId !== 'string' ||
      !position.responseId ||
      typeof position.itemId !== 'string' ||
      !position.itemId ||
      !Number.isSafeInteger(position.contentIndex) ||
      position.contentIndex < 0 ||
      !Number.isSafeInteger(position.audioEndMs) ||
      position.audioEndMs < 0
    )
      throw new TypeError(
        'Playback requires exact content identity and nonnegative integer time',
      );
    const item = this.items.get(
      this.key(position.responseId, position.itemId, position.contentIndex),
    );
    if (!item)
      throw new TypeError('Playback position does not identify received audio');
    if (position.audioEndMs > Math.floor((item.samples * 1000) / item.rate))
      throw new TypeError('Playback position exceeds received audio');
    if (position.audioEndMs < (item.played?.audioEndMs ?? 0))
      throw new TypeError('Playback position cannot move backwards');
    return (item.played = Object.freeze({ ...position }));
  }
  position(
    responseId: string,
    itemId: string,
    contentIndex: number,
  ): NativeRealtimePlaybackPosition | undefined {
    return this.items.get(this.key(responseId, itemId, contentIndex))?.played;
  }
}

export function playbackPayload(
  position: NativeRealtimePlaybackPosition | undefined,
) {
  return position
    ? {
        response_id: position.responseId,
        item_id: position.itemId,
        content_index: position.contentIndex,
        audio_end_ms: position.audioEndMs,
      }
    : null;
}
