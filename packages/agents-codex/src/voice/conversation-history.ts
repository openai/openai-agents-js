import { encodeBase64 } from './base64';

export type VoiceHistoryItem = Readonly<Record<string, unknown>>;

/** Local provider observations only; these rows confer no execution authority. */
export class VoiceConversationHistory {
  private readonly items = new Map<string, Record<string, unknown>>();
  private readonly audio = new Map<
    string,
    {
      itemId: string;
      index: number;
      chunks: Uint8Array[];
      bytes: number;
      bytesPerMillisecond: number;
    }
  >();
  private readonly itemBytes = new Map<string, number>();
  private bytes = 0;
  private transcriptWork = 0;
  private audioBytes = 0;
  private audioChunks = 0;
  private audioSealed = false;
  private truncatedAudioKey?: string;
  private readonly maxBytes: number;
  private readonly maxItems: number;
  private readonly maxAudioBytes: number;
  private readonly storeAudio: boolean;

  constructor(
    options: {
      storeAudio?: boolean;
      maxBytes?: number;
      maxItems?: number;
      maxAudioBytes?: number;
    } = {},
  ) {
    this.storeAudio = options.storeAudio ?? false;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.maxItems = options.maxItems ?? 4096;
    this.maxAudioBytes = options.maxAudioBytes ?? 8 * 1024 * 1024;
  }

  observe(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const event = value as Record<string, any>;
    if (
      event.type === 'conversation.item.deleted' &&
      typeof event.item_id === 'string'
    ) {
      this.bytes -= this.itemBytes.get(event.item_id) ?? 0;
      this.itemBytes.delete(event.item_id);
      this.items.delete(event.item_id);
      this.dropAudio(event.item_id);
      return true;
    }
    if (
      event.type === 'response.done' &&
      Array.isArray(event.response?.output)
    ) {
      for (const item of event.response.output) this.put(item);
      return true;
    }
    if (
      [
        'conversation.item.created',
        'conversation.item.added',
        'conversation.item.done',
        'conversation.item.retrieved',
        'response.output_item.added',
        'response.output_item.done',
      ].includes(event.type)
    ) {
      return this.put(event.item, event.previous_item_id);
    }
    if (event.type === 'conversation.item.truncated') {
      const stored = this.items.get(event.item_id);
      if (!stored) return false;
      const item = JSON.parse(JSON.stringify(stored)) as Record<
        string,
        unknown
      >;
      const key = JSON.stringify([event.item_id, event.content_index ?? 0]);
      const retained = this.audio.get(key);
      if (
        retained &&
        Number.isFinite(event.audio_end_ms) &&
        event.audio_end_ms >= 0
      ) {
        let remaining = Math.min(
          retained.bytes,
          Math.floor(event.audio_end_ms * retained.bytesPerMillisecond),
        );
        this.audioBytes -= retained.bytes;
        this.audioChunks -= retained.chunks.length;
        const chunks: Uint8Array[] = [];
        for (const chunk of retained.chunks) {
          if (!remaining) break;
          const prefix = Uint8Array.from(chunk.subarray(0, remaining));
          chunks.push(prefix);
          remaining -= prefix.length;
        }
        retained.chunks = chunks;
        retained.bytes = chunks.reduce(
          (bytes, chunk) => bytes + chunk.length,
          0,
        );
        this.audioBytes += retained.bytes;
        this.audioChunks += chunks.length;
      }
      const content = item.content as Record<string, unknown>[] | undefined;
      if (Array.isArray(content))
        for (const [index, part] of content.entries()) {
          if (index !== (event.content_index ?? 0) || !part) continue;
          if (part.type === 'audio' || part.type === 'output_audio')
            delete part.transcript;
        }
      item.audio_end_ms = event.audio_end_ms;
      return this.put(item);
    }
    const transcription =
      event.type === 'conversation.item.input_audio_transcription.completed';
    const text =
      typeof event.type === 'string' &&
      /^response\.(?:output_text|text)\.(?:delta|done)$/.test(event.type);
    const transcript =
      typeof event.type === 'string' &&
      /^response\.(?:output_audio_transcript|audio_transcript)\.(?:delta|done)$/.test(
        event.type,
      );
    if (
      (text || transcript || transcription) &&
      typeof event.item_id === 'string'
    ) {
      const stored = this.items.get(event.item_id);
      if (!stored) return false;
      const item = JSON.parse(JSON.stringify(stored)) as Record<
        string,
        unknown
      >;
      const index = event.content_index ?? 0;
      if (!Number.isSafeInteger(index) || index < 0 || index >= 1024)
        return false;
      const content = Array.isArray(item.content)
        ? (item.content as Record<string, unknown>[])
        : [];
      item.content = content;
      const part = (content[index] ??= {
        type: transcription
          ? 'input_audio'
          : text
            ? 'output_text'
            : 'output_audio',
      });
      const field = text ? 'text' : 'transcript';
      const next =
        transcription || event.type.endsWith('.done')
          ? (event.text ?? event.transcript)
          : (typeof part[field] === 'string' ? part[field] : '') +
            (event.delta ?? '');
      if (typeof next !== 'string') return false;
      this.transcriptWork += utf8Bytes(next);
      if (this.transcriptWork > this.maxBytes * 4)
        throw new Error('Voice conversation transcript work capacity exceeded');
      part[field] = next;
      return this.put(item);
    }
    return false;
  }

  observeAudio(
    itemId: string,
    index: number,
    data: Uint8Array,
    bytesPerMillisecond = 48,
  ): void {
    if (
      !this.storeAudio ||
      this.audioSealed ||
      !itemId ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= 1024 ||
      !data.byteLength ||
      !Number.isFinite(bytesPerMillisecond) ||
      bytesPerMillisecond <= 0
    )
      return;
    const key = JSON.stringify([itemId, index]);
    if (
      this.audioBytes + data.byteLength > this.maxAudioBytes ||
      this.audioChunks >= 4096
    ) {
      this.audioSealed = true;
      this.truncatedAudioKey = key;
      return;
    }
    const retained = this.audio.get(key) ?? {
      itemId,
      index,
      chunks: [],
      bytes: 0,
      bytesPerMillisecond,
    };
    if (retained.bytesPerMillisecond !== bytesPerMillisecond) return;
    retained.chunks.push(Uint8Array.from(data));
    this.audioChunks++;
    retained.bytes += data.byteLength;
    this.audioBytes += data.byteLength;
    this.audio.set(key, retained);
  }

  snapshot(): readonly VoiceHistoryItem[] {
    const items = this.providerSnapshot() as Record<string, any>[];
    for (const retained of this.audio.values()) {
      const item = items.find((item) => item.id === retained.itemId);
      if (!item) continue;
      const content = (item.content ??= []);
      const part = (content[retained.index] ??= { type: 'output_audio' });
      const data = new Uint8Array(retained.bytes);
      let offset = 0;
      for (const chunk of retained.chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      part.audio = encodeBase64(data);
      if (
        this.truncatedAudioKey ===
        JSON.stringify([retained.itemId, retained.index])
      )
        part.audio_truncated = true;
    }
    return items;
  }

  /** Compact copy of the current view, including retained audio. */
  serializeSnapshot(): string {
    return JSON.stringify(
      this.audio.size ? this.snapshot() : [...this.items.values()],
    );
  }

  /** Provider rows without locally retained playback bytes. */
  providerSnapshot(): readonly VoiceHistoryItem[] {
    return [...this.items.values()].map(
      (item) => JSON.parse(JSON.stringify(item)) as Record<string, unknown>,
    );
  }

  clear(): void {
    this.items.clear();
    this.itemBytes.clear();
    this.bytes = 0;
    this.transcriptWork = 0;
    this.audio.clear();
    this.audioBytes = 0;
    this.audioChunks = 0;
    this.audioSealed = false;
    this.truncatedAudioKey = undefined;
  }

  private put(value: unknown, previous?: unknown): boolean {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).id !== 'string'
    )
      return false;
    const item = JSON.parse(JSON.stringify(value)) as Record<string, any>;
    if (Array.isArray(item.content))
      for (const part of item.content) {
        if (part && typeof part === 'object') delete part.audio;
      }
    const id = item.id as string;
    if (!this.items.has(id) && this.items.size >= this.maxItems)
      throw new Error('Voice conversation history item capacity exceeded');
    const bytes = utf8Bytes(JSON.stringify(item));
    const total = this.bytes - (this.itemBytes.get(id) ?? 0) + bytes;
    if (total > this.maxBytes)
      throw new Error('Voice conversation history byte capacity exceeded');
    this.bytes = total;
    this.itemBytes.set(id, bytes);
    this.items.set(id, item);
    if (
      previous === null ||
      (typeof previous === 'string' && this.items.has(previous))
    ) {
      const entries = [...this.items].filter(([key]) => key !== id);
      const index =
        previous === null
          ? 0
          : entries.findIndex(([key]) => key === previous) + 1;
      entries.splice(index, 0, [id, item]);
      this.items.clear();
      for (const [key, row] of entries) this.items.set(key, row);
    }
    return true;
  }

  private dropAudio(itemId: string): void {
    for (const [key, retained] of this.audio)
      if (retained.itemId === itemId) {
        this.audioBytes -= retained.bytes;
        this.audioChunks -= retained.chunks.length;
        this.audio.delete(key);
      }
  }
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
