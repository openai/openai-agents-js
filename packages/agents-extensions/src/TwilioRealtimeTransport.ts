import {
  OpenAIRealtimeWebSocket,
  OpenAIRealtimeWebSocketOptions,
  utils,
  RealtimeTransportLayerConnectOptions,
  TransportLayerAudio,
  RealtimeSessionConfig,
} from '@openai/agents/realtime';
import { getLogger } from '@openai/agents';
import type {
  WebSocket as NodeWebSocket,
  MessageEvent as NodeMessageEvent,
  ErrorEvent as NodeErrorEvent,
} from 'ws';

import type { ErrorEvent } from 'undici-types';

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
  #audioChunkCount: number = 0;
  #lastPlayedChunkCount: number = 0;
  #previousItemId: string | null = null;
  #pendingPlaybackItemId: string | null = null;
  #shouldClearOnInterrupt: boolean = true;
  #logger = getLogger('openai-agents:extensions:twilio');

  constructor(options: TwilioRealtimeTransportLayerOptions) {
    super(options);
    this.#twilioWebSocket = options.twilioWebSocket;
  }

  _setInputAndOutputAudioFormat(
    partialConfig?: Partial<RealtimeSessionConfig>,
  ): Partial<RealtimeSessionConfig> {
    if (!partialConfig) {
      const newConfig: Partial<RealtimeSessionConfig> = {};
      // @ts-expect-error - this is a valid config
      newConfig.inputAudioFormat = 'g711_ulaw';
      // @ts-expect-error - this is a valid config
      newConfig.outputAudioFormat = 'g711_ulaw';
      return newConfig;
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

    return {
      ...partialConfig,
      // @ts-expect-error - this is a valid config
      inputAudioFormat: partialConfig.inputAudioFormat ?? 'g711_ulaw',
      // @ts-expect-error - this is a valid config
      outputAudioFormat: partialConfig.outputAudioFormat ?? 'g711_ulaw',
    };
  }

  async connect(options: RealtimeTransportLayerConnectOptions) {
    options.initialSessionConfig = this._setInputAndOutputAudioFormat(
      options.initialSessionConfig,
    );
    // listen to Twilio messages as quickly as possible
    this.#twilioWebSocket.addEventListener(
      'message',
      (message: MessageEvent | NodeMessageEvent) => {
        try {
          const data = JSON.parse(message.data.toString());
          if (this.#logger.dontLogModelData) {
            this.#logger.debug('Twilio message:', data.event);
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
              if (
                !data.mark.name.startsWith('done:') &&
                data.mark.name.includes(':')
              ) {
                // keeping track of what the last chunk was that the user heard fully
                const count = Number(data.mark.name.split(':')[1]);
                if (Number.isFinite(count)) {
                  this.#lastPlayedChunkCount = count;
                } else {
                  this.#logger.warn(
                    'Invalid mark name received:',
                    data.mark.name,
                  );
                }
              } else if (data.mark.name.startsWith('done:')) {
                const itemId = data.mark.name.slice('done:'.length);
                if (itemId === this.#pendingPlaybackItemId) {
                  this.#pendingPlaybackItemId = null;
                  if (itemId === this.currentItemId) {
                    this.#audioChunkCount = 0;
                    this.#lastPlayedChunkCount = 0;
                    this.#previousItemId = null;
                    super._afterAudioDoneEvent();
                  }
                }
              }
              break;
            case 'start':
              this.#streamSid = data.start.streamSid;
              this.#audioChunkCount = 0;
              this.#lastPlayedChunkCount = 0;
              this.#previousItemId = null;
              this.#pendingPlaybackItemId = null;
              break;
            default:
              break;
          }
        } catch (error) {
          this.#logger.error(
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
    this.on('audio_done', () => {
      const itemId = this.currentItemId;
      if (this.#streamSid == null || itemId == null) {
        this.#pendingPlaybackItemId = null;
        return;
      }
      this.#pendingPlaybackItemId = itemId;
      this.#twilioWebSocket.send(
        JSON.stringify({
          event: 'mark',
          mark: {
            name: `done:${itemId}`,
          },
          streamSid: this.#streamSid,
        }),
      );
    });
    await super.connect(options);
  }

  protected override _afterAudioDoneEvent() {
    // OpenAI can finish streaming before Twilio has played its buffered audio.
    // Retain the base transport's item and timing state until Twilio acknowledges
    // the matching done mark so a later interrupt can still truncate unheard audio.
    if (this.#pendingPlaybackItemId === this.currentItemId) {
      return;
    }
    super._afterAudioDoneEvent();
  }

  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void {
    const newConfig = this._setInputAndOutputAudioFormat(config);
    super.updateSessionConfig(newConfig);
  }

  #clearTwilioAudio() {
    if (this.#streamSid == null) {
      this.#logger.debug('Skipping Twilio clear before streamSid is set');
      return;
    }
    this.#logger.debug('Clearing Twilio audio');
    this.#twilioWebSocket.send(
      JSON.stringify({
        event: 'clear',
        streamSid: this.#streamSid,
      }),
    );
  }

  interrupt(cancelOngoingResponse: boolean = true) {
    // Twilio may still be playing buffered audio after the OpenAI response has
    // finished streaming. Clear Twilio playback first, then let the retained
    // base transport state truncate any audio the caller did not hear.
    this.#clearTwilioAudio();
    // Avoid sending a duplicate Twilio `clear` when super.interrupt() calls
    // this transport's overridden _interrupt().
    this.#shouldClearOnInterrupt = false;
    try {
      super.interrupt(cancelOngoingResponse);
    } finally {
      this.#shouldClearOnInterrupt = true;
      this.#pendingPlaybackItemId = null;
      this.#audioChunkCount = 0;
      this.#lastPlayedChunkCount = 0;
      this.#previousItemId = null;
    }
  }

  _interrupt(_elapsedTime: number, cancelOngoingResponse: boolean = true) {
    const elapsedTime = this.#lastPlayedChunkCount + 50; /* 50ms buffer */
    this.#logger.debug(
      `Interruption detected, truncating OpenAI audio after ${elapsedTime}ms`,
    );
    if (this.#shouldClearOnInterrupt) {
      this.#clearTwilioAudio();
    }
    super._interrupt(elapsedTime, cancelOngoingResponse);
  }

  protected _onAudio(audioEvent: TransportLayerAudio) {
    this.#logger.debug(
      `Sending audio to Twilio ${audioEvent.responseId}: (${audioEvent.data.byteLength} bytes)`,
    );
    const audioDelta = {
      event: 'media',
      streamSid: this.#streamSid,
      media: {
        payload: utils.arrayBufferToBase64(audioEvent.data),
      },
    };
    if (this.#previousItemId !== this.currentItemId && this.currentItemId) {
      this.#previousItemId = this.currentItemId;
      this.#audioChunkCount = 0;
    }
    this.#audioChunkCount += audioEvent.data.byteLength / 8;
    this.#twilioWebSocket.send(JSON.stringify(audioDelta));
    this.#twilioWebSocket.send(
      JSON.stringify({
        event: 'mark',
        streamSid: this.#streamSid,
        mark: {
          name: `${this.currentItemId}:${this.#audioChunkCount}`,
        },
      }),
    );
    this.emit('audio', audioEvent);
  }
}
