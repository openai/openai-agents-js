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
  responseId: string;
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

const TWILIO_MULAW_BYTES_PER_MILLISECOND = 8;
const TWILIO_MULAW_SILENCE_BYTE = 0xff;
const MAX_TWILIO_SILENCE_PADDING_MS = 10_000;
const DEFAULT_TWILIO_INPUT_INACTIVITY_TIMEOUT_MS = 750;
const TWILIO_INPUT_INACTIVITY_SILENCE_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function parseTwilioMediaTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

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
    /**
     * How long to wait for more Twilio input media while speech is active before padding the
     * missing input with silence. Defaults to 750ms. The maximum supported value is 2,147,483,647ms.
     * Set to `null` to disable inactivity padding.
     */
    inputAudioInactivityTimeoutMs?: number | null;
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
  #activeResponseId: string | null = null;
  #discardedResponseIds = new Set<string>();
  #nextInputTimestampMs: number | null = null;
  #lastInputMediaAtMs: number | null = null;
  #inputSpeechActive = false;
  #inputGapAlreadyPadded = false;
  #canPadInputAudio = false;
  #inputInactivityTimer: ReturnType<typeof setTimeout> | null = null;
  #inputAudioInactivityTimeoutMs: number | null;
  #nextAudioMetadata: {
    responseId: string;
    itemId: string;
    contentIndex: number;
  } | null = null;
  #logger = getLogger('openai-agents:extensions:twilio');

  constructor(options: TwilioRealtimeTransportLayerOptions) {
    super(options);
    const inputAudioInactivityTimeoutMs =
      options.inputAudioInactivityTimeoutMs === undefined
        ? DEFAULT_TWILIO_INPUT_INACTIVITY_TIMEOUT_MS
        : options.inputAudioInactivityTimeoutMs;
    if (
      inputAudioInactivityTimeoutMs !== null &&
      (!Number.isFinite(inputAudioInactivityTimeoutMs) ||
        inputAudioInactivityTimeoutMs <= 0 ||
        inputAudioInactivityTimeoutMs > MAX_TIMER_DELAY_MS)
    ) {
      throw new RangeError(
        `inputAudioInactivityTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}, or null.`,
      );
    }
    this.#inputAudioInactivityTimeoutMs = inputAudioInactivityTimeoutMs;
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
    if (this.status === 'disconnected') {
      this.#resetInputTiming();
    }
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
                this.#sendTwilioAudio(data.media);
              }
              break;
            case 'mark':
              this.#handleTwilioMark(data.mark?.name);
              break;
            case 'start':
              this.#streamSid = data.start.streamSid;
              this.#resetInputTiming();
              this.#canPadInputAudio =
                data.start.mediaFormat?.encoding === 'audio/x-mulaw' &&
                data.start.mediaFormat?.sampleRate === 8_000 &&
                data.start.mediaFormat?.channels === 1;
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
      this.#resetTwilioStream();
      if (this.status !== 'disconnected') {
        this.close();
      }
    });
    this.#twilioWebSocket.addEventListener(
      'error',
      (error: ErrorEvent | NodeErrorEvent) => {
        this.#resetTwilioStream();
        this.emit('error', {
          type: 'error',
          error,
        });
        this.close();
      },
    );
    this.on('response.output_audio.done', (event) => {
      this.#sendDoneMark(event.response_id, event.item_id, event.content_index);
    });
    this.on('response.output_audio.delta', (event) => {
      this.#nextAudioMetadata = {
        responseId: event.response_id,
        itemId: event.item_id,
        contentIndex: event.content_index,
      };
    });
    this.on('response.created', (event) => {
      if (typeof event.response.id === 'string') {
        this.#activeResponseId = event.response.id;
      }
    });
    this.on('response.done', (event) => {
      const responseId = event.response.id;
      if (typeof responseId !== 'string') {
        return;
      }
      this.#discardedResponseIds.delete(responseId);
      if (this.#activeResponseId === responseId) {
        this.#activeResponseId = null;
      }
    });
    this.on('input_audio_buffer.speech_started', () => {
      this.#inputSpeechActive = true;
      this.#scheduleInputInactivityPadding();
    });
    this.on('input_audio_buffer.speech_stopped', () => {
      this.#inputSpeechActive = false;
      this.#clearInputInactivityTimer();
    });
  }

  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void {
    const newConfig = this._setInputAndOutputAudioFormat(config);
    super.updateSessionConfig(newConfig);
  }

  protected override _onClose() {
    this.#clearPlaybackGeneration();
    this.#activeResponseId = null;
    this.#discardedResponseIds.clear();
    this.#resetInputTiming();
    super._onClose();
  }

  #sendTwilioAudio(media: { payload: string; timestamp?: unknown }) {
    this.#clearInputInactivityTimer();
    const audio = utils.base64ToArrayBuffer(media.payload);
    const timestamp = this.#canPadInputAudio
      ? parseTwilioMediaTimestamp(media.timestamp)
      : null;
    if (!this.#canPadInputAudio || timestamp === null) {
      this.#nextInputTimestampMs = null;
    } else if (
      this.#nextInputTimestampMs !== null &&
      timestamp < this.#nextInputTimestampMs
    ) {
      this.#nextInputTimestampMs = null;
    } else {
      if (
        !this.#inputGapAlreadyPadded &&
        this.#nextInputTimestampMs !== null &&
        timestamp > this.#nextInputTimestampMs
      ) {
        const missingDurationMs = Math.floor(
          timestamp - this.#nextInputTimestampMs,
        );
        const paddingDurationMs = Math.min(
          missingDurationMs,
          MAX_TWILIO_SILENCE_PADDING_MS,
        );
        this.#logger.debug(
          `Padding ${paddingDurationMs}ms of missing Twilio input audio with silence.`,
        );
        this.#sendInputSilence(paddingDurationMs);
      }
      this.#nextInputTimestampMs =
        timestamp + audio.byteLength / TWILIO_MULAW_BYTES_PER_MILLISECOND;
    }
    this.#inputGapAlreadyPadded = false;
    this.sendAudio(audio);
    this.#lastInputMediaAtMs = Date.now();
    this.#scheduleInputInactivityPadding();
  }

  #sendInputSilence(durationMs: number) {
    const silence = new Uint8Array(
      durationMs * TWILIO_MULAW_BYTES_PER_MILLISECOND,
    );
    silence.fill(TWILIO_MULAW_SILENCE_BYTE);
    this.sendAudio(silence.buffer);
  }

  #scheduleInputInactivityPadding() {
    this.#clearInputInactivityTimer();
    if (
      this.#inputAudioInactivityTimeoutMs === null ||
      !this.#canPadInputAudio ||
      !this.#inputSpeechActive ||
      this.#lastInputMediaAtMs === null
    ) {
      return;
    }
    const delayMs = Math.max(
      0,
      this.#inputAudioInactivityTimeoutMs -
        (Date.now() - this.#lastInputMediaAtMs),
    );
    const timer = setTimeout(() => {
      if (this.#inputInactivityTimer !== timer) {
        return;
      }
      this.#inputInactivityTimer = null;
      if (this.status !== 'connected' || !this.#inputSpeechActive) {
        return;
      }
      this.#logger.debug(
        `Padding ${TWILIO_INPUT_INACTIVITY_SILENCE_MS}ms of inactive Twilio input audio with silence.`,
      );
      this.#sendInputSilence(TWILIO_INPUT_INACTIVITY_SILENCE_MS);
      this.#inputGapAlreadyPadded = true;
    }, delayMs);
    this.#inputInactivityTimer = timer;
    (timer as { unref?: () => void }).unref?.();
  }

  #clearInputInactivityTimer() {
    if (this.#inputInactivityTimer !== null) {
      clearTimeout(this.#inputInactivityTimer);
      this.#inputInactivityTimer = null;
    }
  }

  #resetInputTiming() {
    this.#clearInputInactivityTimer();
    this.#nextInputTimestampMs = null;
    this.#lastInputMediaAtMs = null;
    this.#inputSpeechActive = false;
    this.#inputGapAlreadyPadded = false;
  }

  #resetTwilioStream() {
    this.#resetInputTiming();
    this.#canPadInputAudio = false;
  }

  #startPlaybackGeneration() {
    this.#playbackGeneration += 1;
    this.#markSequence = 0;
    this.#playbackItems = [];
    this.#pendingMarks.clear();
    this.#clearedMarkNames.clear();
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

  #findPlaybackItem(responseId: string, itemId: string, contentIndex: number) {
    return this.#playbackItems.find(
      (item) =>
        item.responseId === responseId &&
        item.itemId === itemId &&
        item.contentIndex === contentIndex,
    );
  }

  #getOrCreatePlaybackItem(
    responseId: string,
    itemId: string,
    contentIndex: number,
  ) {
    const existing = this.#findPlaybackItem(responseId, itemId, contentIndex);
    if (existing) {
      return existing;
    }

    const item: TwilioPlaybackItem = {
      responseId,
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

  #sendDoneMark(responseId: string, itemId: string, contentIndex: number) {
    const item = this.#findPlaybackItem(responseId, itemId, contentIndex);
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
    if (this.#activeResponseId === null && this.#playbackItems.length === 0) {
      return;
    }
    const activeResponseId = this.#activeResponseId;
    this.#activeResponseId = null;
    const truncations = this.#createTruncationSnapshots();
    if (activeResponseId !== null) {
      this.#discardedResponseIds.add(activeResponseId);
    }
    for (const item of this.#playbackItems) {
      this.#discardedResponseIds.add(item.responseId);
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
    const metadata = this.#nextAudioMetadata;
    this.#nextAudioMetadata = null;
    if (this.#discardedResponseIds.has(audioEvent.responseId)) {
      return;
    }

    const itemId = this.currentItemId;
    if (itemId == null) {
      this.#logger.warn('Skipping Twilio audio without an item ID.');
      this.emit('audio', audioEvent);
      return;
    }
    const contentIndex =
      metadata?.responseId === audioEvent.responseId &&
      metadata.itemId === itemId
        ? metadata.contentIndex
        : 0;
    const item = this.#getOrCreatePlaybackItem(
      audioEvent.responseId,
      itemId,
      contentIndex,
    );
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
