import {
  OpenAIRealtimeWebSocket,
  OpenAIRealtimeWebSocketOptions,
  utils,
  RealtimeTransportLayerConnectOptions,
  TransportLayerAudio,
  RealtimeSessionConfig,
} from '@openai/agents/realtime';
import { getLogger } from '@openai/agents';
import { logModelActionError } from '@openai/agents-core/utils/internal';
import type {
  WebSocket as NodeWebSocket,
  MessageEvent as NodeMessageEvent,
  ErrorEvent as NodeErrorEvent,
} from 'ws';

import type { ErrorEvent } from 'undici-types';

type LegacyRealtimeAudioConfig = Partial<RealtimeSessionConfig> & {
  inputAudioFormat?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  outputAudioFormat?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
};

type TwilioPlaybackItem = {
  itemId: string;
  contentIndex: number;
  sentDurationMs: number;
  playedDurationMs: number;
  doneMarkSent: boolean;
};

type TwilioPlaybackMark = {
  item: TwilioPlaybackItem;
  audioEndMs: number;
  kind: 'audio' | 'done';
};

type TwilioTruncationSnapshot = {
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
};

function withTwilioLegacyAudioDefaults(
  config: LegacyRealtimeAudioConfig = {},
): Partial<RealtimeSessionConfig> {
  return {
    ...config,
    inputAudioFormat: config.inputAudioFormat ?? 'g711_ulaw',
    outputAudioFormat: config.outputAudioFormat ?? 'g711_ulaw',
  } as Partial<RealtimeSessionConfig>;
}

/**
 * The options for the Twilio Realtime Transport Layer.
 */
export type TwilioRealtimeTransportLayerOptions =
  OpenAIRealtimeWebSocketOptions & {
    /**
     * The websocket that is receiving messages from Twilio's Media Streams API. Typically the
     * connection gets passed into your request handler when running your WebSocket server.
     */
    twilioWebSocket: WebSocket | NodeWebSocket;
  };

/**
 * An adapter to connect a websocket that is receiving messages from Twilio's Media Streams API to
 * the OpenAI Realtime API via WebSocket.
 *
 * It automatically handles setting the right audio format for the input and output audio, passing
 * the data along and handling the timing for interruptions using Twilio's `mark` events.
 *
 * It does require you to run your own WebSocket server that is receiving connection requests from
 * Twilio.
 *
 * It will emit all Twilio received messages as `twilio_message` type messages on the `*` handler.
 * If you are using a `RealtimeSession` you can listen to the `transport_event`.
 *
 * @example
 * ```ts
 * const transport = new TwilioRealtimeTransportLayer({
 *   twilioWebSocket: twilioWebSocket,
 * });
 *
 * transport.on('*', (event) => {
 *   if (event.type === 'twilio_message') {
 *     console.log('Twilio message:', event.data);
 *   }
 * });
 * ```
 */
export class TwilioRealtimeTransportLayer extends OpenAIRealtimeWebSocket {
  #twilioWebSocket: WebSocket | NodeWebSocket;
  #streamSid: string | null = null;
  #playbackGeneration: number = 0;
  #markSequence: number = 0;
  #playbackItems: TwilioPlaybackItem[] = [];
  #pendingMarks = new Map<string, TwilioPlaybackMark>();
  #clearedMarkNames = new Set<string>();
  #discardedItemIds = new Set<string>();
  #nextAudioMetadata: { itemId: string; contentIndex: number } | null = null;
  #logger = getLogger('openai-agents:extensions:twilio');

  constructor(options: TwilioRealtimeTransportLayerOptions) {
    super(options);
    this.#twilioWebSocket = options.twilioWebSocket;
    this.#registerEventListeners();
  }

  _setInputAndOutputAudioFormat(
    partialConfig?: Partial<RealtimeSessionConfig>,
  ): Partial<RealtimeSessionConfig> {
    if (!partialConfig) {
      return withTwilioLegacyAudioDefaults();
    }

    const audioConfig = 'audio' in partialConfig ? partialConfig.audio : null;
    if (audioConfig) {
      return {
        ...partialConfig,
        audio: {
          ...audioConfig,
          input: {
            ...audioConfig.input,
            format: audioConfig.input?.format ?? 'g711_ulaw',
          },
          output: {
            ...audioConfig.output,
            format: audioConfig.output?.format ?? 'g711_ulaw',
          },
        },
      };
    }

    return withTwilioLegacyAudioDefaults(
      partialConfig as LegacyRealtimeAudioConfig,
    );
  }

  async connect(options: RealtimeTransportLayerConnectOptions) {
    options.initialSessionConfig = this._setInputAndOutputAudioFormat(
      options.initialSessionConfig,
    );
    await super.connect(options);
  }

  #registerEventListeners() {
    this.#twilioWebSocket.addEventListener(
      'message',
      (message: MessageEvent | NodeMessageEvent) => {
        try {
          const data = JSON.parse(message.data.toString());
          if (this.#logger.dontLogModelData) {
            this.#logger.debug(
              'Twilio message received. Message data is redacted.',
            );
          } else {
            this.#logger.debug('Twilio message:', data);
          }
          this.emit('*', {
            type: 'twilio_message',
            message: data,
          });
          switch (data.event) {
            case 'media':
              if (this.status === 'connected') {
                this.sendAudio(utils.base64ToArrayBuffer(data.media.payload));
              }
              break;
            case 'mark':
              this.#handleTwilioMark(data.mark?.name);
              break;
            case 'start':
              this.#streamSid = data.start.streamSid;
              this.#startPlaybackGeneration();
              break;
            default:
              break;
          }
        } catch (error) {
          logModelActionError(
            this.#logger,
            'Error parsing message:',
            error,
            'Message:',
            message,
          );
          this.emit('error', {
            type: 'error',
            error,
          });
        }
      },
    );
    this.#twilioWebSocket.addEventListener('close', () => {
      if (this.status !== 'disconnected') {
        this.close();
      }
    });
    this.#twilioWebSocket.addEventListener(
      'error',
      (error: ErrorEvent | NodeErrorEvent) => {
        this.emit('error', {
          type: 'error',
          error,
        });
        this.close();
      },
    );
    this.on('response.output_audio.done', (event) => {
      this.#sendDoneMark(event.item_id, event.content_index);
    });
    this.on('response.output_audio.delta', (event) => {
      this.#nextAudioMetadata = {
        itemId: event.item_id,
        contentIndex: event.content_index,
      };
    });
  }

  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void {
    const newConfig = this._setInputAndOutputAudioFormat(config);
    super.updateSessionConfig(newConfig);
  }

  protected override _onClose() {
    this.#clearPlaybackGeneration();
    this.#discardedItemIds.clear();
    super._onClose();
  }

  #startPlaybackGeneration() {
    this.#playbackGeneration += 1;
    this.#markSequence = 0;
    this.#playbackItems = [];
    this.#pendingMarks.clear();
    this.#clearedMarkNames.clear();
    this.#discardedItemIds.clear();
    this.#nextAudioMetadata = null;
  }

  #clearPlaybackGeneration() {
    this.#playbackGeneration += 1;
    for (const markName of this.#pendingMarks.keys()) {
      this.#clearedMarkNames.add(markName);
    }
    this.#playbackItems = [];
    this.#pendingMarks.clear();
    this.#nextAudioMetadata = null;
  }

  #findPlaybackItem(itemId: string, contentIndex: number) {
    return this.#playbackItems.find(
      (item) => item.itemId === itemId && item.contentIndex === contentIndex,
    );
  }

  #getOrCreatePlaybackItem(itemId: string, contentIndex: number) {
    const existing = this.#findPlaybackItem(itemId, contentIndex);
    if (existing) {
      return existing;
    }

    const item: TwilioPlaybackItem = {
      itemId,
      contentIndex,
      sentDurationMs: 0,
      playedDurationMs: 0,
      doneMarkSent: false,
    };
    this.#playbackItems.push(item);
    return item;
  }

  #createMarkName(item: TwilioPlaybackItem, kind: 'audio' | 'done') {
    this.#markSequence += 1;
    const suffix = `g${this.#playbackGeneration}:m${this.#markSequence}`;
    if (kind === 'done') {
      return `done:${item.itemId}:${suffix}`;
    }
    return `${item.itemId}:${Math.floor(item.sentDurationMs)}:${suffix}`;
  }

  #sendMark(item: TwilioPlaybackItem, kind: 'audio' | 'done') {
    if (this.#streamSid == null) {
      return;
    }

    const name = this.#createMarkName(item, kind);
    this.#pendingMarks.set(name, {
      item,
      audioEndMs: item.sentDurationMs,
      kind,
    });
    this.#twilioWebSocket.send(
      JSON.stringify({
        event: 'mark',
        streamSid: this.#streamSid,
        mark: { name },
      }),
    );
  }

  #sendDoneMark(itemId: string, contentIndex: number) {
    const item = this.#findPlaybackItem(itemId, contentIndex);
    if (!item || item.doneMarkSent) {
      return;
    }
    item.doneMarkSent = true;
    this.#sendMark(item, 'done');
  }

  #warnUnknownMark(markName: unknown) {
    if (this.#logger.dontLogModelData) {
      this.#logger.warn('Invalid mark name received. Mark data is redacted.');
    } else {
      this.#logger.warn('Invalid mark name received:', markName);
    }
  }

  #handleTwilioMark(markName: unknown) {
    if (typeof markName !== 'string') {
      this.#warnUnknownMark(markName);
      return;
    }
    if (this.#clearedMarkNames.delete(markName)) {
      return;
    }

    const mark = this.#pendingMarks.get(markName);
    if (!mark) {
      this.#warnUnknownMark(markName);
      return;
    }
    this.#pendingMarks.delete(markName);
    if (!this.#playbackItems.includes(mark.item)) {
      return;
    }
    if (mark.kind === 'audio') {
      mark.item.playedDurationMs = Math.max(
        mark.item.playedDurationMs,
        mark.audioEndMs,
      );
      return;
    }

    this.#playbackItems = this.#playbackItems.filter(
      (candidate) => candidate !== mark.item,
    );
  }

  #createTruncationSnapshots(): TwilioTruncationSnapshot[] {
    return this.#playbackItems.map((item, index) => {
      const audioEndMs =
        index === 0 || item.playedDurationMs > 0
          ? Math.min(item.sentDurationMs, item.playedDurationMs + 50)
          : 0;
      return {
        itemId: item.itemId,
        contentIndex: item.contentIndex,
        audioEndMs: Math.max(0, Math.floor(audioEndMs)),
      };
    });
  }

  #clearTwilioAudio() {
    if (this.#streamSid == null) {
      this.#logger.debug('Skipping Twilio clear before streamSid is set.');
      return;
    }
    this.#logger.debug('Clearing Twilio audio.');
    this.#twilioWebSocket.send(
      JSON.stringify({
        event: 'clear',
        streamSid: this.#streamSid,
      }),
    );
  }

  #interruptPlayback(cancelOngoingResponse: boolean) {
    if (this.status !== 'connected') {
      return;
    }
    const truncations = this.#createTruncationSnapshots();
    for (const item of this.#playbackItems) {
      this.#discardedItemIds.add(item.itemId);
    }
    this.#clearPlaybackGeneration();

    try {
      this.#clearTwilioAudio();
      if (cancelOngoingResponse) {
        this._cancelResponse();
      }
      if (truncations.length === 0) {
        return;
      }

      this.emit('audio_interrupted');
      for (const truncation of truncations) {
        if (this.#logger.dontLogModelData) {
          this.#logger.debug('Truncating OpenAI item. Item data is redacted.');
        } else {
          this.#logger.debug(
            `Truncating OpenAI item ${truncation.itemId} after ${truncation.audioEndMs}ms.`,
          );
        }
        this.sendEvent({
          type: 'conversation.item.truncate',
          item_id: truncation.itemId,
          content_index: truncation.contentIndex,
          audio_end_ms: truncation.audioEndMs,
        });
      }
    } finally {
      super._afterAudioDoneEvent();
    }
  }

  interrupt(cancelOngoingResponse: boolean = true) {
    this.#interruptPlayback(cancelOngoingResponse);
  }

  _interrupt(_elapsedTime: number, cancelOngoingResponse: boolean = true) {
    this.#interruptPlayback(cancelOngoingResponse);
  }

  protected _onAudio(audioEvent: TransportLayerAudio) {
    this.#logger.debug(
      `Sending audio to Twilio ${audioEvent.responseId}: (${audioEvent.data.byteLength} bytes)`,
    );
    const itemId = this.currentItemId;
    if (itemId == null) {
      this.#logger.warn('Skipping Twilio audio without an item ID.');
      this.emit('audio', audioEvent);
      return;
    }
    if (this.#discardedItemIds.has(itemId)) {
      this.emit('audio', audioEvent);
      return;
    }

    const contentIndex =
      this.#nextAudioMetadata?.itemId === itemId
        ? this.#nextAudioMetadata.contentIndex
        : 0;
    this.#nextAudioMetadata = null;
    const item = this.#getOrCreatePlaybackItem(itemId, contentIndex);
    item.sentDurationMs += audioEvent.data.byteLength / 8;

    const audioDelta = {
      event: 'media',
      streamSid: this.#streamSid,
      media: {
        payload: utils.arrayBufferToBase64(audioEvent.data),
      },
    };
    this.#twilioWebSocket.send(JSON.stringify(audioDelta));
    this.#sendMark(item, 'audio');
    this.emit('audio', audioEvent);
  }
}
